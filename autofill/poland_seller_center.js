// ============================================================================
// 波兰卖家中心 - 自动填充计划生成器（积木）
// ============================================================================
// 输入：modulesData（已构建好的字段值）+ foundFiles（识别到的文件）+ aiData
//       （AI 原始字段，用于姓拼音/名拼音 fallback）+ utils（地址拆分 / PDF 转换等通用工具）
// 输出：plan 数组，由通用引擎 pageExecutePlan 逐项执行（type 决定使用 handleText /
//       handleSelect / handleRadio / handleCascader / handleDatepicker /
//       handleBusinessTerm / handleFile 中的哪一个）。
//
// 加新销售目的地（如 france_seller_center.js）时复制本文件改 plan 内容即可，
// 不需要改 popup.js。新文件务必在 popup.js 顶部 AUTOFILL_REGISTRY 里登记一行：
//   france_seller_center: () => import('./autofill/france_seller_center.js'),
// ============================================================================

export default {
  id: "poland_seller_center",

  /**
   * @param {Object} input
   * @param {Array}  input.modulesData  - lastModulesData，已经按 requirements.json 的 modules 构建
   * @param {Array}  input.foundFiles   - lastValidationResult.found，含 key / label / file / imageData
   * @param {Object} input.aiData       - { license, idCardFront, idCardBack } AI 原始字段
   * @param {Object} input.utils        - 通用工具集合（见下方解构）
   * @returns {Promise<Array>} plan
   */
  async buildPlan({ modulesData, foundFiles, aiData, utils }) {
    const {
      splitAddressIntoRegionAndDetail,
      imageFileToPdfBlob,
      buildSinglePagePdfFromJpeg,
      fileToBase64Plain,
    } = utils;

    // ---- 数据访问 helpers ----
    const moduleData = (modulesData || []).find((m) => m.title === "公司信息");
    const fields = moduleData?.fields || [];
    const get = (key) => (fields.find((f) => f.key === key)?.value || "").trim();
    const findFile = (k) => (foundFiles || []).find((f) => f.key === k);

    // ---- 文件查找 ----
    const license = findFile("business_license");
    const taxRes = findFile("tax_certificate");

    // ---- 文件 → 上传 payload 转换 ----
    async function fileToPayload(found, opts = {}) {
      if (!found || !(found.file && found.file.file instanceof File)) return null;
      const f = found.file.file;
      // keepImage：上传框接受图片（如 店铺后台截图 要求 JPG/JPEG/PNG），不要把图片转成 PDF。
      if (opts.keepImage) {
        const lowerType = (f.type || "").toLowerCase();
        const lowerName = (f.name || "").toLowerCase();
        const isImg = lowerType.startsWith("image/")
          || /\.(png|jpe?g|gif|webp|bmp)$/i.test(lowerName);
        if (isImg) {
          const base64 = await fileToBase64Plain(f);
          const fileType = f.type || (lowerName.endsWith(".png") ? "image/png" : "image/jpeg");
          return { name: f.name, fileType, base64, converted: false };
        }
        // 非图片文件（极少见）走默认 PDF 逻辑作为兜底
      }
      // 多页 PDF（如身份证正反面合一）需要按检测到的页码拆分上传：
      // detectFiles 在 path 末尾追加了 " (第N页)"，且 imageData 已经是该页的 JPEG base64。
      const pageMatch = (found.file.path || "").match(/\(第(\d+)页\)/);
      if (pageMatch && found.imageData) {
        // 把单页 JPEG 包装成单页 PDF
        const dataUrl = `data:${found.mimeType || "image/jpeg"};base64,${found.imageData}`;
        const img = await new Promise((resolve, reject) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = () => reject(new Error("PDF 单页解码失败"));
          im.src = dataUrl;
        });
        const W = img.naturalWidth || img.width;
        const H = img.naturalHeight || img.height;
        if (!W || !H) throw new Error("PDF 单页尺寸读取失败");
        const bin = atob(found.imageData);
        const jpegBytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) jpegBytes[i] = bin.charCodeAt(i);
        const pdfBytes = buildSinglePagePdfFromJpeg(jpegBytes, W, H);
        const baseName = (f.name || "page").replace(/\.[^.\\/]+$/, "");
        const blob = new Blob([pdfBytes], { type: "application/pdf" });
        const base64 = await fileToBase64Plain(blob);
        return {
          name: `${baseName}_p${pageMatch[1]}.pdf`,
          fileType: "application/pdf",
          base64,
          converted: true,
        };
      }
      // 上传框 accept=".pdf"：图片必须先转 PDF；本身已是 PDF 则原样上传
      const { blob, name, converted } = await imageFileToPdfBlob(f);
      const base64 = await fileToBase64Plain(blob);
      return { name, fileType: "application/pdf", base64, converted };
    }

    const licensePayload = await fileToPayload(license);
    const taxPayload = await fileToPayload(taxRes);
    // 店铺后台截图：要求 JPG/JPEG/PNG 直接上传，不能像营业执照那样转 PDF
    const shopScreenshot = findFile("shop_backend_screenshot");
    const shopScreenshotPayload = await fileToPayload(shopScreenshot, { keepImage: true });

    // 公司/个体经营注册地址(中文) 表单含 cascader(省市区) + textarea(详细地址)
    // AI 提取的"住所"是完整地址，需要拆分成两段分别填入。
    const regAddrSplit = splitAddressIntoRegionAndDetail(get("公司/个体经营注册地址(中文)"));

    // ============== 法人代表信息（来自 modulesData["法人代表信息"] + foundFiles + aiData） ==============
    const repModule = (modulesData || []).find((m) => m.title === "法人代表信息");
    const repFields = repModule?.fields || [];
    const getRep = (key) => (repFields.find((f) => f.key === key)?.value || "").trim();

    const idFront = findFile("id_card_front");
    const idBack = findFile("id_card_back");
    const idFrontPayload = await fileToPayload(idFront);
    const idBackPayload = await fileToPayload(idBack);

    // 拼音姓 / 拼音名：优先用 AI 直接给的两段，缺失时按"首字母大写音节"拆分（仅保 1+rest 拆分，复姓识别交给 AI）
    const aiFront = aiData?.idCardFront || {};
    const fullPinyin = (aiFront.拼音名 || "").trim();
    let surnamePinyin = (aiFront.姓拼音 || "").trim();
    let givenNamePinyin = (aiFront.名拼音 || "").trim();
    if ((!surnamePinyin || !givenNamePinyin) && fullPinyin) {
      const syllables = fullPinyin.match(/[A-Z][a-z]+/g) || [];
      if (syllables.length >= 2) {
        if (!surnamePinyin) surnamePinyin = syllables[0];
        if (!givenNamePinyin) givenNamePinyin = syllables.slice(1).join("");
      } else if (syllables.length === 1 && !surnamePinyin) {
        surnamePinyin = syllables[0];
      }
    }

    // 法人/个人代表身份证地址：cascader(省市区) + textarea(详细)，与公司注册地址结构一致
    const idAddrSplit = splitAddressIntoRegionAndDetail(getRep("法人/个人代表身份证地址"));

    // ============== 店铺信息（来自 modulesData["店铺信息"]） ==============
    const shopModule = (modulesData || []).find((m) => m.title === "店铺信息");
    const shopFields = shopModule?.fields || [];
    const getShop = (key) => (shopFields.find((f) => f.key === key)?.value || "").trim();

    /** @type {Array<object>} */
    const plan = [
      // ============================ 公司信息 ============================
      // --- 文本字段 ---
      { type: "text", key: "公司名称", placeholder: "请输入公司名称", value: get("公司名称") },
      { type: "text", key: "营业执照号码/注册号", placeholder: "请输入营业执照号码/注册号", value: get("营业执照号码/注册号") },
      // 注册资本去掉末尾的"元"（页面输入框只接受纯数字/金额）
      { type: "text", key: "注册资本", placeholder: "请输入注册资本", value: get("注册资本").replace(/元\s*$/u, "") },
      { type: "text", key: "登记机关所在地税务局名称", placeholder: "请输入登记机关所在地税务局名称", value: get("登记机关所在地税务局名称") },
      { type: "text", key: "登记机关所在地法院名称", placeholder: "请输入登记机关所在地法院名称", value: get("登记机关所在地法院名称") },
      // 邮编：页面 placeholder 是"请输入邮政编码"
      { type: "text", key: "邮编", placeholder: "请输入邮政编码", value: get("邮编") },
      // 注册地址详细（textarea）：xpath 用户提供的绝对路径（最精确），失败时回退到表单项标签查找。
      {
        type: "text",
        key: "公司/个体经营注册地址(中文)-详细",
        xpath: "/html/body/div[2]/div/div[1]/div[1]/div/div[2]/div[1]/div[3]/div/div[1]/div/div[3]/div/div[1]/div[1]/div[1]/form[3]/div/div/div[9]/div/div/div/div/div/div/div/span/div[2]/div/div/textarea",
        labelText: "公司/个体经营注册地址(中文)",
        elementSelector: "textarea",
        value: regAddrSplit.detail,
      },

      // --- 文件上传（field-id 来自用户提供的 HTML，labelFallback 保证 id 变化时仍可定位） ---
      { type: "fileById", key: "营业执照", fieldId: "1784866111212429314", labelFallback: "营业执照", file: licensePayload },
      { type: "fileById", key: "中国税收居民身份证明", fieldId: "1784866111212429317", labelFallback: "中国税收居民身份证明", file: taxPayload },

      // --- 公司类型（ant-select 下拉，按字符相似度自动匹配最接近的页面选项） ---
      { type: "select", key: "公司类型", placeholder: "请选择公司类型", value: get("公司类型") },

      // --- 日期 ---
      { type: "datepicker", key: "公司成立日期", placeholder: "请选择公司成立日期", value: get("公司成立日期") },

      // --- 营业期限：长期 toggle 或日期范围（labelText 用于在多个 .btn_warp 区分） ---
      { type: "businessTerm", key: "营业期限", labelText: "营业期限", value: get("营业期限"), startDate: get("公司成立日期") },

      // --- 级联选择器 ---
      // 营业执照签发机关 cascader 期望省/市/区。我们传入完整的"登记机关"字符串（含省+市+区前缀）
      // 让页面侧按子串匹配各级菜单。
      { type: "cascader", key: "营业执照签发机关", placeholder: "请选择省市区", value: get("营业执照签发机关") },
      // 税务局地址：页面上是第一个 placeholder="请选择所在省/市/区" 的 cascader，
      // 但页面新增了"法院地址 / 注册地址"两个同 placeholder 的 cascader 后必须用 labelText 区分。
      { type: "cascader", key: "登记机关所在地税务局地址", placeholder: "请选择所在省/市/区", labelText: "登记机关所在地税务局地址", value: get("登记机关所在地税务局地址") },
      { type: "cascader", key: "登记机关所在地法院地址", placeholder: "请选择所在省/市/区", labelText: "登记机关所在地法院地址", value: get("登记机关所在地法院地址") },
      { type: "cascader", key: "公司/个体经营注册地址(中文)-省市区", placeholder: "请选择所在省/市/区", labelText: "公司/个体经营注册地址(中文)", value: regAddrSplit.region },

      // ============================ 法人代表信息 ============================
      // 证件类型：默认根据检测到的身份证设为"法人身份证"；护照流程暂未实现
      { type: "radio", key: "证件类型", value: getRep("上传法人代表证件信息") },

      // 文件上传（field-id 来自用户提供的 HTML；labelFallback 用 "（人像面）" / "（国徽面）" 文本兜底定位）
      { type: "fileById", key: "法人代表身份证(人像面)", fieldId: "1784866111229206529", labelFallback: "（人像面）", file: idFrontPayload },
      { type: "fileById", key: "法人代表身份证(国徽面)", fieldId: "1784866111229206531", labelFallback: "（国徽面）", file: idBackPayload },

      // 文本字段
      { type: "text", key: "法人/个人代表中文名", placeholder: "请输入法人/个人代表中文名", value: getRep("法人/个人代表中文名") },
      { type: "text", key: "法人/个人代表身份证号", placeholder: "请输入法人/个人代表身份证号", value: getRep("法人/个人代表身份证号") },
      // 拼音名拆成姓 / 名两段
      { type: "text", key: "法人拼音-姓", placeholder: "姓，如：Zhang", value: surnamePinyin },
      { type: "text", key: "法人拼音-名", placeholder: "名，如：San", value: givenNamePinyin },
      // 身份证地址详细（textarea，省市区之后的部分）
      // 注：早期版本写过 elementSelector: "textarea"，但在没有 labelText 的情况下，
      // popup.js handleText 既不会把它作为 labelText 子过滤器使用（labelText 缺席），
      // 也不会作为独立 querySelector 使用（bare tag 被特定性门拦截）。
      // 单纯依赖 placeholder 就能正确定位（页面只有这一个 textarea 用该 placeholder）。
      { type: "text", key: "法人/个人代表身份证地址-详细", placeholder: "请输入法人身份证上的住址", value: idAddrSplit.detail },

      // 出生日期
      { type: "datepicker", key: "法人/个人代表出生日期", placeholder: "请选择或输入日期（20XX-XX-XX）", value: getRep("法人/个人代表出生日期") },

      // 身份证有效期限（与营业期限同样的 长期 toggle / 日期范围 结构，必须用 labelText 区分）
      { type: "businessTerm", key: "法人代表身份证有效期限", labelText: "法人代表身份证有效期限", value: getRep("法人代表身份证有效期限") },

      // 身份证地址 省市区（cascader，与"请选择所在省/市/区"重名，用 labelText 区分）
      { type: "cascader", key: "法人/个人代表身份证地址-省市区", placeholder: "请选择所在省/市/区", labelText: "法人/个人代表身份证地址", value: idAddrSplit.region },

      // 性别（radio：男 / 女）
      { type: "radio", key: "性别", value: getRep("性别") },

      // 法人国籍（radio：中国籍 / 非中国籍）
      { type: "radio", key: "法人国籍", value: getRep("法人国籍") },

      // 身份证邮政编码（放在法人信息模块最后填写）：根据 AI 提取的住址里的市/区查表得到的 6 位邮编。
      // 该 placeholder 与 公司邮编 重名，必须用 labelText="法人/个人代表身份证地址" 把搜索范围
      // 限定在身份证地址所在的 form-item 子树内，避免回填到 公司邮编 输入框。
      // afterPopup:true —— 必须等 身份证地址 cascader（Phase 2）选完再填，否则 cascader 的
      // change 事件会把同 form-item 内的邮编输入框清空。
      {
        type: "text",
        key: "法人/个人代表身份证邮编",
        labelText: "法人/个人代表身份证地址",
        elementSelector: 'input[placeholder="请输入邮政编码"]',
        placeholder: "请输入邮政编码",
        value: getRep("法人/个人代表身份证邮编"),
        afterPopup: true,
      },

      // ============================ 店铺信息 ============================
      // 销售平台：ant-radio-button-wrapper 形式（速卖通 / 亚马逊 / 其他），值由店铺链接自动推断
      { type: "radio", key: "销售平台", value: getShop("销售平台") },

      // 文本字段
      { type: "text", key: "店铺链接", placeholder: "请输入店铺链接", value: getShop("店铺链接") },
      { type: "text", key: "公司英文名称", placeholder: "请务必填写您亚马逊后台/电商平台后台的公司英文名称", value: getShop("公司英文名称") },
      { type: "text", key: "公司/个体经营注册地址(英文)", placeholder: "请输入与亚马逊后台一致的经营注册地址", value: getShop("公司/个体经营注册地址（英文）") },
      { type: "text", key: "联系邮箱", placeholder: "请输入公司联系人邮箱", value: getShop("联系邮箱") },

      // 经营范围：ant-select 多选，默认值 "电子商品 electrical products"（下拉第一项）
      {
        type: "select",
        key: "公司（个人）店铺主要经营范围",
        placeholder: "请选择公司（个人）店铺主要经营范围",
        value: getShop("公司（个人）店铺主要经营范围"),
      },

      // 店铺后台截图：要求 JPG/JPEG/PNG 直接上传（不转 PDF）。fieldId 待补，
      // 当前用 labelFallback 兜底，handleFile 会通过附近文本节点定位上传框。
      // 若 foundFiles 中没有该项（用户未点击"生成临时占位"且未自行上传），file 为 null，
      // handleFile 会以 "无文件，跳过" 优雅跳过。
      { type: "fileById", key: "店铺后台截图", labelFallback: "店铺后台截图", file: shopScreenshotPayload },
    ];

    return plan;
  },
};
