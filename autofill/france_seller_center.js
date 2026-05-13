// ============================================================================
// 法国卖家中心 - 自动填充计划生成器（积木）
// ============================================================================
// 输入：modulesData（已构建好的字段值）+ foundFiles（识别到的文件）+ aiData
//       （AI 原始字段，用于姓拼音/名拼音 fallback）+ utils（地址拆分 / PDF 转换等通用工具）
// 输出：plan 数组，由通用引擎 pageExecutePlan 逐项执行（type 决定使用 handleText /
//       handleSelect / handleRadio / handleCascader / handleDatepicker /
//       handleBusinessTerm / handleFile 中的哪一个）。
//
// 与 poland_seller_center.js 的差异（仅当前已确认部分；其余模块后续按页面 HTML 增补）：
//   1) 不需要 完税证明（中国税收居民身份证明）
//   2) 多一个 公司章程 上传项
//   3) 主要销售平台 改为 select（法国卖家中心不是按钮组而是下拉）
//   4) 文件上传：营业执照 / 身份证正反面 / 公司章程 等 同时支持「传统上传」+
//      「二维码扫码上传」两条通道：DOM 中既有传统 `<input type="file">`，旁边也有
//      `<div class="h5-upload-qr-code">` 提供手机扫码。当前 `fileById` 走传统上传通道
//      （labelFallback 文本兜底定位 `.uploadClearfixBox` / `input[type=file]`），
//      扫码通道走 evatmaster 的 `https://m.evatmaster.com/sse-upload` API，本扩展暂不接入。
//   5) 民族：法国页面是文本输入框（"请输入您的民族"），不是下拉。
//   6) 身份证签发机关：法国页面拆成 [地区名称 text] + [市/县/区 select] 两个控件，
//      由 parseIdCardIssuingAuthority 把 AI 提取的"XX市公安局" / "XX市公安局XX分局"
//      解析成 region + level 两段分别填。
//   7) 公司邮编 / 法人邮编 共享 placeholder="请输入邮政编码"；公司详细地址 / 法人详细地址
//      textarea 也容易撞 placeholder。为避免 labelText 兜底失败（页面 label DOM 可能不
//      规范、空 label 会被全部拒），统一用元素 `id` 属性选择器精确定位。注意页面 id
//      含逗号（如 "0,2,2,0,2"），必须写 `[id="..."]` 属性选择器，不能用 CSS `#id`。
// ============================================================================

// 清洗店铺联系电话：剥离区号（+86 / 86 / 0086）和所有空白 / 短横 / 圆括号，
// 让用户在 xlsx 里写 "+86 185 8953 0850" / "+86-185-8953-0850" / "(+86) 185 8953 0850"
// 都能落到页面上 "18589530850" 这个 11 位纯数字格式。
// 注：中国大陆手机号一律以 1 开头共 11 位，不会以 86 开头，所以剥离 86 前缀不会误伤。
function cleanShopPhone(raw) {
  if (!raw) return "";
  // 去掉空白、短横、圆括号、点号等常见分隔符
  let s = String(raw).replace(/[\s\-().·]+/g, "");
  // 剥离 +86 / 86 / 0086 / 086 等中国国家码前缀（含可选 + 与前导 0）
  s = s.replace(/^(\+?0{0,2}86)/, "");
  return s;
}

// 解析身份证签发机关，拆为 { region, level }，匹配以下常见格式：
//   - "义乌市公安局"             → { region: "义乌", level: "市" }
//   - "海淀区公安局"             → { region: "海淀", level: "区" }
//   - "某某县公安局"             → { region: "某某", level: "县" }
//   - "北京市公安局海淀分局"     → { region: "海淀", level: "区" }（分局对应区）
//   - "上海市浦东新区公安分局"   → { region: "浦东新", level: "区" }
//   - "广州市天河公安分局"       → { region: "天河",  level: "区" }
//   - "海淀公安分局"             → { region: "海淀", level: "区" }
//   - "XX公安局"（无市/县/区后缀）→ { region: "XX",   level: "市" }
// fallback：原文整体作为 region，level 默认 "市"。
function parseIdCardIssuingAuthority(text) {
  // 入参为空（如护照流下身份证签发机关字段已被 showIf 过滤掉）→ 返回全空，
  // 让下游 select handler 因 value 为空而跳过，避免在隐藏的 ant-select 上误点出 "市"。
  if (!text) return { region: "", level: "" };
  const t = String(text).trim();

  // 剥离首部省/直辖市/省+市 前缀，仅保留本地区域名。仅用于 公安分局 这种含多级行政区
  // 前缀的场景（如 "上海市浦东新区"→"浦东新区"、"广州市天河"→"天河"）。
  const stripProvinceCity = (s) => s
    .replace(/^[\u4e00-\u9fa5]+?省[\u4e00-\u9fa5]+?市/, "")
    .replace(/^[\u4e00-\u9fa5]+?省/, "")
    .replace(/^(北京市|上海市|天津市|重庆市)/, "")
    .replace(/^[\u4e00-\u9fa5]+?市/, "")
    .trim();

  // Pattern A: "...公安局YY分局"（中间夹一个"公安局"，如 北京市公安局海淀分局）
  let m = t.match(/公安局(.+?)分局$/);
  if (m) return { region: m[1].trim().replace(/[市县区]$/, ""), level: "区" };

  // Pattern B: "...公安分局"（无中间"公安局"，直接以 公安分局 结尾，如 上海市浦东新区公安分局）
  m = t.match(/^(.+?)公安分局$/);
  if (m) {
    const prefix = stripProvinceCity(m[1].trim()).replace(/[市县区]$/, "").trim();
    return { region: prefix, level: "区" };
  }

  // Pattern C: "XX市公安局" / "XX县公安局" / "XX区公安局"（市/县/区 是 公安局 行政级别）
  m = t.match(/^(.+?)([市县区])公安局$/);
  if (m) return { region: m[1].trim(), level: m[2] };

  // Pattern D: "XX公安局"（无市/县/区/分局后缀）
  m = t.match(/^(.+?)公安局$/);
  if (m) return { region: m[1].trim(), level: "市" };

  return { region: t, level: "市" };
}

export default {
  id: "france_seller_center",

  /**
   * @param {Object} input
   * @param {Array}  input.modulesData  - lastModulesData，已经按 requirements.json 的 modules 构建
   * @param {Array}  input.foundFiles   - lastValidationResult.found，含 key / label / file / imageData
   * @param {Object} input.aiData       - { license, idCardFront, idCardBack } AI 原始字段
   * @param {Object} input.utils        - 通用工具集合（见下方解构）
   * @param {string} [input.combinationKey] - "<国家>|<注册地>"（如 "France|HongKong"），用于结构分支
   * @returns {Promise<Array>} plan
   */
  async buildPlan({ modulesData, foundFiles, aiData, utils, combinationKey }) {
    const {
      splitAddressIntoRegionAndDetail,
      splitHkAddressIntoRegionAndDetail,
      imageFileToPdfBlob,
      buildSinglePagePdfFromJpeg,
      fileToBase64Plain,
    } = utils;

    // ---- 数据访问 helpers ----
    const moduleData = (modulesData || []).find((m) => m.title === "公司信息");
    const fields = moduleData?.fields || [];
    const get = (key) => (fields.find((f) => f.key === key)?.value || "").trim();
    const findFile = (k) => (foundFiles || []).find((f) => f.key === k);

    // ---- 注册地判定 ----
    // France|HongKong 与 France|China 共用本积木，但卖家中心初始页面会先让你选「注册地类型」
    // （大陆公司 / 香港公司 / 其他），选完点「确定」才会重新挂载对应字段的表单。
    // 香港组合需要在填字段前先做这两步点击，否则填进去的是大陆版表单 → 字段对不上。
    const isHongKong =
      combinationKey === "France|HongKong" || !!findFile("hk_business_registration");

    // ---- 文件查找 ----
    // 大陆 营业执照 vs 香港 CR 走完全不同的上传通道：
    //   - 大陆 营业执照：上传框 accept=".jpg,.jpeg,.png"，必须发 JPEG（keepImage:true）
    //   - 香港 CR：必须保留 PDF 格式，多页 PDF 仅抽出检测到的那一页（extractPagePdf:true，
    //     用 pdf-lib 的 PDFDocument.copyPages 直接拷贝页面对象，不走"PDF→图→PDF"那套损失文本/质量的转换）
    const businessLicense = findFile("business_license");
    const hkCr = findFile("hk_business_registration");
    // 法国特有：公司章程（替代波兰的 完税证明 位置）
    const articles = findFile("company_articles");
    // 法国特有：委托书盖章（用户需先点"生成临时占位"得到一份空白 PDF；后续会改为真实模板）
    const poa = findFile("power_of_attorney");

    // ---- 文件 → 上传 payload 转换 ----
    async function fileToPayload(found, opts = {}) {
      if (!found || !(found.file && found.file.file instanceof File)) return null;
      const f = found.file.file;
      // keepImage：上传框只接受图片（accept=".jpg,.jpeg,.png"）。优先复用 detectFiles
      // 已生成的页面 JPEG（`found.imageData`）：这套机制同时处理
      //   - 原本是单页 PDF：复用第一页 JPEG
      //   - 原本是多页 PDF（身份证正反面合一）：复用匹配页 JPEG
      //   - 原本就是图片：复用 AI 掣口的同份 base64
      if (opts.keepImage) {
        if (found.imageData) {
          const baseName = (f.name || "image").replace(/\.[^.\\/]+$/, "");
          const fileType = found.mimeType || "image/jpeg";
          const ext = fileType === "image/png" ? ".png" : ".jpg";
          return {
            name: `${baseName}${ext}`,
            fileType,
            base64: found.imageData,
            converted: false,
          };
        }
        // 上面都拿不到 imageData 时，回退到原文件是图片就直读的路径
        const lowerType = (f.type || "").toLowerCase();
        const lowerName = (f.name || "").toLowerCase();
        const isImg = lowerType.startsWith("image/")
          || /\.(png|jpe?g|gif|webp|bmp)$/i.test(lowerName);
        if (isImg) {
          const base64 = await fileToBase64Plain(f);
          const fileType = f.type || (lowerName.endsWith(".png") ? "image/png" : "image/jpeg");
          return { name: f.name, fileType, base64, converted: false };
        }
        // 既无 imageData 又非图片源 —— 走默认 PDF 逻辑充当兜底（这种上传框会在 accept 检查里打警告）
      }
      // extractPagePdf：上传框 accept=".pdf"，且必须保留为 PDF（不能转图）。
      //   - 原文件是图片：用 imageFileToPdfBlob 包成单页 PDF（无外部依赖的最小 PDF 包装）
      //   - 原文件是单页 PDF：原样上传，不做任何修改
      //   - 原文件是多页 PDF：用 pdf-lib 把检测到的那一页（path 末尾的 "(第N页)"）整体拷贝出来组成新单页 PDF；
      //     页面对象级别拷贝，文本/字体/矢量元素全部保留，不会因为 PDF→图 的栅格化而丢质量。
      // 用于 香港公司注册证书CR：扫描件常常是 1~2 页 PDF，AI 检测到哪一页就只上传哪一页。
      if (opts.extractPagePdf) {
        const lowerType = (f.type || "").toLowerCase();
        const lowerName = (f.name || "").toLowerCase();
        const isPdf = lowerType === "application/pdf" || lowerName.endsWith(".pdf");
        if (!isPdf) {
          // 原文件是图片：复用通用图片→PDF 包装
          const { blob, name, converted } = await imageFileToPdfBlob(f);
          const base64 = await fileToBase64Plain(blob);
          return { name, fileType: "application/pdf", base64, converted };
        }
        // 是 PDF —— 用 pdf-lib 加载，按页数决定是原样传还是抽页
        if (typeof window === "undefined" || !window.PDFLib) {
          throw new Error("pdf-lib 未加载（libs/pdf-lib.min.js）");
        }
        const { PDFDocument } = window.PDFLib;
        const srcBytes = new Uint8Array(await f.arrayBuffer());
        const srcDoc = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
        const totalPages = srcDoc.getPageCount();
        if (totalPages <= 1) {
          // 单页 PDF：原样上传，name/类型不变，不打 _pN 后缀
          const base64 = await fileToBase64Plain(f);
          return { name: f.name, fileType: "application/pdf", base64, converted: false };
        }
        // 多页 PDF：从 path 末尾解析检测到的页码，缺省回退到第 1 页
        const pageMatch = (found.file.path || "").match(/\(第(\d+)页\)/);
        const pageNum = pageMatch ? parseInt(pageMatch[1], 10) : 1;
        const idx = Math.max(0, Math.min(pageNum - 1, totalPages - 1));
        const newDoc = await PDFDocument.create();
        const [copied] = await newDoc.copyPages(srcDoc, [idx]);
        newDoc.addPage(copied);
        const newBytes = await newDoc.save();
        const baseName = (f.name || "page").replace(/\.[^.\\/]+$/, "");
        const blob = new Blob([newBytes], { type: "application/pdf" });
        const base64 = await fileToBase64Plain(blob);
        return {
          name: `${baseName}_p${idx + 1}.pdf`,
          fileType: "application/pdf",
          base64,
          converted: true,
        };
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

    // 大陆 营业执照 上传框 accept=".jpg,.jpeg,.png" —— 不转 PDF，直接发第一页 JPEG。
    // 香港 CR 走 extractPagePdf：保留 PDF 格式，多页时仅抽检测到的那一页（用 pdf-lib copyPages，不走 PDF→图 转换）。
    // 同一组合下两者只会命中其中一个，licensePayload 给后续 plan 项的 "营业执照" 上传位用。
    let licensePayload;
    if (businessLicense) {
      licensePayload = await fileToPayload(businessLicense, { keepImage: true });
    } else if (hkCr) {
      licensePayload = await fileToPayload(hkCr, { extractPagePdf: true });
    } else {
      licensePayload = null;
    }
    // 公司章程、委托书盖章：accept 本身可能是 .pdf，继续走 PDF 上传通道
    const articlesPayload = await fileToPayload(articles);
    const poaPayload = await fileToPayload(poa);
    // 店铺后台截图：要求 JPG/JPEG/PNG 直接上传
    const shopScreenshot = findFile("shop_backend_screenshot");
    const shopScreenshotPayload = await fileToPayload(shopScreenshot, { keepImage: true });

    // 公司/个体经营注册地址(中文) 表单含 cascader(省市区) + textarea(详细地址)
    // AI 提取的"住所"是完整地址，需要拆分成两段分别填入。
    // 香港组合走 splitHkAddressIntoRegionAndDetail：18 区关键词匹配，region 固定
    // "香港特别行政区 / 香港特别行政区 / <区>"；大陆组合走通用 zh-CN 省市区拆分。
    const regAddrSplit = isHongKong
      ? splitHkAddressIntoRegionAndDetail(get("公司/个体经营注册地址(中文)"))
      : splitAddressIntoRegionAndDetail(get("公司/个体经营注册地址(中文)"));

    // ============== 法人代表信息（来自 modulesData["法人代表信息"] + foundFiles + aiData） ==============
    const repModule = (modulesData || []).find((m) => m.title === "法人代表信息");
    const repFields = repModule?.fields || [];
    const getRep = (key) => (repFields.find((f) => f.key === key)?.value || "").trim();

    // 身份证正反面上传框 accept=".jpg,.jpeg,.png"：同营业执照，发页面 JPEG，不转 PDF。
    // 多页 PDF（人像面+国徽面合一）时 found.imageData 已是匹配页的 JPEG。
    const idFront = findFile("id_card_front");
    const idBack = findFile("id_card_back");
    const idFrontPayload = await fileToPayload(idFront, { keepImage: true });
    const idBackPayload = await fileToPayload(idBack, { keepImage: true });

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
    const passportAddrSplit = splitAddressIntoRegionAndDetail(getRep("法人代表详细地址"));
    const isPassportFlow = getRep("上传法人代表证件信息") === "法人护照";

    const passport = findFile("passport");
    const passportPayload = await fileToPayload(passport, { keepImage: true });
    const aiPassport = aiData?.passport || {};
    const passportFullPinyin = (aiPassport.拼音名 || "").trim();
    const passportSurname = (aiPassport.姓拼音 || "").trim();
    const passportGiven = (aiPassport.名拼音 || "").trim();
    if (isPassportFlow) {
      surnamePinyin = passportSurname || "";
      givenNamePinyin = passportGiven || "";
      if ((!surnamePinyin || !givenNamePinyin) && passportFullPinyin) {
        const syllables = passportFullPinyin.match(/[A-Z][a-z]+/g) || passportFullPinyin.split(/\s+/).filter(Boolean);
        if (!surnamePinyin && syllables.length >= 1) surnamePinyin = syllables[0];
        if (!givenNamePinyin && syllables.length >= 2) givenNamePinyin = syllables.slice(1).join("");
      }
    }

    // ============== 店铺信息（来自 modulesData["店铺信息"]） ==============
    const shopModule = (modulesData || []).find((m) => m.title === "店铺信息");
    const shopFields = shopModule?.fields || [];
    const getShop = (key) => (shopFields.find((f) => f.key === key)?.value || "").trim();

    /** @type {Array<object>} */
    const plan = [
      // ============================ 注册地预选（仅 France|HongKong） ============================
      // 卖家中心初始页面会让你选公司注册地（大陆/香港/其他），选完点"确定"才会重新挂载对应表单。
      // 大陆组合默认就是大陆表单，不需要做这一步；香港组合必须先切过去，否则下面的字段会填到大陆版表单。
      ...(isHongKong
        ? [
            {
              type: "click",
              key: "选择注册地-香港公司",
              // 卡片元素是 div.company-type，里面有 <span>香港公司</span>
              selector: ".company-type",
              textContent: "香港公司",
              // 已经选中过的卡片 class 上会多出 "active"，此时不要再点（再点会取消选中）
              skipIfHasClass: "active",
              postDelay: 250,
            },
            {
              type: "click",
              key: "确认注册地",
              // 选完卡片后页面底部的 antd 主按钮（HTML: button.ant-btn.ant-btn-primary <span>确 定</span>）
              // 文本匹配会忽略空白，"确定"也能命中"确 定"
              selector: "button.ant-btn-primary",
              textContent: "确定",
              // 已经确认过注册地的页面不再有"确定"按钮，按钮会被替换为"提交资料"等其他主按钮
              // 文本匹配失败时静默跳过即可，不应报错阻塞后续填表
              optional: true,
              // 点完之后 Vue 异步重挂载香港版表单，给足 1s 兜底
              postDelay: 1000,
            },
          ]
        : []),

      // ============================ 公司信息 ============================
      // --- 文本字段 ---
      { type: "text", key: "公司名称", placeholder: "请输入公司名称", value: get("公司名称") },
      // 营业执照号 placeholder 按页面实际文案："营业执照号码/注册号"（无"请输入"前缀）
      { type: "text", key: "营业执照号码/注册号", placeholder: "营业执照号码/注册号", value: get("营业执照号码/注册号") },
      // 注册资本去掉末尾的"元"（页面输入框只接受纯数字/金额）
      { type: "text", key: "注册资本", placeholder: "请输入注册资本", value: get("注册资本").replace(/元\s*$/u, "") },
      // 公司邮编：与 法人邮编 共享 placeholder="请输入邮政编码"，用页面 id 绝对定位
      // （maxlength=12，法人那个是 20，仅作识别参考）
      // afterPopup:true —— 公司邮编 id "0,2,2,0,2" 与 公司注册地址 cascader id "0,2,2,0,0"
      // 同属 form-item "0,2,2"，cascader 在 Phase 2 的 change 事件会把同 form-item
      // 内的邮编输入框清空；必须等 cascader 选完才能填，否则白填。
      {
        type: "text",
        key: "邮编",
        elementSelector: '[id="0,2,2,0,2"]',
        placeholder: "请输入邮政编码",
        value: get("邮编"),
        afterPopup: true,
      },
      // 公司注册地址详细 textarea：页面 placeholder="请输入详细地址"，用 id 精确定位
      // 避免与法人详细地址 textarea (placeholder="请输入法人代表详细地址") 串位。
      {
        type: "text",
        key: "公司/个体经营注册地址(中文)-详细",
        elementSelector: '[id="0,2,3,0,0"]',
        placeholder: "请输入详细地址",
        value: regAddrSplit.detail,
      },

      // --- 文件上传（fieldId 待补：拿到法国卖家中心页面 .uploadClearfixBox[field-id] 后再回填；
      //     当前用 labelFallback 兜底，handleFile 会通过附近文本节点定位上传框） ---
      { type: "fileById", key: "营业执照", labelFallback: "营业执照", file: licensePayload },
      // 法国特有：公司章程
      { type: "fileById", key: "公司章程", labelFallback: "公司章程", file: articlesPayload },
      // 法国特有：委托书盖章（当前仅占位 PDF；fieldId 与最终上传位待法国卖家中心 HTML 出来后回填）
      { type: "fileById", key: "委托书盖章", labelFallback: "委托书盖章", file: poaPayload },

      // --- 公司类型（ant-select 下拉）：页面 已被预设默认值后，.ant-select-selection__placeholder
      // 会被 .ant-select-selection-selected-value 取代 —— 靠 placeholder 找不到控件；用 id 绝对定位。
      // AI 输出“有限责任公司(自然人独资)”（半角括号）与页面选项“有限责任公司（自然人独资）”（全角）
      // 不同，handleSelect 内部会做括号归一后精确匹配，出不了“有限责任公司”这种短名误选。
      {
        type: "select",
        key: "公司类型",
        elementSelector: '[id="0,2,1,0,0"]',
        placeholder: "请选择公司类型",
        value: get("公司类型"),
      },

      // --- 日期 ---
      { type: "datepicker", key: "公司成立日期", placeholder: "请选择公司成立日期", value: get("公司成立日期") },
      // 核准日期：AI 从营业执照登记机关印章下方提取；placeholder 待根据页面 HTML 调整
      // 香港组合没有"核准日期"字段（HK 表单里不存在这一项），跳过避免日志刷"未找到"
      ...(!isHongKong
        ? [{ type: "datepicker", key: "核准日期", placeholder: "请选择核准日期", value: get("核准日期") }]
        : []),

      // --- 级联选择器 ---
      // （法国 + 大陆组合的页面没有 营业执照签发机关 cascader。AI 仍然提取 登记机关 字段
      //   供 身份证签发机关拆分 / 调试使用）。
      // 公司注册地址 省/市/区 cascader：页面真实 placeholder="请选择所在省/市/区"（带"所在"），
      // 与法人 cascader ("请选择省/市/区") 不同；为防止页面改版后 placeholder 飘移，
      // 直接用 id 属性选择器锁定。
      // ⚠️ 注册地不同 → cascader id 不同：大陆是 "0,2,2,0,0"，香港是 "0,2,2,0,1"
      //    （香港版表单在前面多挂了一项 "公司注册地"，把 cascader 顺位往后推一格）。
      {
        type: "cascader",
        key: "公司/个体经营注册地址(中文)-省市区",
        elementSelector: isHongKong ? '[id="0,2,2,0,1"]' : '[id="0,2,2,0,0"]',
        placeholder: "请选择所在省/市/区",
        value: regAddrSplit.region,
      },

      // ============================ 法人代表信息 ============================
      // 证件类型：根据识别结果在"法人身份证" / "法人护照"间切换
      // 这个 radio 会改变下面字段的可见性（Phase 0 PRE 里最先跑），所以要先出现
      { type: "radio", key: "证件类型", value: getRep("上传法人代表证件信息") },

      // 按证件类型分支：身份证流与护照流的字段互斥，不输出另一方以免 UI 上出错
      ...(isPassportFlow
        ? [
            // === 护照流 ===
            { type: "fileById", key: "法人代表护照", labelFallback: "护照", file: passportPayload },
            { type: "text", key: "法人/个人代表中文名", placeholder: "请输入法人/个人代表中文名", value: getRep("法人/个人代表中文名") },
            // 法人护照号：页面 placeholder 末尾无"号"前面无"请输入"，id="1,1,0,1,0" 直接锁定避开 placeholder 飘移
            {
              type: "text",
              key: "法人/个人代表护照号",
              elementSelector: '[id="1,1,0,1,0"]',
              placeholder: "法人/个人代表护照号",
              value: getRep("法人/个人代表护照号"),
            },
            // 拼音名拆成姓 / 名两段
            { type: "text", key: "法人拼音-姓", placeholder: "姓，如：Yang", value: surnamePinyin },
            { type: "text", key: "法人拼音-名", placeholder: "名，如：Xingying", value: givenNamePinyin },
            // 护照流下填 法人详细地址（xlsx cell 来源 / 翻译成中文）
            {
              type: "text",
              key: "法人/个人代表详细地址",
              elementSelector: '[id="1,1,3,0,0"]',
              placeholder: "请输入法人代表详细地址",
              value: passportAddrSplit.detail,
            },
            { type: "datepicker", key: "法人/个人代表出生日期", placeholder: "请选择或输入日期（20XX-XX-XX）", value: getRep("法人/个人代表出生日期") },
            { type: "businessTerm", key: "护照有效期限", labelText: "护照有效期限", value: getRep("护照有效期限") },
            {
              type: "cascader",
              key: "法人/个人代表详细地址-省市区",
              elementSelector: '[id="1,1,2,0,0"]',
              placeholder: "请选择省/市/区",
              value: passportAddrSplit.region,
            },
            { type: "radio", key: "性别", value: getRep("性别") },
          ]
        : [
            // === 身份证流 ===
            // 文件上传（fieldId 待补；labelFallback 用 "（人像面）" / "（国徽面）" 文本兜底定位）
            { type: "fileById", key: "法人代表身份证(人像面)", labelFallback: "（人像面）", file: idFrontPayload },
            { type: "fileById", key: "法人代表身份证(国徽面)", labelFallback: "（国徽面）", file: idBackPayload },
            { type: "text", key: "法人/个人代表中文名", placeholder: "请输入法人/个人代表中文名", value: getRep("法人/个人代表中文名") },
            // 法人身份证号 placeholder 按页面实际文案（末尾无"号"字）
            { type: "text", key: "法人/个人代表身份证号", placeholder: "法人/个人代表身份证", value: getRep("法人/个人代表身份证号") },
            // 拼音名拆成姓 / 名两段
            { type: "text", key: "法人拼音-姓", placeholder: "姓，如：Yang", value: surnamePinyin },
            { type: "text", key: "法人拼音-名", placeholder: "名，如：Xingying", value: givenNamePinyin },
            // 法人身份证地址详细 textarea：页面 placeholder="请输入法人代表详细地址"，用 id 锁定
            {
              type: "text",
              key: "法人/个人代表身份证地址-详细",
              elementSelector: '[id="1,1,3,0,0"]',
              placeholder: "请输入法人代表详细地址",
              value: idAddrSplit.detail,
            },
            { type: "datepicker", key: "法人/个人代表出生日期", placeholder: "请选择或输入日期（20XX-XX-XX）", value: getRep("法人/个人代表出生日期") },
            // 身份证有效期限（与营业期限同样的 长期 toggle / 日期范围 结构，必须用 labelText 区分）
            { type: "businessTerm", key: "法人代表身份证有效期限", labelText: "法人代表身份证有效期限", value: getRep("法人代表身份证有效期限") },
            // 法人身份证地址 省/市/区 cascader：placeholder="请选择省/市/区"（无"所在"），与 公司注册地址
            // cascader ("请选择所在省/市/区") 文案接近但不同；用 id 直接锁定避免任何歧义。
            {
              type: "cascader",
              key: "法人/个人代表身份证地址-省市区",
              elementSelector: '[id="1,1,2,0,0"]',
              placeholder: "请选择省/市/区",
              value: idAddrSplit.region,
            },
            { type: "radio", key: "性别", value: getRep("性别") },
            // 民族：法国页面是文本输入框（非 ant-select），placeholder="请输入您的民族"
            { type: "text", key: "民族", placeholder: "请输入您的民族", value: getRep("民族") },
            // 身份证签发机关：法国页面拆成两个控件：
            //   (1) 地区名称文本框（如 "丰顺"）
            //   (2) 市/县/区 下拉框（ant-select id="1,1,5,0,1"）
            // 由 parseIdCardIssuingAuthority 把 AI 提取的"XX市公安局" / "XX县公安局" / "XX市公安局XX分局"
            // 拆分填入。select 控件被预设为"市"后 placeholder span 会消失，必须用 id 锁定。
            ...(function () {
              const issuingAuth = parseIdCardIssuingAuthority(getRep("身份证签发机关"));
              return [
                { type: "text", key: "身份证签发机关-地区名称", placeholder: "请参照身份证背面输入地区名称", value: issuingAuth.region },
                { type: "select", key: "身份证签发机关-市县区", elementSelector: '[id="1,1,5,0,1"]', value: issuingAuth.level },
              ];
            })(),
            // 法人身份证邮政编码（放在法人信息模块最后填写）：根据 AI 提取的住址里的市/区查表得到的 6 位邮编。
            // 与 公司邮编 共享 placeholder="请输入邮政编码"，但 id 不同，用 id 绝对定位即可。
            // afterPopup:true —— 必须等 身份证地址 cascader（Phase 2）选完再填，否则 cascader 的
            // change 事件会把同 form-item 内的邮编输入框清空。
            {
              type: "text",
              key: "法人/个人代表身份证邮编",
              elementSelector: '[id="1,1,2,0,1"]',
              placeholder: "请输入邮政编码",
              value: getRep("法人/个人代表身份证邮编"),
              afterPopup: true,
            },
          ]),

      // ============================ 店铺信息 ============================
      // 主要销售平台：法国卖家中心是 ant-select 下拉（区别于波兰的 ant-radio-button-wrapper）。
      // 值由 buildModuleData 的 platform_from_url 派生：速卖通 / 亚马逊 / 其他。
      { type: "select", key: "主要销售平台", placeholder: "请选择主要销售平台", value: getShop("主要销售平台") },

      // 文本字段——店铺信息 字段的 placeholder 与早期推测差异较大（页面用「请输入店铺链接」
      // 而不是「请输入主要销售平台店铺链接」；且「未来12个月预估税金」placeholder 实测为空字符串）。
      // 为防页面后续改文案，主要项一律用 id 锁死。
      // 主要销售平台店铺链接 — placeholder="请输入店铺链接"
      {
        type: "text",
        key: "主要销售平台店铺链接",
        elementSelector: '[id="2,0,1,0,0"]',
        placeholder: "请输入店铺链接",
        value: getShop("主要销售平台店铺链接"),
      },
      // 主要销售平台店铺ID — placeholder="请输入您的店铺ID"
      {
        type: "text",
        key: "主要销售平台店铺ID",
        elementSelector: '[id="2,0,2,0,1"]',
        placeholder: "请输入您的店铺ID",
        value: getShop("主要销售平台店铺ID"),
      },
      { type: "text", key: "公司英文名称", placeholder: "请务必填写您亚马逊后台/电商平台后台的公司英文名称", value: getShop("公司英文名称") },
      { type: "text", key: "公司/个体经营注册地址(英文)", placeholder: "请输入与亚马逊后台一致的经营注册地址", value: getShop("公司/个体经营注册地址（英文）") },
      { type: "text", key: "联系邮箱", placeholder: "请输入公司联系人邮箱", value: getShop("联系邮箱") },
      // 店铺简称/名称 — 页面是 textarea（不是 input），placeholder="请输入与您平台一致的店铺名称"
      {
        type: "text",
        key: "公司(个人)店铺简称/名称",
        elementSelector: '[id="2,0,7,1,0"]',
        placeholder: "请输入与您平台一致的店铺名称",
        value: getShop("公司(个人)店铺简称/名称"),
      },
      // 店铺联系电话：xlsx 里可能写成 "+86 185 8953 0850"，页面只接受纯 11 位数字
      { type: "text", key: "店铺联系电话", placeholder: "请输入店铺联系电话", value: cleanShopPhone(getShop("店铺联系电话")) },
      // 未来12个月销售预估 — placeholder="未来12个月销售预估"（无「请输入」前缀）
      {
        type: "text",
        key: "未来12个月销售预估",
        elementSelector: '[id="2,0,5,0,0"]',
        placeholder: "未来12个月销售预估",
        value: getShop("未来12个月销售预估"),
      },
      // 未来12个月预估税金 — 页面 placeholder 是空字符串，只能靠 id 定位
      {
        type: "text",
        key: "未来12个月预估税金",
        elementSelector: '[id="2,0,6,0,0"]',
        value: getShop("未来12个月预估税金"),
      },

      // 经营范围：ant-select 多选，默认值 "电子商品 electrical products"（下拉第一项）。
      // 页面 placeholder 用半角括号「请选择公司(个人)店铺主要经营范围」，与 plan key/value 的全角
      // 不一致；handleSelect 内部已对 placeholder 查找做了括号归一，两边都能匹配。
      {
        type: "select",
        key: "公司（个人）店铺主要经营范围",
        placeholder: "请选择公司(个人)店铺主要经营范围",
        value: getShop("公司（个人）店铺主要经营范围"),
      },

      // 是否已填写所有销售中的平台店铺信息：radio（默认 "是"）
      { type: "radio", key: "是否已填写所有销售中的平台店铺信息", value: getShop("是否已填写所有销售中的平台店铺信息") },

      // 店铺后台截图：要求 JPG/JPEG/PNG 直接上传（不转 PDF）。fieldId 待补，
      // 当前用 labelFallback 兜底，handleFile 会通过附近文本节点定位上传框。
      // 若 foundFiles 中没有该项（用户未点击"生成临时占位"且未自行上传），file 为 null，
      // handleFile 会以 "无文件，跳过" 优雅跳过。
      { type: "fileById", key: "店铺后台截图", labelFallback: "店铺后台截图", file: shopScreenshotPayload },
    ];

    return plan;
  },
};
