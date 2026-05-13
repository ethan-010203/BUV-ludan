// popup.js - Main logic with chrome.storage.local persistence

document.addEventListener("DOMContentLoaded", async () => {
  const countrySelect = document.getElementById("country-select");
  const registrationSelect = document.getElementById("registration-select");
  const uploadArea = document.getElementById("upload-area");
  const fileCount = document.getElementById("file-count");
  const fileCountText = document.getElementById("file-count-text");
  const clearFilesBtn = document.getElementById("clear-files");
  const validateBtn = document.getElementById("validate-btn");
  const detachBtn = document.getElementById("detach-btn");

  // --- Detached window mode ---
  // When opened via chrome.windows.create with ?detached=1, hide the detach button
  const urlParams = new URLSearchParams(window.location.search);
  const isDetached = urlParams.get("detached") === "1";
  // Source tab id is captured when the user clicks the toolbar icon (non-detached popup)
  // and forwarded via URL param when detaching, so that 一键注入 always knows the original
  // page tab even if user later switches tabs / focuses the detached popup.
  let sourceTabId = parseInt(urlParams.get("srcTab") || "", 10);
  if (!Number.isFinite(sourceTabId) || sourceTabId <= 0) sourceTabId = null;

  if (isDetached) {
    detachBtn.style.display = "none";
    document.title = "录单助手（独立窗口）";
  } else {
    // In non-detached popup, the active tab in the current window is the user's target tab.
    // Capture it now (activeTab permission grants temporary access).
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab && activeTab.id) sourceTabId = activeTab.id;
    } catch (e) {
      console.warn("[popup] failed to capture source tab:", e);
    }

    detachBtn.addEventListener("click", async () => {
      // Re-capture (in case it changed) and forward via URL param so detached popup keeps it.
      let srcId = sourceTabId;
      try {
        const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (t && t.id) srcId = t.id;
      } catch (_) {}
      const url = chrome.runtime.getURL(
        `popup.html?detached=1${srcId ? `&srcTab=${srcId}` : ""}`
      );
      chrome.windows.create({ url, type: "popup", width: 460, height: 720 });
      window.close(); // close the small popup since user prefers detached
    });
  }

  let uploadedFiles = [];
  let droppedFolderNames = [];
  let currentReqConfig = null;
  let config = null;
  let apiKey = "";
  let lastValidationResult = null;
  let lastModulesData = null;
  // 存放 AI 提取的原始字段，供 buildAutofillPlan 使用（特别是显示模块里没有的辅助字段，例如 姓拼音/名拼音）
  let lastAiData = { license: {}, idCardFront: {}, idCardBack: {}, hkCr: {}, passport: {} };
  // 临时占位文件：label -> File 对象。用户在缺失列表点击"生成临时占位"按钮时填入。
  // 这些文件会被推入 uploadedFiles + lastValidationResult.found，参与一键注入上传。
  let placeholderState = {};

  // 占位文件配置改由 currentReqConfig.placeholders 提供（见 requirements.json）。
  // 这两个 helper 只是从当前组合配置里取值，使下方代码读起来更直观。
  // pdf 用于上传框 accept=".pdf" 的字段（如 完税证明）。
  // png 用于必须保留为图片的字段（如 店铺后台截图，要求 JPG/JPEG/PNG）。
  function getPlaceholderConfig(key) {
    return (currentReqConfig && currentReqConfig.placeholders && currentReqConfig.placeholders[key]) || null;
  }
  function getCurrentModules() {
    return (currentReqConfig && Array.isArray(currentReqConfig.modules)) ? currentReqConfig.modules : [];
  }

  // --- Load config from JSON ---
  // requirements.json 现在只放国家 / 注册地 / 字段配置，不再放 API Key。
  // API Key 由用户在「⚙️ 配置」tab 输入并保存到 chrome.storage.local（见 loadApiKey）。
  async function loadConfig() {
    try {
      const resp = await fetch(chrome.runtime.getURL("requirements.json"));
      config = await resp.json();
    } catch (e) {
      console.error("Failed to load requirements.json:", e);
      config = { countries: {}, registrations: {}, requirements: {} };
    }
  }

  // --- API Key persistence (chrome.storage.local) ---
  // 旧版本可能把 apiKey 写在 requirements.json 里，这里做一次性迁移：
  // 若 storage 里没有 apiKey 但 JSON 里有，则把 JSON 里的复制到 storage。
  function loadApiKey() {
    return new Promise(resolve => {
      chrome.storage.local.get(["apiKey"], (data) => {
        let key = (data && typeof data.apiKey === "string") ? data.apiKey.trim() : "";
        if (!key && config && typeof config.apiKey === "string" && config.apiKey.trim()) {
          key = config.apiKey.trim();
          chrome.storage.local.set({ apiKey: key });
        }
        apiKey = key;
        resolve(key);
      });
    });
  }

  function saveApiKey(key) {
    return new Promise(resolve => {
      const v = (key || "").trim();
      apiKey = v;
      chrome.storage.local.set({ apiKey: v }, resolve);
    });
  }

  function clearApiKey() {
    return new Promise(resolve => {
      apiKey = "";
      chrome.storage.local.remove("apiKey", resolve);
    });
  }

  // --- Storage helpers ---
  // File objects are kept ONLY in-memory (uploadedFiles variable).
  // Storage saves metadata only for persistence across popup reopen.
  function saveState() {
    chrome.storage.local.set({
      country: countrySelect.value,
      registration: registrationSelect.value
    });
  }

  function loadState() {
    return new Promise(resolve => {
      chrome.storage.local.get(["country", "registration"], (data) => {
        resolve({
          country: data.country,
          registration: data.registration
        });
      });
    });
  }

  // Check if in-memory uploadedFiles have real File objects
  function hasFileObjects() {
    return uploadedFiles.some(f => f.file instanceof File);
  }

  // --- File reading helpers ---
  const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'];

  function getFileExtension(name) {
    const dotIdx = name.lastIndexOf(".");
    return dotIdx >= 0 ? name.substring(dotIdx).toLowerCase() : "";
  }

  function isImageFile(filename) {
    const ext = getFileExtension(filename);
    return IMAGE_EXTENSIONS.includes(ext);
  }

  async function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // Configure PDF.js worker
  if (typeof pdfjsLib !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("libs/pdf.worker.min.js");
  }

  // Convert PDF file (File object) to array of base64 JPEG images (one per page)
  async function pdfToImages(file, maxPages = 5) {
    if (typeof pdfjsLib === "undefined") {
      throw new Error("pdf.js 未加载");
    }
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const numPages = Math.min(pdf.numPages, maxPages);
    const images = [];

    for (let i = 1; i <= numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      const base64 = dataUrl.split(",")[1];
      images.push(base64);
    }
    return images;
  }

  // Convert a non-2xx Moonshot API response to a precise Chinese error message.
  // 让上层日志能直接看出是 429 限流 / 余额不足 / API Key 无效 / 服务异常 等。
  function describeMoonshotError(status, bodyText) {
    let detail = "";
    try {
      const body = JSON.parse(bodyText);
      if (body && body.error) {
        detail = body.error.message || body.error.code || "";
      }
    } catch (_) { /* body 不是 JSON，忽略 */ }

    let hint;
    if (status === 429) {
      if (/quota|exceed|insufficient|balance|余额|额度|不足/i.test(detail)) {
        hint = `Moonshot 余额/额度不足（HTTP 429）`;
      } else {
        hint = `Moonshot 调用过于频繁，触发速率限制（HTTP 429）`;
      }
    } else if (status === 401) {
      hint = `Moonshot API Key 无效或未授权（HTTP 401）`;
    } else if (status === 402) {
      hint = `Moonshot 账户余额不足（HTTP 402）`;
    } else if (status === 403) {
      hint = `Moonshot 拒绝访问，请检查 API Key 权限（HTTP 403）`;
    } else if (status === 404) {
      hint = `Moonshot 模型或接口不存在（HTTP 404）`;
    } else if (status >= 500) {
      hint = `Moonshot 服务异常，请稍后重试（HTTP ${status}）`;
    } else {
      hint = `Moonshot 调用失败（HTTP ${status}）`;
    }
    return detail ? `${hint}: ${detail}` : hint;
  }

  // 从 Moonshot 响应的 Headers 里拽诊断字段，返回形如 " [tier=free-tier-1 req=xxx server=1234]" 的后缀。
  // 这些字段完全等同于 MoonPalace 调试工具拓到的“Msh-Gid / Msh-Request-Id / Server-Timing”，
  // 帮助快速看出帐号 tier（vision-preview 在低 tier 容易被过载拒绝）、服务端耗时、以及拿去 Moonshot 客服查问用的 request id。
  function formatMoonshotDiag(headers) {
    if (!headers || typeof headers.get !== "function") return "";
    const gid = headers.get("Msh-Gid");
    const reqId = headers.get("Msh-Request-Id");
    const timing = headers.get("Server-Timing");
    const parts = [];
    if (gid) parts.push(`tier=${gid}`);
    if (reqId) parts.push(`req=${reqId}`);
    if (timing) parts.push(`server=${timing}`);
    return parts.length ? ` [${parts.join(" ")}]` : "";
  }

  // Pre-flight: 查 Moonshot 帐号可用余额。
  // 返回 { ok, balance, message }。ok=false 表示查不到，调用方不应以此阻断 AI，仅用于诊断。
  // 只有 ok=true && balance<=0 才肯定为“余额不足”。
  async function checkMoonshotBalance() {
    if (!apiKey) return { ok: false, message: "未配置 API Key" };
    try {
      const resp = await fetch("https://api.moonshot.cn/v1/users/me/balance", {
        method: "GET",
        headers: { "Authorization": `Bearer ${apiKey}` }
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        return { ok: false, message: describeMoonshotError(resp.status, errText) };
      }
      const tier = resp.headers.get("Msh-Gid") || "";
      const body = await resp.json();
      const available = Number(body && body.data && body.data.available_balance);
      if (!Number.isFinite(available)) {
        return { ok: false, message: "余额响应格式不可识别", tier };
      }
      return { ok: true, balance: available, tier };
    } catch (e) {
      return { ok: false, message: (e && e.message) || String(e) };
    }
  }

  // 节流状态：记录上一次 chat 调用的起始时间戳。
  // 低 tier 账号的 vision-preview 并发槽位很少，块状出现 5 个文件连发很容易被 “overloaded” 捆。
  let _lastChatCallAt = 0;
  const CHAT_MIN_INTERVAL_MS = 600;

  // Fetch Moonshot /v1/chat/completions 带自动重试。
  // 触发重试的情况：网络异常、HTTP 5xx、HTTP 429（除非 body 明显是余额/额度不足）。
  // 不重试的情况：401/403/404、4xx 其它、429 但是 quota 耗尽。
  // 最多 1+delays.length 次尝试，任何结果（成功或最终失败）都以 Response 返回。网络错误耗尽重试后会 throw。
  async function fetchMoonshotChat(bodyObj, tag = "AI") {
    // 节流：从上一次调用起至少间隔 CHAT_MIN_INTERVAL_MS。只作用于“首次尝试”，不影响重试退避。
    const sinceLast = Date.now() - _lastChatCallAt;
    if (_lastChatCallAt && sinceLast < CHAT_MIN_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, CHAT_MIN_INTERVAL_MS - sinceLast));
    }
    _lastChatCallAt = Date.now();

    const url = "https://api.moonshot.cn/v1/chat/completions";
    const init = {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(bodyObj)
    };
    const delays = [1500, 4000]; // retry 1 后等 1.5s，retry 2 后等 4s
    const maxAttempts = 1 + delays.length;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let resp;
      try {
        resp = await fetch(url, init);
      } catch (e) {
        if (attempt < maxAttempts) {
          const wait = delays[attempt - 1];
          statusLog(`[${tag}] 网络异常（${e.message}），${(wait / 1000).toFixed(1)}s 后重试 (${attempt}/${delays.length})`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw e;
      }

      if (resp.ok) return resp;

      // 读 body 用于判断是否值得重试；clone 的拷贝用于重试分支，原 resp 仍可给调用方的 body 解析。
      const errText = await resp.clone().text().catch(() => "");
      const isQuotaLike = /quota|insufficient|balance|余额|额度|不足/i.test(errText);
      const shouldRetry = resp.status >= 500 || (resp.status === 429 && !isQuotaLike);

      if (shouldRetry && attempt < maxAttempts) {
        const wait = delays[attempt - 1];
        const msg = describeMoonshotError(resp.status, errText);
        const diag = formatMoonshotDiag(resp.headers);
        statusLog(`[${tag}] ${msg}${diag}，${(wait / 1000).toFixed(1)}s 后重试 (${attempt}/${delays.length})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      return resp; // 不可重试 或 重试次数耗尽，交给调用方处理
    }
    // unreachable
  }

  // --- AI Detection using Moonshot API ---
  async function detectWithAI(filePath, fileData) {
    if (!apiKey) {
      return null; // No API key, skip AI
    }

    const ext = getFileExtension(filePath);
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';

    const prompt = `请识别这份文件的类型。判断规则如下：
1. 营业执照：图片主体是**一张完整的中国大陆营业执照**，顶部有"营业执照"标题，能看到"统一社会信用代码"或"法定代表人"或"注册资本"等简体中文字段，通常带红章。**必须是简体中文**；若主体是繁体中文/英文的香港证书 → 属于"香港公司注册证书"，不是本类型。
2. 身份证正面：图片主体是**一张中国居民身份证的人像面**，必须能看到清晰的人物头像 + "姓名"、"性别"、"民族"、"出生"、"住址"、"公民身份号码"等中文字段，缺一个关键字段都不算。
3. 身份证反面：图片主体是**一张中国居民身份证的国徽面**，必须能同时看到"中华人民共和国居民身份证"标题 + "签发机关" + "有效期限"中文字段，缺一个都不算。
4. 完税证明：图片主体是**一张完税证明文件**，标题含"完税证明"或"税收完税证明"，包含纳税人、税款等中文字段。
5. 公司章程：图片是**公司章程文档的页面**（通常是 PDF 首页或目录页），命中以下任一关键特征即可判定：
   - 显著位置出现"公司章程"或"章程"作为标题/主标题；
   - 出现"第一章"、"第一章摘要"、"第一章 总则"、"目录"等章程章节性标题。
   备注：公司章程是中文 PDF 渲染出的纯文本页面（白底黑字，无软件 UI 边框），看到大段中文条款 + 章节序号即可视为"文档页面"，**不要**当成 Word/PPT 截图排除掉。
6. 香港公司注册证书：图片主体是**一张香港公司注册证书 (Certificate of Incorporation) 或香港商业登记证 (Business Registration Certificate)**，命中以下任一关键特征即可判定：
   - 出现 "Certificate of Incorporation" 或 "公司註冊證書" 作为主标题；
   - 出现 "Business Registration Certificate" 或 "商業登記證" 作为主标题；
   - 出现 "Hong Kong Special Administrative Region" / "香港特別行政區" + "Companies Registry" / "公司註冊處" 或 "Inland Revenue Department" / "稅務局";
   - 典型特征：繁体中文 + 英文双语排版、公司编号 (Company Number / C.R. No.) 或商业登记号码 (Business Registration Number)。
   **不要**把中国大陆"营业执照"（简体中文 + 红章）误判为本类型——CN 营业执照的标题是"营业执照"而非 "Certificate of Incorporation" / "公司註冊證書"。
7. 护照：图片主体是**一张护照证件信息页**。判定的**核心视觉特征**（满足即可判定为"护照"，无需再核对其他字段）：
   - **图片左半边有一张人物头像照片**（脸部清晰可见的证件照，通常被一层透明覆膜罩住）；并且
   - **照片正上方 / 紧邻照片左上角的位置出现"护照"或"PASSPORT"字样**（中国护照为红色印刷字体，"护照"在上、"PASSPORT"在下）。
   这是世界各国护照证件信息页都遵循的固定排版（ICAO 9303 标准）——左侧贴照片、照片旁标"护照/PASSPORT"是护照最有辨识度的强信号，单独命中即足以判定。

   辅助特征（命中其一可进一步加强信心，但**核心特征**已足够判定，缺这些不影响）：
   - 顶部带有发行国国徽 + 国家全称（中国护照为"中华人民共和国 PEOPLE'S REPUBLIC OF CHINA"，香港特区护照为"中華人民共和國香港特別行政區"）；
   - 双语字段网格排列：类型/Type、国家码/Country Code、护照号码/Passport No.、姓名/Name、性别/Sex、国籍/Nationality、出生日期/Date of birth、签发日期/Date of issue、有效期至/Date of expiry、签发机关/Authority；
   - 底部出现 2 行以 "<<" 大量填充的机读字符（MRZ，例如 "POCHNQIAN<<YING<<<<...")。

   **不要**与身份证混淆——身份证主体上**找不到"护照"或"PASSPORT"字样**，标题永远是"中华人民共和国居民身份证"，字段是"姓名 / 性别 / 民族 / 出生 / 住址 / 公民身份号码"而非"护照号 / 国籍 / 有效期"。

**必须返回"未知类型"的情况（强制）：**
- 网页截图、浏览器界面、后台管理系统、卖家中心、商家中心、表单、Dashboard
- Excel / Word / PPT **软件界面**截图（顶部菜单栏、工具栏可见）、表格列表
- 仅看到证件的某一栏、某个字段、缩略图、预览图
- 看不清完整证件原件、模糊不清、被严重遮挡
- 不满足上述7种类型字段要求的任何图片

**判断步骤（必须严格遵守）：**
1. 先看图片整体：是网页UI还是单一文档？是网页/UI → 直接"未知类型"
2. 再看语言 + 布局：
   - 满屏简体中文 + 红章 + "营业执照"标题 → 候选"营业执照"
   - 繁体中文 / 双语 + "Certificate of Incorporation" 或 "Business Registration Certificate" 或 "公司註冊證書" 或 "商業登記證" → 候选"香港公司注册证书"
   - **图片左半边有人物头像照片 + 照片正上方 / 紧邻位置出现 "护照" 或 "PASSPORT" 字样** → 候选"护照"（这是护照的固定排版，命中即判定，无需再找 MRZ 或全部字段）
   - 满屏英文但不符合 HK 证书 / 护照特征 → "未知类型"
3. 最后核对该类型要求的字段是否**全部**可见，缺任何一个 → "未知类型"
4. 公司章程例外：只要命中"章程"标题或"第一章"等章节标题之一即可返回"公司章程"
5. 护照例外：只要命中"左侧人像 + 相邻位置的 '护照' / 'PASSPORT' 字样"核心特征即可返回"护照"，不必额外核对其他字段

只输出以下之一，不要任何解释、不要任何标点：
营业执照
身份证正面
身份证反面
完税证明
公司章程
香港公司注册证书
护照
未知类型

绝对严禁编造，宁可错判为"未知类型"也不要乱猜。`;

    try {
      const response = await fetchMoonshotChat({
        model: "kimi-k2.6",
        messages: [{
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${fileData}` }
            },
            {
              type: "text",
              text: prompt
            }
          ]
        }],
        thinking: { type: "disabled" }
      }, "AI");

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        const msg = describeMoonshotError(response.status, errText);
        console.error("AI API error:", response.status, response.statusText, errText);
        // 抛出而非吞掉：让 detectFiles 的 catch 把具体原因展示给用户。
        throw new Error(msg);
      }

      const data = await response.json();
      const content = data.choices[0]?.message?.content?.trim() || "";

      // Map AI response to label.
      // 注意：键是 AI 文本包含的关键子串，值是回传给 tryMatch 的 label（需与
      // requirements.json files[].label 精确相等）。
      // "香港公司注册证书" → "香港公司注册证书CR"：AI 输出短标签，映射到 France|HongKong
      // 配置里的带 "CR" 后缀的 label，避免 AI 必须精确复读 "CR" 二字。
      // "香港公司注册证书" 放在 "营业执照" 之前：includes() 是子串匹配，万一 AI 违反
      // prompt 返回了完整句子（含两个关键词），更具体的 HK 标签先命中更安全。
      const typeMapping = {
        '香港公司注册证书': '香港公司注册证书CR',
        '营业执照': '营业执照',
        '身份证正面': '身份证正面',
        '身份证反面': '身份证反面',
        '完税证明': '完税证明',
        '公司章程': '公司章程',
        '护照': '护照',
        '未知类型': null
      };

      for (const [key, value] of Object.entries(typeMapping)) {
        if (content.includes(key)) {
          return value;
        }
      }
      return null;
    } catch (e) {
      // 网络错误 / 主动抛出的 HTTP 错误 都直接传给上层
      console.error("AI detection error:", e);
      throw e;
    }
  }

  // --- Step 1: Populate country dropdown ---
  // 只列出 requirements 里实际配置过的国家（从组合 key "Country|Registration" 提取并去重）。
  // 这样用户永远不会选到一个没有任何组合配置的国家，避免落到红色 "该组合暂无配置" 警告。
  function getConfiguredCountries() {
    const set = new Set();
    for (const reqKey of Object.keys(config.requirements || {})) {
      const country = reqKey.split("|")[0];
      if (country && config.countries[country]) set.add(country);
    }
    return set;
  }

  // 给定国家，返回该国家在 requirements 里出现过的注册地列表（保留首次出现顺序）。
  function getRegistrationsForCountry(countryKey) {
    const list = [];
    const seen = new Set();
    for (const reqKey of Object.keys(config.requirements || {})) {
      const [c, r] = reqKey.split("|");
      if (c === countryKey && r && config.registrations[r] && !seen.has(r)) {
        seen.add(r);
        list.push(r);
      }
    }
    return list;
  }

  function initCountrySelect() {
    const configured = getConfiguredCountries();
    Object.keys(config.countries).forEach(key => {
      if (!configured.has(key)) return;
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = config.countries[key].label;
      countrySelect.appendChild(opt);
    });
  }

  countrySelect.addEventListener("change", () => {
    const countryKey = countrySelect.value;
    registrationSelect.innerHTML = "";

    if (!countryKey) {
      registrationSelect.disabled = true;
      registrationSelect.innerHTML = '<option value="">-- 请先选择国家 --</option>';
      currentReqConfig = null;
      updateValidateBtn();
      saveState();
      return;
    }

    const regKeys = getRegistrationsForCountry(countryKey);
    registrationSelect.disabled = false;
    registrationSelect.innerHTML = '<option value="">-- 请选择注册地 --</option>';

    regKeys.forEach(key => {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = config.registrations[key].label;
      registrationSelect.appendChild(opt);
    });

    if (regKeys.length === 1) {
      registrationSelect.value = regKeys[0];
      registrationSelect.dispatchEvent(new Event("change"));
      // registration change handler already set currentReqConfig, don't reset
      saveState();
      return;
    }

    currentReqConfig = null;
    updateValidateBtn();
    saveState();
  });

  registrationSelect.addEventListener("change", () => {
    const countryKey = countrySelect.value;
    const regKey = registrationSelect.value;
    const warningEl = document.getElementById("no-config-warning");

    if (!countryKey || !regKey) {
      currentReqConfig = null;
      warningEl.style.display = "none";
      updateValidateBtn();
      saveState();
      return;
    }

    const reqKey = `${countryKey}|${regKey}`;
    currentReqConfig = config.requirements[reqKey] || null;

    warningEl.style.display = currentReqConfig ? "none" : "";
    updateValidateBtn();
    hideResults();
    saveState();
  });

  // --- Step 2: Folder upload ---

  // Drag-and-drop on upload area
  uploadArea.addEventListener("dragover", e => {
    e.preventDefault();
    e.stopPropagation();
    uploadArea.classList.add("drag-over");
  });

  uploadArea.addEventListener("dragleave", e => {
    e.preventDefault();
    e.stopPropagation();
    uploadArea.classList.remove("drag-over");
  });

  uploadArea.addEventListener("drop", e => {
    e.preventDefault();
    e.stopPropagation();
    uploadArea.classList.remove("drag-over");
    // Clear previous results and detection log when re-uploading
    uploadedFiles = [];
    placeholderState = {};
    hideResults();
    clearStatus();
    handleDroppedFiles(e.dataTransfer);
  });

  function handleDroppedFiles(dataTransfer) {
    const files = [];
    const folderNames = [];
    if (dataTransfer.items) {
      for (let i = 0; i < dataTransfer.items.length; i++) {
        const entry = dataTransfer.items[i].webkitGetAsEntry && dataTransfer.items[i].webkitGetAsEntry();
        if (entry && entry.isFile) {
          const f = dataTransfer.files[i];
          if (!f.name.startsWith(".")) {
            files.push({ name: f.name, path: f.name, size: f.size, file: f });
          }
        } else if (entry && entry.isDirectory) {
          // Directory entry - read recursively
          folderNames.push(entry.name);
          readDirectoryEntry(entry, files);
        } else {
          const f = dataTransfer.files[i];
          if (f && !f.name.startsWith(".")) {
            files.push({ name: f.name, path: f.name, size: f.size, file: f });
          }
        }
      }
    } else {
      for (let i = 0; i < dataTransfer.files.length; i++) {
        const f = dataTransfer.files[i];
        if (!f.name.startsWith(".")) {
          files.push({ name: f.name, path: f.name, size: f.size, file: f });
        }
      }
    }

    // If we found files directly, save them
    if (files.length > 0) {
      uploadedFiles = files; // File objects kept in-memory only
      droppedFolderNames = folderNames;
      saveState(); // saves metadata only
      updateFileCount();
      updateValidateBtn();
      hideResults();
    } else if (folderNames.length > 0) {
      // 文件夹已识别但目录读取是异步的，先把文件夹名存下来，等异步回调里 updateFileCount 时就能显示
      droppedFolderNames = folderNames;
    }
  }

  function readDirectoryEntry(dirEntry, filesList) {
    const reader = dirEntry.createReader();
    reader.readEntries(entries => {
      for (const entry of entries) {
        if (entry.isFile) {
          entry.file(f => {
            if (!f.name.startsWith(".")) {
              filesList.push({ name: f.name, path: dirEntry.name + "/" + f.name, size: f.size, file: f });
              // Trigger update after async file read
              uploadedFiles = filesList; // File objects kept in-memory only
              saveState(); // saves metadata only
              updateFileCount();
              updateValidateBtn();
            }
          });
        } else if (entry.isDirectory) {
          readDirectoryEntry(entry, filesList);
        }
      }
    });
  }


  function updateFileCount() {
    if (uploadedFiles.length > 0) {
      fileCount.style.display = "flex";
      const folderPart = droppedFolderNames.length > 0
        ? `📁 ${droppedFolderNames.join("、")}  ·  `
        : "";
      fileCountText.textContent = `${folderPart}已选择 ${uploadedFiles.length} 个文件`;
      uploadArea.classList.add("has-files");
    } else {
      fileCount.style.display = "none";
      uploadArea.classList.remove("has-files");
    }
  }

  clearFilesBtn.addEventListener("click", () => {
    uploadedFiles = [];
    droppedFolderNames = [];
    placeholderState = {};
    uploadArea.classList.remove("has-files");
    updateFileCount();
    updateValidateBtn();
    hideResults();
  });

  // --- Step 3: Validate ---
  function updateValidateBtn() {
    validateBtn.disabled = !(apiKey && currentReqConfig && uploadedFiles.length > 0);
    validateBtn.title = apiKey ? "" : "请先在「⚙️ 配置」tab 配置 API Key";
  }

  // 没有 API Key 时全面禁用主功能 tab 的入口按钮，并显示顶部 banner。
  // 任何能改 apiKey 状态的位置（保存 / 清除 / 初始加载）都应调用本函数。
  function updateApiKeyGating() {
    const hasKey = !!apiKey;
    const warningEl = document.getElementById("api-key-warning");
    if (warningEl) warningEl.style.display = hasKey ? "none" : "";

    const tip = "请先在「⚙️ 配置」tab 配置 API Key";
    const gateBtn = (id) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.disabled = !hasKey;
      btn.title = hasKey ? "" : tip;
    };
    gateBtn("clear-form-btn");
    gateBtn("autofill-btn");
    gateBtn("signature-inject-btn");
    gateBtn("signature-regen-btn");
    // validate-btn 还要满足"已选国家+已上传文件"，交给 updateValidateBtn 处理
    updateValidateBtn();
  }

  validateBtn.addEventListener("click", async () => {
    if (!apiKey) {
      statusLog("❌ 请先在「⚙️ 配置」tab 配置 API Key");
      return;
    }
    if (!currentReqConfig || uploadedFiles.length === 0) return;
    validateBtn.disabled = true;
    validateBtn.textContent = "⏳ AI识别中...";
    try {
      await runValidation();
    } finally {
      validateBtn.disabled = false;
      validateBtn.textContent = "🔍 开始检查";
    }
  });

  // Autofill button click handler
  document.getElementById("autofill-btn").addEventListener("click", runAutofill);

  // 清空整页表单 按钮
  document.getElementById("clear-form-btn").addEventListener("click", runClearForm);

  // 签名面板：绑定输入框 / 重新生成 / 注入按钮（仅绑定一次，避免重复事件）
  setupSignaturePanel();

  // 委托书圆章面板：绑定输入控件 + 生成 / 下载 / 重置按钮（仅绑定一次）
  setupPoaSealPanel();

  // 顶部 tabs（主功能 / 配置）
  // 注意：配置 tab 的 API Key 表单 setupConfigForm() 必须放到 await loadApiKey() 之后，
  // 否则它会在 apiKey 还是空字符串时就把 input.value 填成 ""，
  // 导致用户重开 popup 时配置 tab 看起来"没保存过"（实际 storage 里有）。
  setupTabs();

  // Status logger that writes to UI
  function statusLog(msg) {
    const el = document.getElementById("detection-status");
    el.style.display = "";
    const line = document.createElement("div");
    line.textContent = msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    console.log(msg);
  }

  function clearStatus() {
    const el = document.getElementById("detection-status");
    el.innerHTML = "";
    el.style.display = "none";
  }

  // --- Field modules config ---
  // 模块定义现在从 requirements.json 的当前组合（currentReqConfig.modules）读取，
  // 通过 getCurrentModules() 获取。支持的 source 见 ARCHITECTURE.md §2.1：
  //   xlsx                       — read from 基础信息表 cell (A1 notation, e.g. "C3")
  //   file_path                  — file path of a detected requirement (by label)
  //   ai_license                 — AI-extracted field from 营业执照 image
  //   ai_idcard_front            — AI-extracted field from 身份证正面 image
  //   ai_idcard_back             — AI-extracted field from 身份证反面 image
  //   platform_from_url          — derive "主要销售平台" from a xlsx 店铺链接 cell (urlCell):
  //                                  aliexpress→速卖通 / amazon→亚马逊 / temu→Temu / tiktok→TikTok / 其他→其他
  //   postal_from_idcard_address — 根据身份证地址查邮编
  //   idcard_or_passport         — 根据是否检测到身份证返回 "法人身份证"
  //   default                    — hardcoded default value (字段 value)
  // 任何字段都可以加 defaultValue，作为取不到值时的兜底。

  // Read xlsx file once and return a sheet object (or null)
  async function loadXlsxSheet(file) {
    const arrayBuffer = await file.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: "array" });
    const firstSheetName = workbook.SheetNames[0];
    return workbook.Sheets[firstSheetName] || null;
  }

  function getXlsxCell(sheet, cellAddr) {
    if (!sheet) return "";
    const cell = sheet[cellAddr];
    if (!cell) return "";
    const value = cell.v !== undefined ? String(cell.v) : (cell.w || "");
    return value.trim();
  }

  // Normalize 登记机关: ensure it has full 省+市(+区/县) prefix, using 住所 as reference.
  // Also dedupe cases like '浙江省金华市' + '金华市市场监督管理局' → '浙江省金华市市场监督管理局'.
  const PROVINCE_NAMES = [
    "北京市", "天津市", "上海市", "重庆市",
    "河北省", "山西省", "辽宁省", "吉林省", "黑龙江省", "江苏省", "浙江省",
    "安徽省", "福建省", "江西省", "山东省", "河南省", "湖北省", "湖南省",
    "广东省", "海南省", "四川省", "贵州省", "云南省", "陕西省", "甘肃省",
    "青海省", "台湾省",
    "内蒙古自治区", "广西壮族自治区", "西藏自治区", "宁夏回族自治区", "新疆维吾尔自治区",
    "香港特别行政区", "澳门特别行政区"
  ];

  // 不设区地级市：这 5 个地级市直辖镇/街道，没有 区/县 级行政区，因此 antd
  // cascader 在选完省+市之后第 3 级直接列出 镇/街道。splitAddressIntoRegionAndDetail
  // 对这些 city 需要把后续的 "XX镇 / XX街道" 抠出来作为 district，否则 cascader
  // 无法点到 leaf，antd 永远不会 commit 值。
  const PREFECTURES_WITHOUT_DISTRICTS = ["东莞市", "中山市", "嘉峪关市", "三沙市", "儋州市"];

  // 根据中文地址查询邮政编码：优先按区/县命中，其次按地级市，最后按省兜底。
  // 数据来自 libs/postal-codes.js (window.CHINA_POSTAL_CODES)。
  //
  // 难点：身份证住址常见省份缩写（如 "广西" 而非 "广西壮族自治区"），splitAddressPrefix
  // 无法识别就会把 "广西来宾市" 整段贪婪匹配为 city，导致 map 命中失败。
  // 兜底方案：在原文里全局抠出所有 "XX区/县" 与 "XX市/州/地区/盟" token，
  // 逐个直查 map；对于 city token 还尝试去掉 1-3 个汉字前缀（处理 "广西来宾市" → "来宾市"）。
  function getPostalCodeForAddress(address) {
    if (!address) return "";
    const map = (typeof window !== "undefined" && window.CHINA_POSTAL_CODES) || {};
    const addr = String(address).trim();

    // 第一步：结构化解析（地址带完整省名前缀时最可靠）
    const { province, city, district } = splitAddressPrefix(addr);
    const tryKeys = [];
    if (district) tryKeys.push(district);
    if (city) tryKeys.push(city);
    if (province) tryKeys.push(province);
    for (const k of tryKeys) {
      if (map[k]) return map[k];
    }

    // 第二步：扫原文的"区/县"token（最具体，优先）
    const districtTokens = addr.match(/[\u4e00-\u9fa5]{2,8}?(?:区|县|旗|自治县|自治旗)/g) || [];
    for (const t of districtTokens) {
      if (map[t]) return map[t];
    }

    // 第三步：扫原文的"市/州/地区/盟"token，含截前缀重试（处理省份缩写粘连）
    const cityTokens = addr.match(/[\u4e00-\u9fa5]{2,8}?(?:市|自治州|地区|盟)/g) || [];
    for (const t of cityTokens) {
      if (map[t]) return map[t];
      for (let cut = 1; cut <= 3 && cut < t.length; cut++) {
        const sub = t.slice(cut);
        if (map[sub]) return map[sub];
      }
    }

    return "";
  }

  function splitAddressPrefix(address) {
    // Returns { province, city, district } extracted from the start of the address.
    if (!address) return { province: "", city: "", district: "" };
    const addr = String(address).trim();
    let province = "";
    let rest = addr;
    for (const p of PROVINCE_NAMES) {
      if (addr.startsWith(p)) {
        province = p;
        rest = addr.slice(p.length);
        break;
      }
    }
    // City: match up to next 市 / 自治州 / 地区 / 盟
    let city = "";
    const cityMatch = rest.match(/^([^省市区县旗]{1,10}?(?:市|自治州|地区|盟))/);
    if (cityMatch) {
      city = cityMatch[1];
      rest = rest.slice(city.length);
    }
    // District / county level
    let district = "";
    const distMatch = rest.match(/^([^省市区县旗]{1,10}?(?:市|区|县|旗|自治县))/);
    if (distMatch) {
      district = distMatch[1];
    }
    // 县级市处理：身份证/营业执照地址常跳过中间的地级市，直接写"浙江省义乌市..."。
    // 此时 city="义乌市"、district=""。我们用 县级市→地级市 反向映射把 city 升回正确的
    // 地级市，把原 city 降为 district。这样下游 cascader 才能选到正确的省/市/区三级。
    const parents = (typeof window !== "undefined" && window.CHINA_COUNTY_LEVEL_CITY_PARENTS) || {};
    if (city && !district && parents[city]) {
      district = city;
      city = parents[city];
    }
    // 省缺失时反查：地址省略省份时（如"广州市白云区..."）补上省级，
    // 供 normalizeRegistrationAuthority 等下游使用。
    if (!province && city) {
      const provMap = (typeof window !== "undefined" && window.CHINA_PREFECTURE_TO_PROVINCE) || {};
      if (provMap[city]) province = provMap[city];
    }
    return { province, city, district };
  }

  // Split a full address into a cascader-friendly "省 / 市 / 区" region string and the
  // remaining detail (street / building). Used when a form has both a 省市区 cascader
  // and a "详细地址，无需重复输入省市区信息" textarea (e.g. 公司/个体经营注册地址(中文)).
  function splitAddressIntoRegionAndDetail(address) {
    if (!address) return { region: "", detail: "" };
    const addr = String(address).trim();
    let province = "";
    let rest = addr;
    for (const p of PROVINCE_NAMES) {
      if (addr.startsWith(p)) {
        province = p;
        rest = addr.slice(p.length);
        break;
      }
    }
    let city = "";
    const cityMatch = rest.match(/^([^省市区县旗]{1,10}?(?:市|自治州|地区|盟))/);
    if (cityMatch) {
      city = cityMatch[1];
      rest = rest.slice(city.length);
    }
    let district = "";
    const distMatch = rest.match(/^([^省市区县旗]{1,10}?(?:市|区|县|旗|自治县))/);
    if (distMatch) {
      district = distMatch[1];
      rest = rest.slice(district.length);
    }
    // 县级市处理（同 splitAddressPrefix）：把"浙江省义乌市XXX路"补全为
    // "浙江省 / 金华市 / 义乌市 / XXX路"，让 cascader 能选完整三级。
    const parents = (typeof window !== "undefined" && window.CHINA_COUNTY_LEVEL_CITY_PARENTS) || {};
    if (city && !district && parents[city]) {
      district = city;
      city = parents[city];
    }
    // 不设区地级市处理：东莞市 / 中山市 / 嘉峪关市 / 三沙市 / 儋州市 这 5 个地级市下
    // 没有 区/县，cascader 第 3 级直接是 镇/街道。若地址形如"广东省东莞市虎门镇..."
    // 时 district 仍为空，导致 region 只有省+市两级，handleCascader 选不到 leaf →
    // antd 永远不会 commit 值（日志看上去"已选广东省/东莞市"实则没写入）。
    // 此处把后续的"XX镇 / XX街道"抠出来作为 district（cascader level-2）。
    // 注意 1：刻意不把"乡"加进后缀，避免"三乡镇"被贪婪地切成"三乡"。
    // 注意 2：把"镇镇"放在"镇"之前，避免中山市的"古镇镇"被切成"古镇"（漏掉第二个镇）；
    //         regex alternation 是左到右优先匹配。
    if (city && !district && PREFECTURES_WITHOUT_DISTRICTS.includes(city)) {
      const townshipMatch = rest.match(/^([^省市区县旗]{1,10}?(?:街道|镇镇|镇))/);
      if (townshipMatch) {
        district = townshipMatch[1];
        rest = rest.slice(district.length);
      }
    }
    // 省缺失时反查：身份证/营业执照地址常省略省份（如"广州市白云区..."），
    // cascader 第 1 级必须是省，否则会抛 `cascader 第 1 级匹配不到`。
    // 用地级市→省 反向表补全省级，让 cascader 能定位完整三级。
    if (!province && city) {
      const provMap = (typeof window !== "undefined" && window.CHINA_PREFECTURE_TO_PROVINCE) || {};
      if (provMap[city]) province = provMap[city];
    }
    const region = [province, city, district].filter(Boolean).join(" / ");
    // 清理 detail：末尾常跟一段 6 位邮编（如 "民治街道上油松79栋805室 518000"），
    // cascader 选完 + 邮编已单独入框，detail 里不再需要保留这段数字。
    const detail = rest.trim().replace(/[\s　]+\d{6}\s*$/, "").trim();
    return { region, detail };
  }

  // HK 18 行政区 → 关键词列表。每个区可由多个街区/地标关键词命中（如"旺角"→油尖旺区）。
  // 维护原则：每个区第一项是区名本身，后续按"该区里出现频率最高的街区/地标"列出。
  // 顺序决定优先级：列在前面的区先匹配；如果同一地址同时含"旺角"和"九龙塘"，按本表顺序裁判。
  // 英文地址不做匹配（太多拼写 / 大小写变体），直接走默认值分支（见 HK_DEFAULT_DISTRICT）。
  const HK_DISTRICTS = [
    { name: "中西区",   keywords: ["中西区", "中环", "上环", "西环", "西营盘", "半山", "山顶", "坚尼地城", "石塘咀", "金钟"] },
    { name: "湾仔区",   keywords: ["湾仔区", "湾仔", "铜锣湾", "跑马地", "大坑", "渣甸山"] },
    { name: "东区",     keywords: ["北角", "鲗鱼涌", "鯽鱼涌", "太古城", "太古", "西湾河", "筲箕湾", "柴湾", "小西湾", "杏花邨"] },
    { name: "南区",     keywords: ["南区", "香港仔", "鸭脷洲", "黄竹坑", "浅水湾", "赤柱", "石澳", "薄扶林", "数码港"] },
    { name: "油尖旺区", keywords: ["油尖旺区", "油尖旺", "油麻地", "尖沙咀", "尖沙嘴", "旺角", "大角咀", "佐敦"] },
    { name: "深水埗区", keywords: ["深水埗区", "深水埗", "长沙湾", "美孚", "荔枝角", "石硖尾", "又一村", "太子"] },
    { name: "九龙城区", keywords: ["九龙城区", "九龙城", "红磡", "紅磡", "土瓜湾", "何文田", "启德", "九龙塘", "黄埔"] },
    { name: "黄大仙区", keywords: ["黄大仙区", "黄大仙", "钻石山", "慈云山", "新蒲岗", "乐富", "横头磡", "彩虹", "牛池湾"] },
    { name: "观塘区",   keywords: ["观塘区", "观塘", "牛头角", "九龙湾", "蓝田", "油塘", "秀茂坪"] },
    { name: "葵青区",   keywords: ["葵青区", "葵涌", "青衣", "葵芳", "荔景"] },
    { name: "荃湾区",   keywords: ["荃湾区", "荃湾", "梨木树", "汀九", "深井", "马湾"] },
    { name: "屯门区",   keywords: ["屯门区", "屯门"] },
    { name: "元朗区",   keywords: ["元朗区", "元朗", "天水围", "锦田", "八乡", "流浮山", "新田"] },
    { name: "北区",     keywords: ["上水", "粉岭", "沙头角", "打鼓岭"] },
    { name: "大埔区",   keywords: ["大埔区", "大埔", "太和", "大埔滘", "林村"] },
    { name: "沙田区",   keywords: ["沙田区", "沙田", "大围", "火炭", "马鞍山", "乌溪沙", "第一城"] },
    { name: "西贡区",   keywords: ["西贡区", "西贡", "将军澳", "调景岭", "坑口", "宝林", "康城"] },
    { name: "离岛区",   keywords: ["离岛区", "离岛", "大屿山", "长洲", "南丫", "坪洲", "东涌", "愉景湾", "赤鱲角", "迪士尼"] },
  ];

  // 关键词都命中不到时（例如全英文地址 "UNIT 34 ... TUEN MUN NT 999077 HK"）的默认区。
  // cascader 里随便选一个合规的区让后续流程能跑通比让用户手动挑更重要。
  const HK_DEFAULT_DISTRICT = "九龙城区";

  // 把香港地址（如"香港旺角花園街2-16號..."）拆成 cascader 三级 region + 详细 detail。
  // 卖家中心 cascader：第 1 级"香港特别行政区"，第 2 级再选一次"香港特别行政区"，第 3 级 18 区。
  //
  // 例：
  //   in:  "香港旺角花園街2-16 號好景商業中心5 樓502C 室"
  //   out: { region: "香港特别行政区 / 香港特别行政区 / 油尖旺区",
  //          detail: "旺角花園街2-16 號好景商業中心5 樓502C 室" }
  //
  // 设计取舍：
  //   - 区归属用关键词匹配（不依赖完整书写"油尖旺区"），扩展时改 HK_DISTRICTS 表即可
  //   - 中英文混合 / 全英文地址匹配不上的，统一落到 HK_DEFAULT_DISTRICT（九龙城区）
  //     ——cascader 必须选到 leaf 才能 commit 值，给个默认让流程能跑通
  //   - detail 保留原文（仅剥首部"中国/香港"等省级前缀和"九龙/新界/港岛"大区前缀）
  function splitHkAddressIntoRegionAndDetail(address) {
    if (!address) return { region: "", detail: "" };
    let addr = String(address).trim();

    // 剥省级 / 大区前缀；cascader 没有"九龙"/"新界"这一级，要去掉以免污染 detail
    addr = addr
      .replace(/^(中国\s*)?(香港特别行政区|香港)\s*/, "")
      .replace(/^(九龙|新界|港岛|香港岛)\s*/, "");

    let matchedDistrict = "";
    for (const d of HK_DISTRICTS) {
      for (const kw of d.keywords) {
        if (addr.includes(kw)) {
          matchedDistrict = d.name;
          break;
        }
      }
      if (matchedDistrict) break;
    }

    // 没匹配到（多见于全英文地址，如"TUEN MUN / NT / 999077 / HK"）→ 用默认区，
    // detail 仍要 stripHkDetailTail 剥掉尾部邮编 / "HK" / "Hong Kong" 等冗余后缀，
    // 与下面"已匹配"分支保持行为一致（之前漏调用导致英文地址尾部带 999077 HK 落到 textarea）
    if (!matchedDistrict) {
      return {
        region: `香港特别行政区 / 香港特别行政区 / ${HK_DEFAULT_DISTRICT}`,
        detail: stripHkDetailTail(addr),
      };
    }

    // 若开头就是区名（如"油尖旺区旺角XXX"），剥掉区名；否则保留街区名
    let detail = addr;
    if (detail.startsWith(matchedDistrict)) {
      detail = detail.slice(matchedDistrict.length).trim();
    }
    detail = stripHkDetailTail(detail);
    return {
      region: `香港特别行政区 / 香港特别行政区 / ${matchedDistrict}`,
      detail,
    };
  }

  // 清理 HK 详细地址里的尾巴：常见的"…香港 000000" / "…中国 香港" / "… 999077" 等
  // 邮编/地区名后缀。这些信息在 cascader 已选 + 邮编单独入框后属于冗余。
  // 香港邮政体系本身没有邮编（5 位 / 6 位是商家自填的"占位"），但模板里常会带一段，统一剥掉。
  function stripHkDetailTail(s) {
    if (!s) return "";
    let v = String(s).trim();
    for (let i = 0; i < 4; i++) {
      const before = v;
      v = v
        .replace(/[\s　,，、]+\d{3,6}\s*$/, "")           // 末尾 3~6 位数字（含 000000 / 999077）
        .replace(/[\s　,，、]*(中国|香港|香港特别行政区|HK|Hong\s*Kong)\s*$/i, "")
        .trim();
      if (v === before) break;
    }
    return v;
  }

  function normalizeRegistrationAuthority(authority, address) {
    if (!authority) return authority;
    let value = String(authority).trim();
    // Already has a province-level prefix → return as-is.
    for (const p of PROVINCE_NAMES) {
      if (value.startsWith(p)) return value;
    }
    const { province, city, district } = splitAddressPrefix(address || "");
    if (!province) return value; // No way to infer.

    // Build prefix candidates from longest to shortest and dedupe against authority's own leading tokens.
    const prefixParts = [province, city, district].filter(Boolean);
    // Drop the last prefix part(s) that the authority itself already contains at its start.
    // e.g. prefixParts=['浙江省','金华市','义乌市'], authority='义乌市市场监督管理局' → drop '义乌市' → prefix='浙江省金华市'
    // e.g. prefixParts=['浙江省','金华市'], authority='金华市市场监督管理局' → drop '金华市' → prefix='浙江省'
    while (prefixParts.length > 0 && value.startsWith(prefixParts[prefixParts.length - 1])) {
      prefixParts.pop();
      break; // Only dedupe one overlap layer.
    }
    return prefixParts.join("") + value;
  }

  // Generic helper: call Moonshot vision model with an image + prompt and parse JSON response.
  async function callVisionJson(base64Data, mimeType, prompt, tag) {
    if (!apiKey || !base64Data) return {};
    try {
      const response = await fetchMoonshotChat({
        model: "kimi-k2.6",
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mimeType || "image/jpeg"};base64,${base64Data}` } },
            { type: "text", text: prompt }
          ]
        }],
        thinking: { type: "disabled" }
      }, tag);
      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        statusLog(`[${tag}] 失败: ${describeMoonshotError(response.status, errText)}`);
        return {};
      }
      const data = await response.json();
      let content = data.choices[0]?.message?.content?.trim() || "";
      content = content.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
      try {
        return JSON.parse(content);
      } catch (parseErr) {
        statusLog(`[${tag}] JSON解析失败: ${content.substring(0, 80)}...`);
        return {};
      }
    } catch (e) {
      statusLog(`[${tag}] 异常: ${e.message}`);
      return {};
    }
  }

  // AI: extract structured fields from a 身份证正面 (人像面) image
  async function extractIdCardFrontFields(base64Data, mimeType) {
    const prompt = `这是一张中国居民身份证人像面图片。请仔细识别图中的字段，以严格的JSON格式输出以下信息：
{
  "姓名": "姓名原文，例如'张三'、'欧阳娜娜'。",
  "拼音名": "把姓名转为拼音并按以下规则拼接：每个汉字的拼音首字母大写、其余字母小写，整体不加空格、不加连字符、不加分隔符。示例：'张三' → 'ZhangSan'，'李小明' → 'LiXiaoMing'，'欧阳娜娜' → 'OuYangNaNa'。注意多音字按姓名常用读音处理（如'单' 作为姓氏读 'Shan'）。",
  "姓拼音": "姓的拼音（首字母大写其余小写）。注意单姓与复姓的区分：单姓如'张'='Zhang'、'李'='Li'；复姓如'欧阳'='OuYang'、'司马'='SiMa'、'诸葛'='ZhuGe'、'上官'='ShangGuan'、'东方'='DongFang'。示例：'张三'→'Zhang'，'欧阳娜娜'→'OuYang'，'司马懿'→'SiMa'。",
  "名拼音": "名的拼音（每个汉字首字母大写其余小写，整体拼接，无空格无分隔）。示例：'张三'→'San'，'李小明'→'XiaoMing'，'欧阳娜娜'→'NaNa'，'司马懿'→'Yi'。",
  "性别": "性别，只输出'男'或'女'。",
  "民族": "民族字段原文（不含'族'字也保留），例如'汉'、'回'、'藏'、'蒙古'、'维吾尔'、'壮'等。",
  "出生日期": "出生日期，输出格式 YYYY-MM-DD（如 1990-01-15）。",
  "身份证号": "18位身份证号码，纯数字（最后一位可能是X，保持大写）。",
  "住址": "住址字段的完整原文。"
}

只输出JSON对象，不要任何额外解释。每个字段如果识别不到，值为null。`;
    return callVisionJson(base64Data, mimeType, prompt, "AI身份证正面");
  }

  // AI: extract structured fields from a 身份证反面 (国徽面) image
  async function extractIdCardBackFields(base64Data, mimeType) {
    const prompt = `这是一张中国居民身份证国徽面图片。请识别"签发机关"和"有效期限"字段，以严格的JSON格式输出：
{
  "签发机关": "签发机关字段原文，通常是'XX市公安局XX分局'或'XX县公安局'格式，例如'北京市公安局海淀分局'、'义乌市公安局'。",
  "有效期限": "身份证有效期限原文，例如'2020.05.20-2040.05.20'、'2020.05.20-长期'。保持原始分隔符与格式。"
}

只输出JSON对象，不要任何额外解释。每个字段如果识别不到，值为null。`;
    return callVisionJson(base64Data, mimeType, prompt, "AI身份证反面");
  }

  function normalizeDateLike(input) {
    if (input === null || input === undefined) return "";
    const raw = String(input).trim();
    if (!raw) return "";

    let m = raw.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    if (m) {
      return `${m[1]}-${String(+m[2]).padStart(2, "0")}-${String(+m[3]).padStart(2, "0")}`;
    }

    const monthMap = {
      january: 1, jan: 1,
      february: 2, feb: 2,
      march: 3, mar: 3,
      april: 4, apr: 4,
      may: 5,
      june: 6, jun: 6,
      july: 7, jul: 7,
      august: 8, aug: 8,
      september: 9, sept: 9, sep: 9,
      october: 10, oct: 10,
      november: 11, nov: 11,
      december: 12, dec: 12
    };
    m = raw.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
    if (m && monthMap[m[2].toLowerCase()]) {
      return `${m[3]}-${String(monthMap[m[2].toLowerCase()]).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
    }
    m = raw.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
    if (m && monthMap[m[1].toLowerCase()]) {
      return `${m[3]}-${String(monthMap[m[1].toLowerCase()]).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}`;
    }

    const compact = raw.replace(/\s+/g, "");
    const zhDigit = { "零": 0, "〇": 0, "○": 0, "Ｏ": 0, "O": 0, "o": 0, "0": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
    const zhNum = (s) => {
      s = String(s || "").trim();
      if (!s) return NaN;
      if (/^\d+$/.test(s)) return Number(s);
      if (!s.includes("十")) return zhDigit[s] ?? NaN;
      const parts = s.split("十");
      const tens = parts[0] ? (zhDigit[parts[0]] ?? NaN) : 1;
      const ones = parts[1] ? (zhDigit[parts[1]] ?? NaN) : 0;
      return Number.isFinite(tens) && Number.isFinite(ones) ? tens * 10 + ones : NaN;
    };
    m = compact.match(/([零〇○ＯOo0一二两三四五六七八九]{4})年([零〇○ＯOo0一二两三四五六七八九十\d]{1,3})月([零〇○ＯOo0一二两三四五六七八九十\d]{1,3})日/);
    if (m) {
      const year = Array.from(m[1]).map(ch => zhDigit[ch]).join("");
      const month = zhNum(m[2]);
      const day = zhNum(m[3]);
      if (/^\d{4}$/.test(year) && Number.isFinite(month) && Number.isFinite(day)) {
        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    }

    return raw;
  }

  async function translateToChineseIfNeeded(text, tag = "AI翻译") {
    const value = String(text || "").trim();
    if (!value) return "";
    if (/[\u4e00-\u9fff]/.test(value)) return value;
    if (!apiKey) return value;
    try {
      const response = await fetchMoonshotChat({
        model: "kimi-k2.6",
        messages: [{
          role: "user",
          content: `请把下面的地址翻译成简体中文，只输出译文，不要解释，不要加引号：\n${value}`
        }],
        thinking: { type: "disabled" }
      }, tag);
      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        statusLog(`[${tag}] 失败: ${describeMoonshotError(response.status, errText)}`);
        return value;
      }
      const data = await response.json();
      return (data.choices[0]?.message?.content || "").trim().replace(/^["“”']|["“”']$/g, "") || value;
    } catch (e) {
      statusLog(`[${tag}] 异常: ${e.message}`);
      return value;
    }
  }

  // AI: extract the issue/incorporation date from a 香港公司注册证书 CR / 商业登记证 page
  async function extractHkCrFields(base64Data, mimeType) {
    const prompt = `这是一张香港公司注册证书 CR / Certificate of Incorporation 或商业登记证页面。请重点识别证书上的发出日期。

发出日期常见位置和文案：
- 英文："Issued on 7 January 2026."、"Issued on 7 Jan 2026"
- 繁体中文："本 證 明 書 於 二Ｏ二六 年 一 月 七 日 發 出。"

请以严格 JSON 输出：
{
  "发出日期": "证书发出日期，必须转为 YYYY-MM-DD，例如 2026-01-07。",
  "发出日期原文": "证书上日期附近的原文。",
  "公司编号": "Company Number / C.R. No.，识别不到则为 null。"
}

只输出JSON对象，不要任何额外解释。每个字段如果识别不到，值为null。`;
    const fields = await callVisionJson(base64Data, mimeType, prompt, "AI香港CR");
    if (fields && fields.发出日期) fields.发出日期 = normalizeDateLike(fields.发出日期);
    return fields || {};
  }

  // AI: extract structured fields from a passport information page
  async function extractPassportFields(base64Data, mimeType) {
    const prompt = `这是一张护照证件信息页。请根据版面仔细识别字段：左侧通常是头像，旁边/下方有姓名、性别、出生地点、签发地点、签发机关；中间有国籍；右侧有出生日期、签发日期、有效期至；顶端从左到右常见类型、国家码、护照号码。

请以严格 JSON 输出：
{
  "中文名": "如果是中国人护照，输出中文姓名，例如'张三'；如果不是中文姓名或识别不到，输出 null。",
  "姓名": "护照姓名原文；中国护照可输出中文名，外国护照输出英文/拉丁姓名。",
  "拼音名": "中国护照请输出中文名对应拼音，首字母大写且不加空格，例如'张三'→'ZhangSan'；也可直接提取护照姓名下面的拼音。外国护照请输出护照上的英文/拉丁姓名，去掉多余空格，尽量用首字母大写格式。",
  "姓拼音": "姓/Last name/Surname 的拼音或英文，首字母大写；识别不到则 null。",
  "名拼音": "名/Given names 的拼音或英文，首字母大写；识别不到则 null。",
  "护照号": "护照号码/Passport No.，通常在右上角。",
  "出生日期": "Date of birth，输出 YYYY-MM-DD。",
  "签发日期": "Date of issue，输出 YYYY-MM-DD。",
  "有效期至": "Date of expiry，输出 YYYY-MM-DD。",
  "性别": "输出'男'或'女'。若护照为 M/F，请转换为男/女。",
  "国籍": "Nationality / 国籍。",
  "出生地点": "Place of birth / 出生地点。",
  "签发地点": "Place of issue / 签发地点。",
  "签发机关": "Authority / 签发机关。"
}

只输出JSON对象，不要任何额外解释。每个字段如果识别不到，值为null。`;
    const fields = await callVisionJson(base64Data, mimeType, prompt, "AI护照");
    if (fields) {
      for (const k of ["出生日期", "签发日期", "有效期至"]) {
        if (fields[k]) fields[k] = normalizeDateLike(fields[k]);
      }
      if (fields.性别 === "M") fields.性别 = "男";
      if (fields.性别 === "F") fields.性别 = "女";
    }
    return fields || {};
  }

  // AI: extract structured fields from a 营业执照 image
  async function extractBusinessLicenseFields(base64Data, mimeType) {
    if (!apiKey || !base64Data) return {};
    const prompt = `这是一张中国营业执照图片。请仔细识别图中的字段，以严格的JSON格式输出以下信息：
{
  "类型": "公司类型，例如'有限责任公司'、'有限责任公司(自然人投资或控股)'、'个体工商户'、'股份有限公司'等。原样输出执照上写的内容。",
  "成立日期": "成立日期或注册日期，输出格式 YYYY-MM-DD（如 2024-09-15）。如果只有'注册日期'就用注册日期。",
  "核准日期": "核准日期，通常出现在营业执照右下角'登记机关'印章下方，标签可能是'核准日期'、'登记日期'或位于登记机关下方未标注的日期文本。输出格式 YYYY-MM-DD（如 2024-09-15）。如果执照上没有此字段，值为null。**与'成立日期'区分**：成立日期通常在执照左侧字段区，核准日期位于右下角登记机关印章附近。",
  "住所": "执照上'住所'或'经营场所'或'营业场所'字段的完整地址原文，例如'浙江省金华市义乌市XX街道XX号'。",
  "登记机关": "登记机关（或发照机关）的完整名称，必须补全为'省+市+区/县+机关'或'省+市+机关'或'直辖市+区+机关'的完整行政区划前缀格式。请结合执照上'住所'字段里的省/市信息补全前缀，不要重复。示例：\n    - 执照登记机关是'义乌市市场监督管理局'，住所在浙江省金华市义乌市 → 输出'浙江省金华市义乌市市场监督管理局'\n    - 执照登记机关是'金华市市场监督管理局'，住所在浙江省金华市 → 输出'浙江省金华市市场监督管理局'（不要写成'浙江省金华市金华市市场监督管理局'）\n    - 执照登记机关是'海淀区市场监督管理局'，住所在北京市海淀区 → 输出'北京市海淀区市场监督管理局'\n    - 执照登记机关是'广东省市场监督管理局' → 原样输出'广东省市场监督管理局'",
  "注册资本": "注册资本金额，必须转为阿拉伯数字 + '元'结尾。规则：识别执照上的金额（无论是中文大写如'壹佰万元'还是阿拉伯数字如'100万元'），统一换算为元的整数。例如：'壹佰万元整' → '1000000元'，'100万元人民币' → '1000000元'，'5000万元' → '50000000元'，'壹拾万元' → '100000元'。如果执照上没有此字段（个体工商户通常没有），值为null。"
}

只输出JSON对象，不要任何额外解释。每个字段如果识别不到，值为null。`;
    try {
      const response = await fetchMoonshotChat({
        model: "kimi-k2.6",
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mimeType || "image/jpeg"};base64,${base64Data}` } },
            { type: "text", text: prompt }
          ]
        }],
        thinking: { type: "disabled" }
      }, "AI提取");
      if (!response.ok) {
        statusLog(`[AI提取] 失败: HTTP ${response.status}`);
        return {};
      }
      const data = await response.json();
      let content = data.choices[0]?.message?.content?.trim() || "";
      // Strip ```json fences if present
      content = content.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
      try {
        return JSON.parse(content);
      } catch (parseErr) {
        statusLog(`[AI提取] JSON解析失败: ${content.substring(0, 80)}...`);
        return {};
      }
    } catch (e) {
      statusLog(`[AI提取] 异常: ${e.message}`);
      return {};
    }
  }

  // Compose all module data given the detection result
  async function buildModuleData(result) {
    // Source: xlsx sheet
    let sheet = null;
    const xlsxFound = result.found.find(f => f.key === "basic_info");
    if (xlsxFound && xlsxFound.file && xlsxFound.file.file instanceof File) {
      try {
        sheet = await loadXlsxSheet(xlsxFound.file.file);
      } catch (e) {
        statusLog(`[解析] xlsx 失败: ${e.message}`);
      }
    }

    // Source: AI license fields (only call if 营业执照 has imageData)
    let aiLicense = {};
    const licenseFound = result.found.find(f => f.key === "business_license");
    if (licenseFound && licenseFound.imageData) {
      statusLog(`[AI提取] 解析营业执照字段...`);
      const t0 = Date.now();
      aiLicense = await extractBusinessLicenseFields(licenseFound.imageData, licenseFound.mimeType);
      statusLog(`[AI提取] 完成（${Date.now() - t0}ms）`);
      // Ensure 登记机关 carries full 省+市(+区) prefix; fall back to 住所 if AI forgot.
      if (aiLicense && aiLicense.登记机关) {
        const before = String(aiLicense.登记机关);
        const after = normalizeRegistrationAuthority(before, aiLicense.住所);
        if (after !== before) {
          statusLog(`[规范化] 登记机关: ${before} → ${after}`);
        }
        aiLicense.登记机关 = after;
      }
    }

    // Source: AI 身份证正面 fields
    let aiIdCardFront = {};
    const idFrontFound = result.found.find(f => f.key === "id_card_front");
    if (idFrontFound && idFrontFound.imageData) {
      statusLog(`[AI提取] 解析身份证正面字段...`);
      const t0 = Date.now();
      aiIdCardFront = await extractIdCardFrontFields(idFrontFound.imageData, idFrontFound.mimeType);
      statusLog(`[AI提取] 完成（${Date.now() - t0}ms）`);
    }

    // Source: AI 身份证反面 fields
    let aiIdCardBack = {};
    const idBackFound = result.found.find(f => f.key === "id_card_back");
    if (idBackFound && idBackFound.imageData) {
      statusLog(`[AI提取] 解析身份证反面字段...`);
      const t0 = Date.now();
      aiIdCardBack = await extractIdCardBackFields(idBackFound.imageData, idBackFound.mimeType);
      statusLog(`[AI提取] 完成（${Date.now() - t0}ms）`);
    }

    // Source: AI 香港公司注册证书 CR fields
    let aiHkCr = {};
    const hkCrFound = result.found.find(f => f.key === "hk_business_registration");
    if (hkCrFound && hkCrFound.imageData) {
      statusLog(`[AI提取] 解析香港公司注册证书CR字段...`);
      const t0 = Date.now();
      aiHkCr = await extractHkCrFields(hkCrFound.imageData, hkCrFound.mimeType);
      statusLog(`[AI提取] 完成（${Date.now() - t0}ms）`);
    }

    // Source: AI 护照 fields
    let aiPassport = {};
    const passportFound = result.found.find(f => f.key === "passport");
    if (passportFound && passportFound.imageData) {
      statusLog(`[AI提取] 解析护照字段...`);
      const t0 = Date.now();
      aiPassport = await extractPassportFields(passportFound.imageData, passportFound.mimeType);
      statusLog(`[AI提取] 完成（${Date.now() - t0}ms）`);
    }

    // 持久化原始 AI 结果，供后续 buildAutofillPlan 使用（如 姓拼音 / 名拼音 不在显示模块里）
    lastAiData = {
      license: aiLicense || {},
      idCardFront: aiIdCardFront || {},
      idCardBack: aiIdCardBack || {},
      hkCr: aiHkCr || {},
      passport: aiPassport || {}
    };

    // Document-type label for "上传法人代表证件信息":
    // - If either side of 身份证 is detected → "法人身份证"
    // - If passport is detected → "法人护照"
    const idCardOrPassportLabel = (idFrontFound || idBackFound) ? "法人身份证" : (passportFound ? "法人护照" : "");

    // identityFlow 驱动字段级 showIf 过滤：
    //   "idcard"   → 只上传身份证 或 同时上传身份证+护照（优先身份证，与 identity_field 判断一致）
    //   "passport" → 只上传护照
    //   ""         → 都没上传 / 未知：保持现状，所有字段都显示（不过滤）
    // 在 requirements.json 的模块字段里加 "showIf": "idcard" / "passport" 可控制该字段是否渲染；
    // 不加 showIf 的字段永远显示（例如 identity_field 源的通用字段：中文名/拼音名/出生日期/性别）
    const identityFlow = (idFrontFound || idBackFound) ? "idcard" : (passportFound ? "passport" : "");

    // Build modules
    const modulesData = [];
    for (const mod of getCurrentModules()) {
      const fields = [];
      for (const f of mod.fields) {
        // showIf 过滤：仅当该字段声明了 showIf 且当前 identityFlow 明确不匹配时跳过。
        // identityFlow 为空（未检测到任何证件）时不过滤，让用户看到完整字段列表。
        if (f.showIf && identityFlow && f.showIf !== identityFlow) continue;
        let value = "";
        switch (f.source) {
          case "xlsx":
            value = getXlsxCell(sheet, f.cell);
            // fallbackCell：主 cell 取不到值时，按声明顺序依次尝试备选 cell。
            // 支持单个字符串（"C4"）或数组（["C4","D3"]）。用于 法国|香港 公司名称：
            // C3 留空时回退 C4，避免 xlsx 模板里 C3/C4 哪个被填都能命中。
            if ((!value || !value.trim()) && f.fallbackCell) {
              const fallbacks = Array.isArray(f.fallbackCell) ? f.fallbackCell : [f.fallbackCell];
              for (const cell of fallbacks) {
                const v = getXlsxCell(sheet, cell);
                if (v && v.trim()) { value = v; break; }
              }
            }
            break;
          case "file_path": {
            const item = result.found.find(x => x.key === f.fileKey);
            value = item && item.file ? (item.file.path || item.file.name || "") : "";
            break;
          }
          case "ai_license":
            value = aiLicense[f.aiField] != null ? String(aiLicense[f.aiField]) : "";
            break;
          case "ai_idcard_front":
            value = aiIdCardFront[f.aiField] != null ? String(aiIdCardFront[f.aiField]) : "";
            break;
          case "ai_idcard_back":
            value = aiIdCardBack[f.aiField] != null ? String(aiIdCardBack[f.aiField]) : "";
            break;
          case "ai_hk_cr":
            value = aiHkCr[f.aiField] != null ? String(aiHkCr[f.aiField]) : "";
            break;
          case "ai_passport":
            value = aiPassport[f.aiField] != null ? String(aiPassport[f.aiField]) : "";
            break;
          case "identity_field": {
            const usingPassport = !!passportFound && !(idFrontFound || idBackFound);
            const src = usingPassport ? aiPassport : aiIdCardFront;
            const fieldName = usingPassport ? f.passportField : f.idField;
            value = src && src[fieldName] != null ? String(src[fieldName]) : "";
            break;
          }
          case "passport_validity": {
            const issue = aiPassport["签发日期"] ? String(aiPassport["签发日期"]) : "";
            const expiry = aiPassport["有效期至"] ? String(aiPassport["有效期至"]) : "";
            value = issue && expiry ? `${issue} - ${expiry}` : (expiry || "");
            break;
          }
          case "postal_from_idcard_address": {
            const addr = aiIdCardFront["住址"] != null ? String(aiIdCardFront["住址"]) : "";
            value = getPostalCodeForAddress(addr);
            if (addr && !value) {
              statusLog(`[邮编] 未能从住址解析出邮编: "${addr}"`);
            } else if (value) {
              statusLog(`[邮编] 身份证地址 → ${value}（来源住址: "${addr}"）`);
            }
            break;
          }
          case "idcard_or_passport":
            value = idCardOrPassportLabel;
            break;
          case "xlsx_translate_to_zh":
            value = await translateToChineseIfNeeded(getXlsxCell(sheet, f.cell));
            break;
          case "platform_from_url": {
            // 根据 基础信息表 里的店铺链接 cell 派生"主要销售平台"：
            //   - 链接含 'amazon'     → '亚马逊'   (e.g. amazon.fr/sp?...&seller=...)
            //   - 链接含 'temu'       → 'Temu'     (e.g. temu.com/mall.html?mall_id=...)
            //   - 链接含 'aliexpress' → '速卖通'   (e.g. aliexpress.ru/store/...)
            //   - 链接含 'tiktok'     → 'TikTok'   (e.g. seller.eu.tiktokshopglobalselling.com/...)
            //   - 其它非空链接         → '其他'
            //   - 空链接               → ''（让 defaultValue 兜底）
            const url = (getXlsxCell(sheet, f.urlCell) || "").toLowerCase();
            if (!url) value = "";
            else if (url.includes("amazon")) value = "亚马逊";
            else if (url.includes("temu")) value = "Temu";
            else if (url.includes("aliexpress")) value = "速卖通";
            else if (url.includes("tiktok")) value = "TikTok";
            else value = "其他";
            break;
          }
          case "default":
            value = f.value || "";
            break;
        }
        // 任何来源（xlsx/AI/file_path...）取不到值时，若配置了 defaultValue 则回退
        if ((!value || !value.trim()) && f.defaultValue) {
          value = f.defaultValue;
        }
        fields.push({ key: f.key, value });
      }
      modulesData.push({ title: mod.title, fields });
    }

    // Post-process: if 营业期限 is "长期", prepend 公司成立日期 (e.g. "2023-10-18 长期")
    for (const mod of modulesData) {
      const termField = mod.fields.find(f => f.key === "营业期限");
      const dateField = mod.fields.find(f => f.key === "公司成立日期");
      if (termField && termField.value === "长期" && dateField && dateField.value) {
        termField.value = `${dateField.value} 长期`;
      }
    }

    // Post-process: 销售平台 根据 店铺链接 自动判断
    //   - 含 aliexpress → 速卖通
    //   - 含 amazon    → 亚马逊
    //   - 其他非空链接 → 其他
    //   - 链接为空     → 留空
    for (const mod of modulesData) {
      if (mod.title !== "店铺信息") continue;
      const platformField = mod.fields.find(f => f.key === "销售平台");
      const linkField = mod.fields.find(f => f.key === "店铺链接");
      if (!platformField) continue;
      const link = (linkField?.value || "").toLowerCase();
      if (!link) {
        platformField.value = "";
      } else if (link.includes("aliexpress")) {
        platformField.value = "速卖通";
      } else if (link.includes("amazon")) {
        platformField.value = "亚马逊";
      } else {
        platformField.value = "其他";
      }
    }

    return modulesData;
  }

  function renderModules(modulesData) {
    const container = document.getElementById("modules-area");
    if (!modulesData || modulesData.length === 0) {
      container.style.display = "none";
      container.innerHTML = "";
      return;
    }
    container.innerHTML = "";
    container.style.display = "";

    for (const mod of modulesData) {
      const filledCount = mod.fields.filter(f => f.value && f.value.length > 0).length;
      const total = mod.fields.length;

      const wrap = document.createElement("div");
      wrap.className = "module";
      wrap.style.cssText = "border:1px solid #e2e8f0; border-radius:6px; margin-top:10px; overflow:hidden;";

      const header = document.createElement("div");
      header.className = "module-header";
      header.style.cssText = "padding:10px 12px; background:#f8fafc; cursor:pointer; display:flex; justify-content:space-between; align-items:center; user-select:none;";
      header.innerHTML = `
        <span style="font-weight:600; color:#0f172a;"><span class="module-arrow">▼</span> ${escapeHtml(mod.title)}</span>
        <span style="font-size:12px; color:#64748b;">${filledCount}/${total}</span>
      `;

      const body = document.createElement("div");
      body.className = "module-body";
      body.style.cssText = "padding:8px 12px;";

      if (mod.fields.length === 0) {
        const empty = document.createElement("div");
        empty.style.cssText = "color:#cbd5e1; font-size:13px; padding:6px 0;";
        empty.textContent = "（暂无）";
        body.appendChild(empty);
      } else {
        for (const f of mod.fields) {
          const row = document.createElement("div");
          row.style.cssText = "display:flex; padding:6px 0; border-bottom:1px solid #f1f5f9; font-size:13px;";
          const filled = f.value && f.value.length > 0;
          row.innerHTML = `
            <span style="flex:0 0 40%; color:#475569;">${escapeHtml(f.key)}</span>
            <span style="flex:1; color:${filled ? "#0f172a" : "#cbd5e1"}; word-break:break-all;">${filled ? escapeHtml(f.value) : "（空）"}</span>
          `;
          body.appendChild(row);
        }
      }

      header.addEventListener("click", () => {
        const arrow = header.querySelector(".module-arrow");
        if (body.style.display === "none") {
          body.style.display = "";
          arrow.textContent = "▼";
        } else {
          body.style.display = "none";
          arrow.textContent = "▶";
        }
      });

      wrap.appendChild(header);
      wrap.appendChild(body);
      container.appendChild(wrap);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function runValidation() {
    hideResults();
    clearStatus();
    // 重新检查时清理上一次生成的临时占位（避免空白 PNG 被 AI 当作真实文件去识别）
    if (Object.keys(placeholderState).length > 0) {
      uploadedFiles = uploadedFiles.filter(f => !f.placeholder);
      placeholderState = {};
      updateFileCount();
    }
    statusLog(`[开始] 共 ${uploadedFiles.length} 个文件`);
    statusLog(`[配置] API Key: ${apiKey ? apiKey.substring(0, 8) + "..." : "未配置"}`);
    const fileObjCount = uploadedFiles.filter(f => f.file instanceof File).length;
    statusLog(`[文件] 含 File 对象（可AI识别）: ${fileObjCount}/${uploadedFiles.length}`);
    if (fileObjCount === 0 && uploadedFiles.length > 0) {
      statusLog(`[警告] 没有可用的 File 对象，AI 不会被调用`);
      statusLog(`[提示] 请用拖拽上传，不要用浏览按钮`);
    }

    const result = await detectFiles(uploadedFiles, currentReqConfig);
    // 解析 alternatives（互斥文件组，如「身份证正反面」 vs 「护照」二选一）
    // 必须在 detectFiles 之后立即跑：会把已满足的 alt 涉及文件从 missing 里剥离，
    // 或在没满足时改为合成单条「缺少法人证件（任选其一）」 missing 项。
    resolveAlternatives(result, currentReqConfig?.alternatives);
    lastValidationResult = result;

    statusLog(`[完成] 识别 ${result.found.length} 个，缺失 ${result.missing.length} 个`);

    renderFileSummary(uploadedFiles);
    renderDetectionResults(result);
    renderMissingItems(result.missing);
    renderResultSummary(result);
    renderAutofillButton(result);

    // Show result area first so users see detection result while modules are being built
    document.getElementById("result-area").style.display = "";

    // Build and render modules (xlsx + AI license extraction may be async)
    try {
      const modulesData = await buildModuleData(result);
      lastModulesData = modulesData;
      renderModules(modulesData);
      // 模块构建完成（包含 AI 提取的"法人/个人代表拼音名（英文名）"），
      // 刷新签名面板默认值（用户已手动编辑过的话不会被覆盖）
      showSignaturePanel().catch((e) => console.warn("[signature] refresh err:", e));
      // 同步刷新 委托书圆章 面板 —— 此时 公司名 已从 xlsx 读出，可作为默认值回填
      showPoaSealPanel().catch((e) => console.warn("[poa-seal] refresh err:", e));
    } catch (e) {
      statusLog(`[模块] 构建失败: ${e.message}`);
      lastModulesData = null;
      renderModules(null);
    }
  }

  // 按当前组合的 currentReqConfig.files 动态列出需要上传的文件状态。
  // 哪些文件出现在面板、怎么显示名、是否提示“图片→自动转 PDF”均由配置控制：
  //   showInAutofill: true             —— 该文件要在面板里显示一行状态。
  //   autofillStatusLabel: "营业执照文件" —— 可选，面板里显示的文案（表单字段名与文件名可能不一致）。
  //   convertImageToPdf: true          —— 可选，上传前会把图片转成 PDF，面板会提示。
  function renderAutofillButton(result) {
    const area = document.getElementById("autofill-area");
    const status = document.getElementById("autofill-status");
    const btn = document.getElementById("autofill-btn");

    area.style.display = "";
    btn.disabled = false;

    const isImg = (n) => /\.(jpe?g|png|gif|webp|bmp)$/i.test(n || "");
    const tag = (item) => item?.placeholder ? "（临时占位）" : "";

    const fileReqs = (currentReqConfig?.files || []).filter(req => req && req.showInAutofill);
    const lines = [];
    for (const fileReq of fileReqs) {
      const item = result?.found?.find(f => f.key === fileReq.key);
      const hasFile = !!(item && item.file && item.file.file instanceof File);
      const willConvert = !!(fileReq.convertImageToPdf && hasFile && isImg(item.file.name));
      const convertHint = willConvert ? "（图片→自动转 PDF）" : "";
      const displayLabel = fileReq.autofillStatusLabel || fileReq.label || fileReq.key;
      lines.push(
        `${displayLabel}：${hasFile
          ? "✅ " + item.file.name + tag(item) + convertHint
          : "⚠️ 未识别（不会上传文件）"}`
      );
    }
    if (lines.length > 0) {
      lines.push("点击按钮：填充文本字段 + 上传文件 + 选择日期 / 省市区");
    }
    status.textContent = lines.join("\n");
    status.style.color = "#475569";

    // 同步显示签名面板，并用 AI 提取的法人拼音作为默认值（不阻塞主流程）
    showSignaturePanel().catch((e) => console.warn("[signature] showPanel err:", e));
    // 同步显示 委托书圆章 面板（仅 placeholders.power_of_attorney.kind=poa_with_seal 组合）
    showPoaSealPanel().catch((e) => console.warn("[poa-seal] showPanel err:", e));
  }

  // ---- Autofill: push the detected 营业执照 file into the active tab's upload input ----
  async function fileToBase64Plain(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  // ---------------------------------------------------------------------------
  // 图片 → PDF 转换（页面上传框 accept=".pdf"，因此图片必须先包成 PDF）
  // 1. 已是 PDF：原样返回
  // 2. 是图片：用 canvas 编码为 JPEG，再手写最小 PDF 包装（无第三方依赖）
  // ---------------------------------------------------------------------------
  async function imageFileToPdfBlob(file) {
    const lowerName = (file.name || "").toLowerCase();
    const lowerType = (file.type || "").toLowerCase();
    const isPdf = lowerType === "application/pdf" || lowerName.endsWith(".pdf");
    if (isPdf) return { blob: file, name: file.name, converted: false };

    // Load the image to read its natural dimensions
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error || new Error("FileReader 失败"));
      fr.readAsDataURL(file);
    });
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("图片解码失败：" + file.name));
      im.src = dataUrl;
    });
    const W = img.naturalWidth || img.width;
    const H = img.naturalHeight || img.height;
    if (!W || !H) throw new Error("图片尺寸读取失败：" + file.name);

    // Render to canvas, normalize to JPEG (white background for transparency)
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0);
    const jpegBlob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob 失败"))), "image/jpeg", 0.92);
    });
    const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());

    const pdfBytes = buildSinglePagePdfFromJpeg(jpegBytes, W, H);
    const baseName = (file.name || "image").replace(/\.[^.\\/]+$/, "");
    return {
      blob: new Blob([pdfBytes], { type: "application/pdf" }),
      name: `${baseName}.pdf`,
      converted: true,
    };
  }

  // Build a minimal valid PDF-1.4 with one page that displays the JPEG full-bleed.
  // Page size = image pixel dimensions (1pt = 1px). This works for upload purposes.
  function buildSinglePagePdfFromJpeg(jpegBytes, width, height) {
    const enc = new TextEncoder();
    const parts = [];
    const offsets = []; // 1-indexed byte offsets of each object
    let cursor = 0;

    function pushBytes(b) { parts.push(b); cursor += b.length; }
    function pushStr(s) { pushBytes(enc.encode(s)); }
    function recordOffset() { offsets.push(cursor); }

    pushStr("%PDF-1.4\n%\xFF\xFF\xFF\xFF\n");

    recordOffset(); // obj 1
    pushStr("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

    recordOffset(); // obj 2
    pushStr("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");

    recordOffset(); // obj 3 - page
    pushStr(
      `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      `/Resources << /XObject << /Im0 4 0 R >> /ProcSet [/PDF /ImageC] >> ` +
      `/Contents 5 0 R >>\nendobj\n`
    );

    recordOffset(); // obj 4 - image
    pushStr(
      `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
      `/Length ${jpegBytes.length} >>\nstream\n`
    );
    pushBytes(jpegBytes);
    pushStr("\nendstream\nendobj\n");

    // Content stream: scale unit-square image to (W,H) and draw
    const content = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`;
    const contentBytes = enc.encode(content);
    recordOffset(); // obj 5
    pushStr(`5 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
    pushBytes(contentBytes);
    pushStr("\nendstream\nendobj\n");

    // xref
    const xrefStart = cursor;
    pushStr("xref\n0 6\n");
    pushStr("0000000000 65535 f \n");
    for (const o of offsets) {
      pushStr(String(o).padStart(10, "0") + " 00000 n \n");
    }
    pushStr(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

    // Concatenate
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  // ---------------------------------------------------------------------------
  // 临时占位文件生成器：在缺失列表点击"生成临时占位"时调用。
  // - createBlankPngFile: 800x600 白底 PNG，含一行提示文字。直接给图片上传框使用。
  // - createBlankPdfFile: 800x600 白底，包成单页 PDF（复用 buildSinglePagePdfFromJpeg）。
  // ---------------------------------------------------------------------------
  async function renderBlankCanvas(text) {
    const W = 800, H = 600;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#94a3b8";
    ctx.font = "32px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text || "临时占位文件", W / 2, H / 2);
    return { canvas, width: W, height: H };
  }

  async function createBlankPngFile(filename, text) {
    const { canvas } = await renderBlankCanvas(text);
    const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("PNG 生成失败");
    return new File([blob], filename, { type: "image/png" });
  }

  async function createBlankPdfFile(filename, text) {
    const { canvas, width, height } = await renderBlankCanvas(text);
    const jpegBlob = await new Promise(res => canvas.toBlob(res, "image/jpeg", 0.92));
    if (!jpegBlob) throw new Error("JPEG 中间产物生成失败");
    const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
    const pdfBytes = buildSinglePagePdfFromJpeg(jpegBytes, width, height);
    return new File([pdfBytes], filename, { type: "application/pdf" });
  }

  // 从 lastModulesData 按 { module, field } 取值（用于 poa_with_seal 取公司中文名）。
  // 找不到时返回空串；调用方决定是否兜底报错。
  function readModuleField(moduleTitle, fieldKey) {
    if (!Array.isArray(lastModulesData)) return "";
    const mod = lastModulesData.find((m) => m.title === moduleTitle);
    if (!mod || !Array.isArray(mod.fields)) return "";
    const f = mod.fields.find((x) => x.key === fieldKey);
    return (f && f.value || "").toString().trim();
  }

  // 委托书：用模板 PDF + Canvas 生成的圆章合成最终文件。两种章风格由 cfg.style 决定：
  //   - "mainland"（默认）：外圈中文弧文 + 中心红色五角星（法国|大陆 / 波兰|大陆）
  //   - "hk"             ：外圈英文弧文 + 中心多行中文方块 + 底部小蓝星（法国|香港）
  // 依赖 window.PoaComposer（annex/poa_composer.js）+ window.SealGenerator + window.PDFLib。
  // 字段来源（优先级 cfg 覆盖 > 模块字段 fallback）：
  //   - 中文名：cfg.companyName  > cfg.companyNameFrom 指向的 lastModulesData 字段
  //   - 英文名：cfg.englishName  > cfg.englishNameFrom 指向的 lastModulesData 字段（仅 HK）
  // HK 风格下中文名可为空（中心留空），但英文名必须非空（外圈必填）。mainland 反之。
  async function createPoaWithSealFile(cfg) {
    if (!window.PoaComposer) throw new Error("PoaComposer 未加载（annex/poa_composer.js）");

    const style = cfg.style || "mainland";

    // 中文名：两种风格都尝试读，但只在 mainland 时强制非空。
    // 注意区分 "cfg 没传该字段"（undefined → 走模块 fallback）和 "cfg 显式传空串"
    // （用户在面板清空 → 尊重，不回填），否则面板清空会被公司信息模块的值覆盖。
    let companyName;
    if (cfg.companyName !== undefined) {
      companyName = String(cfg.companyName).trim();
    } else {
      const src = cfg.companyNameFrom || { module: "公司信息", field: "公司名称" };
      companyName = readModuleField(src.module, src.field);
    }

    // 英文名：仅 HK 风格需要
    let englishName = "";
    if (style === "hk") {
      if (cfg.englishName !== undefined) {
        englishName = String(cfg.englishName).trim();
      } else {
        const esrc = cfg.englishNameFrom || { module: "店铺信息", field: "公司英文名称" };
        englishName = readModuleField(esrc.module, esrc.field);
      }
    }

    // 必填校验：HK 看英文名（外圈是主体），mainland 看中文名（弧文是主体）
    if (style === "hk") {
      if (!englishName) {
        const esrc = cfg.englishNameFrom || { module: "店铺信息", field: "公司英文名称" };
        throw new Error(`委托书盖章[HK]: 未从「${esrc.module} → ${esrc.field}」取到公司英文名，请在 🔴 委托书圆章 面板手动输入，或确认 店铺信息 模块已构建`);
      }
    } else {
      if (!companyName) {
        const src = cfg.companyNameFrom || { module: "公司信息", field: "公司名称" };
        throw new Error(`委托书盖章: 未从「${src.module} → ${src.field}」取到公司名，请在 🔴 委托书圆章 面板手动输入，或确认 公司信息 模块已构建`);
      }
    }

    // 把 style + englishName 注入 sealOpts，PoaComposer 透传给 SealGenerator.generate
    // 注意：cfg.sealOpts 是 placeholder 配置/面板传入的原始样式（color/ringWidth/font 等），
    // style + englishName 在这里 覆盖（override）：避免 cfg.sealOpts 里若漏写 style 时还走 mainland。
    const mergedSealOpts = Object.assign({}, cfg.sealOpts || {}, {
      style,
      englishName,
    });

    const { file } = await window.PoaComposer.compose(companyName, {
      filename: cfg.filename || "委托书盖章_自动生成.pdf",
      sealBox: cfg.sealBox,        // 红框坐标
      sealOpts: mergedSealOpts,    // 章样式 + style/englishName 路由
    });
    return file;
  }

  // overrides 可以覆盖 placeholder 配置里的任意字段（如 companyName / sealBox / sealOpts），
  // 用于 poa-seal-area 面板把用户实时调整的参数透传给生成器。
  async function generatePlaceholderFile(key, overrides) {
    const baseCfg = getPlaceholderConfig(key);
    if (!baseCfg) throw new Error(`未配置占位生成: ${key}`);
    const cfg = Object.assign({}, baseCfg, overrides || {});
    if (cfg.kind === "pdf") return createBlankPdfFile(cfg.filename, cfg.text);
    if (cfg.kind === "png") return createBlankPngFile(cfg.filename, cfg.text);
    if (cfg.kind === "poa_with_seal") return createPoaWithSealFile(cfg);
    throw new Error(`未知占位类型: ${cfg.kind}`);
  }

  // 在缺失项上生成临时占位文件，并把它"塞回" uploadedFiles 与 lastValidationResult，
  // 让后续渲染、模块构建、一键注入都能像识别成功一样使用它。
  //
  // @param {string} key
  // @param {object} [options]
  // @param {boolean} [options.force] true 时若已存在则先移除旧文件再重新生成（poa-seal 面板用）
  // @param {object}  [options.overrides] 透传给 generatePlaceholderFile，覆盖 placeholder 配置
  //                                      （poa_with_seal 时可传 companyName/sealBox/sealOpts）
  async function applyPlaceholder(key, options) {
    options = options || {};
    if (!lastValidationResult) {
      statusLog(`[占位] 请先完成检查再生成 ${key}`);
      return null;
    }

    const existingIdx = lastValidationResult.found.findIndex(f => f.key === key);
    if (existingIdx !== -1) {
      if (!options.force) {
        statusLog(`[占位] ${key} 已存在，跳过`);
        return null;
      }
      // force=true：移除旧记录 + 对应 uploadedFiles 项
      const oldFound = lastValidationResult.found[existingIdx];
      const oldName = oldFound?.file?.name;
      lastValidationResult.found.splice(existingIdx, 1);
      uploadedFiles = uploadedFiles.filter(f =>
        !(f.placeholder && (f === oldFound?.file || (oldName && f.name === oldName)))
      );
      delete placeholderState[key];
    }

    const req = (currentReqConfig?.files || []).find(r => r.key === key);
    if (!req) {
      statusLog(`[占位] 未在配置里找到 key=${key}`);
      return null;
    }
    const displayLabel = req.label || key;

    const file = await generatePlaceholderFile(key, options.overrides);
    placeholderState[key] = file;

    const fileMeta = {
      name: file.name,
      path: `(临时占位) ${file.name}`,
      size: file.size,
      file,
      placeholder: true
    };
    uploadedFiles.push(fileMeta);

    lastValidationResult.found.push({
      ...req,
      file: fileMeta,
      placeholder: true
    });
    lastValidationResult.missing = lastValidationResult.missing.filter(m => m.key !== key);
    // 重新解析 alternatives：占位文件落入 found 后可能改变互斥组的满足状态
    // （目前 alt 文件如 id_card / passport 没有 placeholder，但保持幂等更安全）。
    resolveAlternatives(lastValidationResult, currentReqConfig?.alternatives);

    statusLog(`[占位] 已生成 ${displayLabel} → ${file.name}（${file.size} 字节）`);

    updateFileCount();
    renderDetectionResults(lastValidationResult);
    renderMissingItems(lastValidationResult.missing);
    renderResultSummary(lastValidationResult);
    renderAutofillButton(lastValidationResult);
    refreshFilePathModuleFields();

    return file;
  }

  // 根据当前 lastValidationResult.found，仅刷新 file_path 类型的模块字段值并重渲。
  // 用于 applyPlaceholder 后避免重新跑 AI（buildModuleData 会重复调用 AI 提取）。
  function refreshFilePathModuleFields() {
    if (!lastModulesData || !lastValidationResult) return;
    const modules = getCurrentModules();
    for (const mod of lastModulesData) {
      const cfg = modules.find(m => m.title === mod.title);
      if (!cfg) continue;
      for (const field of mod.fields) {
        const fcfg = cfg.fields.find(f => f.key === field.key);
        if (fcfg && fcfg.source === "file_path") {
          const item = lastValidationResult.found.find(x => x.key === fcfg.fileKey);
          field.value = item && item.file ? (item.file.path || item.file.name || "") : "";
        }
      }
    }
    renderModules(lastModulesData);
  }

  // Determine if URL is non-injectable (chrome internal, store, ext page, etc.).
  function isInjectableHttp(u) {
    return typeof u === "string" && /^https?:/i.test(u) && !u.startsWith("https://chrome.google.com/webstore");
  }

  // Pick the best target tab for autofill.
  // Strategy (in priority order):
  //   1. sourceTabId — captured when the user clicked the toolbar icon (most reliable).
  //   2. Enumerate "normal" windows and pick the focused window's active tab.
  //   3. Fallback to chrome.tabs.query with various filters.
  // Returns { tab, reason } where reason explains the choice for debugging/diagnostics.
  async function pickTargetTab() {
    // 1. Try the captured source tab first
    if (sourceTabId) {
      try {
        const t = await chrome.tabs.get(sourceTabId);
        if (t && t.id) return { tab: t, reason: "sourceTabId" };
      } catch (e) {
        console.warn("[autofill] sourceTabId tab no longer exists:", sourceTabId, e);
      }
    }

    // 2. Enumerate windows and find a normal-window active tab
    try {
      const wins = await chrome.windows.getAll({ populate: true });
      const normalWins = (wins || [])
        .filter(w => w && w.type === "normal" && Array.isArray(w.tabs) && w.tabs.length > 0)
        .sort((a, b) => (b.focused === true) - (a.focused === true) || (b.id || 0) - (a.id || 0));

      for (const w of normalWins) {
        const active = w.tabs.find(t => t && t.active && isInjectableHttp(t.url));
        if (active) return { tab: active, reason: "normalWindow.active.http" };
      }
      // Less strict: active tab regardless of URL (we'll let scripting fail with a clear message)
      for (const w of normalWins) {
        const active = w.tabs.find(t => t && t.active);
        if (active) return { tab: active, reason: "normalWindow.active.any" };
      }
    } catch (e) {
      console.warn("[autofill] windows.getAll failed:", e);
    }

    // 3. tabs.query fallback
    const queries = [
      { active: true, lastFocusedWindow: true },
      { active: true, currentWindow: true },
      { active: true }
    ];
    for (const q of queries) {
      try {
        const tabs = await chrome.tabs.query(q);
        const t = tabs.find(tab => tab && isInjectableHttp(tab.url));
        if (t) return { tab: t, reason: `tabs.query(${JSON.stringify(q)})` };
      } catch (_) {}
    }
    // Last resort: any active tab anywhere (let injection fail loudly)
    try {
      const tabs = await chrome.tabs.query({ active: true });
      const t = tabs.find(tab => tab && tab.id && !(tab.url || "").startsWith("chrome-extension://"));
      if (t) return { tab: t, reason: "any.active" };
    } catch (_) {}

    return { tab: null, reason: "none" };
  }

  // ============================================================================
  // 注入到目标页面执行的函数。必须自包含（不能引用闭包变量）。
  // 接收一个 plan: 数组，每项 { type, key, ...args }
  // 返回 { results: [{key, ok, error?, msg?}, ...] }
  // ============================================================================
  async function pageExecutePlan(plan) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const fire = (el, types) => types.forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true })));

    // React/Vue-friendly value setter
    function setNativeValue(el, value) {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
    }

    function isVisible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.display === "none") return false;
      return r.width > 0 || r.height > 0 || el.offsetParent !== null;
    }

    function findInputByPlaceholder(placeholder) {
      const all = Array.from(document.querySelectorAll("input, textarea"));
      // Exact match first (visible)
      const exactVis = all.find((el) => (el.getAttribute("placeholder") || "") === placeholder && isVisible(el));
      if (exactVis) return exactVis;
      const exact = all.find((el) => (el.getAttribute("placeholder") || "") === placeholder);
      if (exact) return exact;
      // Fuzzy: contains
      const fuzzyVis = all.find((el) => (el.getAttribute("placeholder") || "").includes(placeholder) && isVisible(el));
      if (fuzzyVis) return fuzzyVis;
      return all.find((el) => (el.getAttribute("placeholder") || "").includes(placeholder)) || null;
    }

    function findUploadInputByFieldId(fieldId) {
      const box = document.querySelector(`.uploadClearfixBox[field-id="${fieldId}"]`);
      if (!box) return null;
      return box.querySelector('input[type="file"]');
    }

    function findUploadInputByLabel(labelText) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const candidates = [];
      let n;
      while ((n = walker.nextNode())) {
        const v = (n.nodeValue || "").trim();
        if (v && v.includes(labelText)) candidates.push(n.parentElement);
      }
      let best = null;
      let bestDepth = Infinity;
      for (const start of candidates) {
        let scope = start;
        for (let d = 0; d < 12 && scope; d++) {
          const inp = scope.querySelector('input[type="file"]');
          if (inp) {
            if (d < bestDepth) { best = inp; bestDepth = d; }
            break;
          }
          scope = scope.parentElement;
        }
      }
      return best;
    }

    // Generic: locate an input/textarea/cascader near a text label by walking up the DOM
    // from a text node containing labelText until an ancestor has a descendant matching selector.
    // Used to disambiguate fields that share placeholders (e.g. 3 个 "请选择所在省/市/区" cascader).
    // 全角/半角括号在比较时会被规范化，避免页面用"（中文）"而 plan 写"(中文)"导致匹配失败。
    function findInputByLabelText(labelText, selector) {
      const normParen = (s) => String(s || "").replace(/[（]/g, "(").replace(/[）]/g, ")");
      const targetNorm = normParen(labelText);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const candidates = [];
      let n;
      while ((n = walker.nextNode())) {
        const v = normParen(n.nodeValue).trim();
        if (v && v.includes(targetNorm)) candidates.push(n.parentElement);
      }
      let best = null;
      let bestDepth = Infinity;
      for (const start of candidates) {
        let scope = start;
        for (let d = 0; d < 12 && scope; d++) {
          const inp = scope.querySelector(selector);
          if (inp && isVisible(inp)) {
            if (d < bestDepth) { best = inp; bestDepth = d; }
            break;
          }
          scope = scope.parentElement;
        }
      }
      return best;
    }

    // 用绝对/相对 XPath 直接定位元素（最高优先级；用于 labelText/placeholder 都打偏的场景）。
    function findByXPath(xpath) {
      try {
        const r = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const node = r && r.singleNodeValue;
        if (!node) return null;
        // 只接受可见元素，避免命中已隐藏的旧节点
        if (node.nodeType === 1 && !isVisible(node)) return null;
        return node;
      } catch (e) {
        return null;
      }
    }

    function b64ToBytes(b64) {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }

    function highlight(el, color = "#22c55e") {
      if (!el) return;
      try {
        const prev = el.style.boxShadow;
        el.style.boxShadow = `0 0 0 2px ${color}`;
        setTimeout(() => { el.style.boxShadow = prev; }, 1500);
      } catch (_) {}
    }

    // Parse "YYYY[年-./]MM[月-./]DD[日]?" → {year, month, day} or null
    function parseDate(s) {
      const m = String(s || "").match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
      if (!m) return null;
      return { year: +m[1], month: +m[2], day: +m[3] };
    }

    // ----- Handlers -----

    async function handleText(item) {
      if (!item.value) return { ok: true, skipped: true, msg: "空值跳过" };
      // 定位优先级：xpath > elementSelector(独立，最稳健) > labelText+elementSelector > placeholder
      // 注：elementSelector 独立路径仅在没有 labelText 时启用，保持向后兼容
      //（旧用法里 elementSelector 是 labelText 的 sub-filter，例如 'textarea[placeholder="..."]'）
      let input = null;
      let how = "";
      if (item.xpath) {
        input = findByXPath(item.xpath);
        if (input) how = "xpath";
      }
      if (!input && item.elementSelector && !item.labelText) {
        // 仅当 selector 含 id / 属性 / class（即 [ # . 三种符号之一）时才视为「足够特定」，
        // 直接 querySelector 全文匹配。bare tag 如 "textarea" / "input" 会拿到页面第一个
        // 同类元素，这种情况下旧 plan（如波兰）把 elementSelector 当作 labelText 的 sub-filter
        // 写，没设 labelText 时本来是 dead-code —— 这里也保持 dead，避免误命中。
        if (/[\[#.]/.test(item.elementSelector)) {
          try {
            input = document.querySelector(item.elementSelector);
            if (input) how = "elementSelector";
          } catch (_) { /* invalid selector, fall through */ }
        }
      }
      if (!input && item.labelText) {
        const sel = item.elementSelector || "input, textarea";
        input = findInputByLabelText(item.labelText, sel);
        if (input) how = "labelText";
      }
      if (!input && item.placeholder) {
        input = findInputByPlaceholder(item.placeholder);
        if (input) how = "placeholder";
      }
      if (!input) {
        const tags = [
          item.xpath && `xpath`,
          item.elementSelector && !item.labelText && `elementSelector="${item.elementSelector}"`,
          item.labelText && `labelText="${item.labelText}"`,
          item.placeholder && `placeholder="${item.placeholder}"`
        ].filter(Boolean).join(" / ");
        // 诊断：列出页面上 placeholder 含目标关键字的 input/textarea
        const similar = [];
        if (item.placeholder) {
          // 提取多个核心关键字（去掉常见前缀），单独尝试每个：
          // 例如 "请输入法人/个人代表中文名" -> ["法人", "代表", "中文名"]
          const stripped = item.placeholder
            .replace(/^请输入\s*/, "")
            .replace(/^请选择\s*/, "");
          const cores = stripped.split(/[\/、，,。 ]+/).filter((s) => s && s.length >= 2);
          if (cores.length === 0 && stripped.length >= 2) cores.push(stripped.substring(0, 4));
          const all = Array.from(document.querySelectorAll("input, textarea"));
          const seen = new Set();
          for (const el of all) {
            const ph = (el.getAttribute("placeholder") || "").trim();
            if (!ph) continue; // 空 placeholder 没有诊断价值，跳过
            if (seen.has(ph)) continue;
            const hit = cores.some((c) => ph.includes(c));
            if (hit) {
              seen.add(ph);
              similar.push(`"${ph}"`);
              if (similar.length >= 8) break;
            }
          }
        }
        const totalInputs = document.querySelectorAll("input, textarea").length;
        return {
          ok: false,
          error: `未找到输入框 (${tags || "未提供任何定位条件"}). `
            + `页面 input+textarea 共 ${totalInputs} 个. `
            + `含相似关键字 placeholder: [${similar.join(", ") || "(无)"}]`
        };
      }
      input.focus();
      setNativeValue(input, String(item.value));
      fire(input, ["input", "change", "blur"]);
      highlight(input);
      return { ok: true, msg: `已填入 "${item.value}"（via ${how}）` };
    }

    async function handleFile(item) {
      if (!item.file) return { ok: true, skipped: true, msg: "无文件，跳过" };
      let input = item.fieldId ? findUploadInputByFieldId(item.fieldId) : null;
      if (!input && item.labelFallback) input = findUploadInputByLabel(item.labelFallback);
      if (!input) {
        // 诊断：
        // 1. 所有 .uploadClearfixBox（不限定 field-id）的 field-id 值
        // 2. 所有 input[type=file] 的最近父级提示文本（往上 5 级取到的可读文本片段）
        // 3. 含 labelFallback 核心字的文本节点
        const allBoxes = Array.from(document.querySelectorAll(".uploadClearfixBox"));
        const boxIds = allBoxes.map((e) => e.getAttribute("field-id") || "(无field-id)");
        const allFileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
        const fileInputCtx = allFileInputs.map((inp) => {
          // 取 input 最近 5 级父级里的可读文本（截断 60 字符）
          let scope = inp.parentElement;
          for (let d = 0; d < 5 && scope; d++) {
            const txt = (scope.innerText || scope.textContent || "").replace(/\s+/g, " ").trim();
            if (txt && txt.length > 0) return txt.substring(0, 60);
            scope = scope.parentElement;
          }
          return "(空)";
        });
        const matchingTexts = [];
        if (item.labelFallback) {
          const core = item.labelFallback.replace(/[（）()]/g, "").trim();
          if (core) {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let n;
            while ((n = walker.nextNode())) {
              const v = (n.nodeValue || "").trim();
              if (v && v.length < 60 && v.includes(core)) {
                matchingTexts.push(v);
                if (matchingTexts.length >= 5) break;
              }
            }
          }
        }
        return {
          ok: false,
          error: `未找到上传框 (field-id=${item.fieldId || "-"}, label=${item.labelFallback || "-"}). `
            + `所有 .uploadClearfixBox 共 ${allBoxes.length} 个 field-id: [${boxIds.join(", ")}]. `
            + `所有 input[type=file] 共 ${allFileInputs.length} 个，附近文本: [${fileInputCtx.map((t) => `"${t}"`).join(" | ")}]. `
            + `含核心文本的节点: [${matchingTexts.join(" | ") || "(无)"}]`
        };
      }
      const bytes = b64ToBytes(item.file.base64);
      const blob = new Blob([bytes], { type: item.file.fileType || "application/octet-stream" });
      const file = new File([blob], item.file.name, { type: item.file.fileType || "application/octet-stream" });

      let warn = "";
      if (input.accept) {
        const ok = input.accept.split(",").some((a) => {
          const t = a.trim().toLowerCase();
          if (!t) return false;
          if (t.startsWith(".")) return item.file.name.toLowerCase().endsWith(t);
          if (t.endsWith("/*")) return (file.type || "").toLowerCase().startsWith(t.slice(0, -1));
          return (file.type || "").toLowerCase() === t;
        });
        if (!ok) warn = `（accept="${input.accept}"，文件类型可能不符）`;
      }

      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      fire(input, ["change", "input"]);
      const host = input.closest(".uploadClearfixBox") || input.closest(".ant-upload-select") || input.parentElement;
      highlight(host);
      return { ok: true, msg: `已上传 "${item.file.name}"${warn}` };
    }

    // Given an open ant-calendar panel, navigate to year/month and click the day cell.
    async function pickDateInPanel(panel, target) {
      if (!panel) return { ok: false, error: "calendar panel 不可用" };

      // Year navigation
      const readYear = () => parseInt((panel.querySelector(".ant-calendar-year-select")?.textContent || "").replace(/\D/g, ""), 10);
      const readMonth = () => parseInt((panel.querySelector(".ant-calendar-month-select")?.textContent || "").replace(/\D/g, ""), 10);

      let safety = 50;
      let curY = readYear();
      while (Number.isFinite(curY) && curY !== target.year && safety-- > 0) {
        const btn = panel.querySelector(curY < target.year ? ".ant-calendar-next-year-btn" : ".ant-calendar-prev-year-btn");
        if (!btn) break;
        btn.click();
        await sleep(40);
        curY = readYear();
      }

      safety = 50;
      let curM = readMonth();
      while (Number.isFinite(curM) && curM !== target.month && safety-- > 0) {
        const btn = panel.querySelector(curM < target.month ? ".ant-calendar-next-month-btn" : ".ant-calendar-prev-month-btn");
        if (!btn) break;
        btn.click();
        await sleep(40);
        curM = readMonth();
      }

      await sleep(80);
      // Click day in current month (skip last/next-month cells)
      const cells = panel.querySelectorAll(
        ".ant-calendar-cell:not(.ant-calendar-last-month-cell):not(.ant-calendar-next-month-btn-day) .ant-calendar-date"
      );
      let hit = null;
      for (const c of cells) {
        if (parseInt(c.textContent.trim(), 10) === target.day) { hit = c; break; }
      }
      if (!hit) return { ok: false, error: `日历找不到 ${target.year}-${target.month}-${target.day}（可能被禁用）` };
      // If the day is in a disabled cell, abort
      const cell = hit.closest(".ant-calendar-cell");
      if (cell && cell.classList.contains("ant-calendar-disabled-cell")) {
        return { ok: false, error: `日期 ${target.year}-${target.month}-${target.day} 被禁用` };
      }
      hit.click();
      await sleep(100);
      return { ok: true };
    }

    function findOpenPanel(selector) {
      const panels = document.querySelectorAll(selector);
      for (const p of panels) {
        if (isVisible(p)) return p;
      }
      return null;
    }

    async function handleDatepicker(item) {
      if (!item.value) return { ok: true, skipped: true, msg: "空值跳过" };
      const date = parseDate(item.value);
      if (!date) return { ok: false, error: `日期格式无法解析: ${item.value}` };

      const input = findInputByPlaceholder(item.placeholder);
      if (!input) return { ok: false, error: `未找到 datepicker placeholder="${item.placeholder}"` };

      // Open the panel: ant-calendar opens on click of the picker container
      const picker = input.closest(".ant-calendar-picker") || input;
      input.click();
      picker.click();
      input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await sleep(280);

      const panel = findOpenPanel(".ant-calendar-picker-container");
      if (!panel) return { ok: false, error: "点击后未弹出日历" };

      const r = await pickDateInPanel(panel, date);
      // Try to close: blur + body click
      input.blur();
      await sleep(60);
      return r.ok ? { ok: true, msg: `已选择 ${date.year}-${date.month}-${date.day}` } : r;
    }

    // 找到包含 labelText 的最近表单容器（同时含 .btn_warp 或日期范围选择器）。
    // 用于在同一页面中区分多个"长期+日期范围"的表单项（例如 营业期限 vs 身份证有效期限）。
    function findBusinessTermScope(labelText) {
      if (!labelText) return document;
      const normParen = (s) => String(s || "").replace(/[（]/g, "(").replace(/[）]/g, ")");
      const targetNorm = normParen(labelText);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const candidates = [];
      let n;
      while ((n = walker.nextNode())) {
        const v = normParen(n.nodeValue).trim();
        if (v && v.includes(targetNorm)) candidates.push(n.parentElement);
      }
      for (const start of candidates) {
        let scope = start;
        for (let d = 0; d < 12 && scope; d++) {
          if (scope.querySelector(".btn_warp") || scope.querySelector(".ant-calendar-range-picker-input")) {
            return scope;
          }
          scope = scope.parentElement;
        }
      }
      return document;
    }

    async function handleBusinessTerm(item) {
      if (!item.value) return { ok: true, skipped: true, msg: "空值跳过" };
      const isLong = String(item.value).includes("长期");
      const scope = findBusinessTermScope(item.labelText);

      // Find 长期 toggle button within scope: <div class="btn_warp"><span>长期</span>...</div>
      let toggleBtn = null;
      const allSpans = scope.querySelectorAll(".btn_warp span");
      for (const s of allSpans) {
        if (s.textContent.trim() === "长期") { toggleBtn = s.closest(".btn_warp") || s.parentElement; break; }
      }

      // 提取所有形如 YYYY?MM?DD 的日期片段（兼容 -, ., /, 空格 等任意非数字分隔符）
      const dateMatches = String(item.value).match(/\d{4}\D+\d{1,2}\D+\d{1,2}/g) || [];

      if (isLong) {
        // Activate 长期 mode (assume not already active)
        if (toggleBtn) {
          toggleBtn.click();
          await sleep(280);
        }
        // Now there should be a single picker with placeholder "请选择开始日期" within the same scope
        const startStr = item.startDate || dateMatches[0] || item.value;
        const date = parseDate(startStr);
        if (!date) return { ok: false, error: `长期模式找不到开始日期 (value=${item.value}, startDate=${item.startDate})` };
        const startInput = scope.querySelector('input[placeholder="请选择开始日期"]')
          || document.querySelector('input[placeholder="请选择开始日期"]');
        if (!startInput) return { ok: false, error: "未找到 datepicker placeholder=\"请选择开始日期\"" };
        const picker = startInput.closest(".ant-calendar-picker") || startInput;
        startInput.click();
        picker.click();
        startInput.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        await sleep(280);
        const panel = findOpenPanel(".ant-calendar-picker-container");
        if (!panel) return { ok: false, error: "点击后未弹出日历" };
        const r = await pickDateInPanel(panel, date);
        startInput.blur();
        await sleep(60);
        return r.ok ? { ok: true, msg: `已设长期，开始 ${date.year}-${date.month}-${date.day}` } : r;
      }

      // Range mode: 接受 "YYYY-MM-DD ~ YYYY-MM-DD"、"YYYY.MM.DD-YYYY.MM.DD" 等
      if (dateMatches.length < 2) return { ok: false, error: `日期范围格式无效: ${item.value}` };
      const a = parseDate(dateMatches[0]);
      const b = parseDate(dateMatches[1]);
      if (!a || !b) return { ok: false, error: `范围日期解析失败: ${item.value}` };

      const rangeStart = scope.querySelector('.ant-calendar-range-picker-input[placeholder="开始日期"]')
        || document.querySelector('.ant-calendar-range-picker-input[placeholder="开始日期"]');
      if (!rangeStart) return { ok: false, error: "未找到日期范围选择器（开始日期）" };
      const rangePicker = rangeStart.closest(".ant-calendar-picker") || rangeStart;
      rangePicker.click();
      rangeStart.click();
      await sleep(300);

      const panel = findOpenPanel(".ant-calendar-picker-container");
      if (!panel) return { ok: false, error: "范围选择器未弹开" };

      // ant range picker has two month panels usually; pickDateInPanel uses .ant-calendar-year/month-select
      // which exists in range picker too. We'll click start date first, then end.
      const r1 = await pickDateInPanel(panel, a);
      if (!r1.ok) return { ok: false, error: `开始日期: ${r1.error}` };
      await sleep(150);
      const r2 = await pickDateInPanel(findOpenPanel(".ant-calendar-picker-container") || panel, b);
      if (!r2.ok) return { ok: false, error: `结束日期: ${r2.error}` };
      return { ok: true, msg: `已选择 ${dateMatches[0]} ~ ${dateMatches[1]}` };
    }

    // ant-select 下拉选择器：根据 placeholder 找到 .ant-select，弹开后用字符 F1 评分挑最像的选项。
    // 这样即便 AI 给的"类型"和页面选项措辞不完全一致（如 "股份有限公司" vs "股份有限责任公司"），也能匹配。
    // 兼容多选（.ant-select-multiple，如"店铺主要经营范围"）：选完后主动点击 body 关闭弹层。
    async function handleSelect(item) {
      if (!item.value) return { ok: true, skipped: true, msg: "空值跳过" };

      // 定位优先级：elementSelector(独立 id 选择器) > placeholder
      // placeholder 模式仅在「页面尚未选过值」时可靠 —— 一旦被选过，.ant-select-selection__placeholder
      // 会被替换为 .ant-select-selection-selected-value，placeholder 文案就消失了。
      let trigger = null;
      if (item.elementSelector) {
        try {
          const el = document.querySelector(item.elementSelector);
          if (el) trigger = el.classList?.contains("ant-select") ? el : el.closest(".ant-select");
        } catch (_) { /* invalid selector, fall through */ }
        if (!trigger) return { ok: false, error: `未找到 ant-select elementSelector="${item.elementSelector}"` };
      } else {
        // Find by placeholder span (only present when nothing has been selected yet)
        // 同时做全角→半角括号归一，让 plan 写"（个人）" / 页面写"(个人)" 也能互相命中。
        const normParenLookup = (s) => String(s || "").replace(/[（]/g, "(").replace(/[）]/g, ")").trim();
        const phN = normParenLookup(item.placeholder);
        const phSpans = document.querySelectorAll(".ant-select-selection__placeholder");
        for (const sp of phSpans) {
          const tN = normParenLookup(sp.textContent);
          if (tN === phN || (phN && tN.includes(phN))) {
            trigger = sp.closest(".ant-select");
            if (trigger) break;
          }
        }
        if (!trigger) return { ok: false, error: `未找到 ant-select placeholder="${item.placeholder}"` };
      }

      const isMultiple = trigger.classList.contains("ant-select-multiple")
        || trigger.classList.contains("ant-select-selection--multiple");

      // Open
      trigger.click();
      const sel = trigger.querySelector(".ant-select-selection");
      sel?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await sleep(280);

      // Find open dropdown menu (avoid display:none ones)
      const openMenu = findOpenPanel(".ant-select-dropdown");
      if (!openMenu) return { ok: false, error: "select dropdown 未弹开" };

      const lis = Array.from(openMenu.querySelectorAll("li.ant-select-dropdown-menu-item"));
      if (lis.length === 0) return { ok: false, error: "select dropdown 没有选项" };

      // Char-level F1 score: precision wrt option, recall wrt value
      const score = (value, opt) => {
        const a = new Set(value), b = new Set(opt);
        let inter = 0;
        for (const c of a) if (b.has(c)) inter++;
        if (inter === 0) return 0;
        const p = inter / b.size;
        const r = inter / a.size;
        return (2 * p * r) / (p + r);
      };

      // 全角括号归一化：AI 提取的"有限责任公司(自然人独资)"半角括号，
      // 页面选项是"有限责任公司（自然人独资）"全角括号，归一化后才能精确等值匹配。
      const normParen = (s) => String(s).replace(/[（]/g, "(").replace(/[）]/g, ")").trim();
      const value = String(item.value);
      const valueN = normParen(value);
      const optTexts = lis.map((li) => (li.textContent || "").trim());
      const optTextsN = optTexts.map(normParen);

      // 1. Exact match (after paren normalization) wins
      let idx = optTextsN.indexOf(valueN);
      // 2. Otherwise pick the highest-F1 option using normalized strings
      //    (避免 "有限责任公司" 这种短名以子集胜过 "有限责任公司（自然人独资）" 全集)
      if (idx < 0) {
        let bestScore = 0, bestIdx = -1;
        for (let i = 0; i < optTextsN.length; i++) {
          const s = score(valueN, optTextsN[i]);
          if (s > bestScore) { bestScore = s; bestIdx = i; }
        }
        if (bestScore >= 0.4) idx = bestIdx;
      }

      if (idx < 0) {
        document.body.click();
        return { ok: false, error: `没有匹配的选项 (value="${value}", options=[${optTexts.join("，")}])` };
      }

      const target = lis[idx];
      const text = optTexts[idx];
      target.click();
      await sleep(150);
      // 多选模式下下拉不会自动收起，会遮挡后续 cascader/datepicker。
      // antd 的 rc-trigger 是通过 document 的 mousedown 来检测"点击外部"，
      // 单纯 document.body.click() 只触发 click，不会触发 mousedown，无法关闭弹层。
      // 这里派发真实的 mousedown / mouseup / click 序列到 body 上。
      if (isMultiple) {
        const target2 = document.body;
        target2.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        target2.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        target2.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        await sleep(120);
        // 兜底：若仍处于打开状态，点一下 trigger 自身（toggle 关闭）
        if (trigger.classList.contains("ant-select-open")) {
          trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
          await sleep(60);
          trigger.click();
          await sleep(120);
        }
      }
      return { ok: true, msg: `已选 "${text}"` };
    }

    async function handleCascader(item) {
      if (!item.value) return { ok: true, skipped: true, msg: "空值跳过" };
      // 定位优先级：elementSelector(独立 id 选择器) > labelText > placeholder
      // 含逗号的 id（如 "0,2,2,0,0"）必须用属性选择器 [id="..."]，CSS #id 写法不可行
      let input = null;
      if (item.elementSelector) {
        try {
          input = document.querySelector(item.elementSelector);
        } catch (_) { /* invalid selector, fall through */ }
        if (!input) {
          return { ok: false, error: `未找到 cascader elementSelector="${item.elementSelector}"` };
        }
      } else if (item.labelText) {
        input = findInputByLabelText(item.labelText, "input.ant-cascader-input");
        if (!input) {
          return { ok: false, error: `未找到 cascader labelText="${item.labelText}"` };
        }
      } else {
        input = findInputByPlaceholder(item.placeholder);
        if (!input) return { ok: false, error: `未找到 cascader placeholder="${item.placeholder}"` };
      }

      const picker = input.closest(".ant-cascader-picker") || input;
      picker.click();
      input.click();
      await sleep(280);

      const open = findOpenPanel(".ant-cascader-menus");
      if (!open) return { ok: false, error: "cascader 未弹开" };

      const matchItem = (items, valueStr) => {
        // 1. Direct: title appears in valueStr
        for (const li of items) {
          const t = (li.getAttribute("title") || li.textContent).trim();
          if (t && valueStr.includes(t)) return li;
        }
        // 2. If only one option (e.g., 直辖市 → 市辖区), use it
        if (items.length === 1) return items[0];
        // 3. Strip 省/市/区/县 suffix and try again
        for (const li of items) {
          const t = (li.getAttribute("title") || li.textContent).trim();
          const stripped = t.replace(/[省市区县]$/, "");
          if (stripped && valueStr.includes(stripped)) return li;
        }
        return null;
      };

      const valueStr = String(item.value);
      let level = 0;
      const maxLevels = 4;
      const picked = [];
      while (level < maxLevels) {
        const menus = open.querySelectorAll("ul.ant-cascader-menu");
        if (menus.length <= level) break;
        const items = menus[level].querySelectorAll("li.ant-cascader-menu-item");
        if (items.length === 0) break;

        let target = matchItem(items, valueStr);
        if (!target) {
          if (level === 0) return { ok: false, error: `cascader 第 1 级匹配不到 (value="${valueStr}")` };

          // 中间级失配 fallback：地址有时跳过地级市直接到县（如"广东省丰顺县XXX"省略"梅州市"）。
          // 逐个展开当前级候选，看哪个候选的下一级菜单里能匹配到 valueStr，把它当作正确的父节点。
          // 仅在能展开（非叶子）的候选里尝试，避免误开禁用项。
          if (level < maxLevels - 1) {
            let foundParent = null;
            for (const candidate of items) {
              if (!candidate.classList.contains("ant-cascader-menu-item-expand")) continue;
              candidate.click();
              await sleep(220);
              const subMenus = open.querySelectorAll("ul.ant-cascader-menu");
              if (subMenus.length > level + 1) {
                const subItems = subMenus[level + 1].querySelectorAll("li.ant-cascader-menu-item");
                if (matchItem(subItems, valueStr)) { foundParent = candidate; break; }
              }
            }
            if (foundParent) {
              const parentText = (foundParent.getAttribute("title") || foundParent.textContent).trim();
              picked.push(parentText);
              await sleep(120);
              level++;
              continue; // 下一轮在新展开的 level+1 菜单里继续匹配
            }
          }
          // 所有候选都不含目标，接受到目前为止的部分选中（如只选了省级）
          break;
        }
        const text = (target.getAttribute("title") || target.textContent).trim();
        const isLeaf = !target.classList.contains("ant-cascader-menu-item-expand");
        target.click();
        picked.push(text);
        await sleep(220);
        level++;
        if (isLeaf) break;
      }

      // Dismiss
      document.body.click();
      return picked.length > 0
        ? { ok: true, msg: `已选 ${picked.join(" / ")}` }
        : { ok: false, error: "未选中任何级别" };
    }

    // ant-radio 单选组：根据选项文字（如"法人身份证"、"男"、"中国籍"）找到对应的 .ant-radio-wrapper 并点击。
    // 优先精确匹配（去掉首尾空白后），其次按"含目标文本且为最短候选"挑选，避免"中国籍"误中"非中国籍"。
    async function handleRadio(item) {
      if (!item.value) return { ok: true, skipped: true, msg: "空值跳过" };
      const target = String(item.value).trim();

      // 支持普通 radio (.ant-radio-wrapper) 和按钮型 radio (.ant-radio-button-wrapper，例如店铺信息的"销售平台")
      const wrappers = Array.from(
        document.querySelectorAll(".ant-radio-wrapper, .ant-radio-button-wrapper")
      ).filter((w) => isVisible(w));
      if (wrappers.length === 0) return { ok: false, error: "页面未发现任何 ant-radio-wrapper" };

      // 1. 精确匹配（trim 后完全相等）
      let hit = wrappers.find((w) => (w.textContent || "").trim() === target);
      // 2. 精确匹配 wrapper 内部 <span>（避开"非中国籍"包含"中国籍"这种坑）
      if (!hit) {
        for (const w of wrappers) {
          const spans = w.querySelectorAll("span");
          let exact = false;
          for (const s of spans) {
            if ((s.textContent || "").trim() === target) { exact = true; break; }
          }
          if (exact) { hit = w; break; }
        }
      }
      // 3. 兜底：包含且文本最短（最贴近"目标长度")
      if (!hit) {
        const candidates = wrappers
          .filter((w) => (w.textContent || "").trim().includes(target))
          .sort((a, b) => (a.textContent || "").trim().length - (b.textContent || "").trim().length);
        hit = candidates[0] || null;
      }

      if (!hit) return { ok: false, error: `未找到 radio 选项 "${target}"` };

      const inp = hit.querySelector('input[type="radio"]');
      if (inp) inp.click();
      else hit.click();
      // 触发可能的 change 事件
      if (inp) fire(inp, ["change", "click"]);
      highlight(hit);
      await sleep(120);
      return { ok: true, msg: `已选 "${target}"` };
    }

    // 通用点击：先按 selector 收候选，可选用 item.textContent 在候选中再筛文本（忽略空白差异，
    // 例如页面 "确 定" 中间有空格，传 "确定" 也能命中）。用于"切注册地→点确定→等表单重渲染"
    // 这类结构性预操作。可选 waitForSelector 轮询等异步重挂载完成；postDelay 默认 300ms 兜底。
    async function handleClick(item) {
      const selector = item.selector;
      if (!selector) return { ok: false, error: "缺少 selector" };

      const all = Array.from(document.querySelectorAll(selector));
      const visible = all.filter(isVisible);
      const pool = visible.length > 0 ? visible : all;
      if (pool.length === 0) {
        return { ok: false, error: `未找到 selector="${selector}"` };
      }

      let hit;
      if (item.textContent) {
        const stripSpace = (s) => String(s || "").replace(/\s+/g, "");
        const want = stripSpace(item.textContent);
        hit = pool.find((el) => stripSpace(el.textContent).includes(want));
        if (!hit) {
          const seen = pool
            .map((el) => `"${(el.textContent || "").trim().substring(0, 24)}"`)
            .join(", ");
          return {
            ok: false,
            error:
              `selector="${selector}" 命中 ${pool.length} 个，但无一含文本 "${item.textContent}"。候选: [${seen}]`,
          };
        }
      } else {
        hit = pool[0];
      }

      // skipIfHasClass：点之前先看匹配到的元素是不是已经处于目标状态（如卡片的 "active" class）。
      // 若已处于目标态就跳过不再点击，避免把已选中的选项点一次反而取消选中。
      if (item.skipIfHasClass && hit.classList.contains(item.skipIfHasClass)) {
        const label = (hit.textContent || selector).trim().substring(0, 24);
        return { ok: true, skipped: true, msg: `"${label}" 已有 class="${item.skipIfHasClass}"，跳过点击` };
      }

      hit.click();
      highlight(hit);

      // 可选：轮询等指定 selector 出现（点完后通常会有 Vue 异步重挂载）
      if (item.waitForSelector) {
        const timeout = typeof item.waitTimeout === "number" ? item.waitTimeout : 3000;
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const tgt = document.querySelector(item.waitForSelector);
          if (tgt && isVisible(tgt)) break;
          await sleep(80);
        }
      }

      // 兜底等待（默认 300ms）—— 让 Vue 等异步流程稳定
      const postDelay = typeof item.postDelay === "number" ? item.postDelay : 300;
      if (postDelay > 0) await sleep(postDelay);

      const label = (hit.textContent || selector).trim().substring(0, 24);
      return { ok: true, msg: `已点击 "${label}"` };
    }

    // ----- Run plan -----
    // 五个阶段：
    //   Phase 0 (PRE_CLICK, 串行): click —— 结构性预点击（如切注册地"香港公司"→点"确定"），
    //                      触发 Vue 重渲染。每个 click 自带 postDelay / waitForSelector 控制等待时间，
    //                      跑完整批后额外等 300ms 让任何遗漏的异步流程稳定。
    //   Phase 1 (PRE, 串行): radio —— 选证件类型/性别/国籍等，因为某些 radio 会改变后续表单结构
    //                      （例：证件类型从"法人护照"切到"法人身份证"会重新挂载身份证上传/中文名等输入）
    //                      跑完后等 Vue 完成可能的重渲染再进入 Phase 2
    //   Phase 2 (INSTANT, 并发): text + fileById —— 输入框赋值 + 上传 PDF 都是非弹窗、互不干扰
    //   Phase 3 (POPUP, 串行): datepicker / businessTerm / cascader / select —— 共享 antd 浮层，必须串行
    //   Phase 4 (POST, 串行): 带 afterPopup:true 标记的 item —— 依赖 Phase 3 副作用的字段
    //                      （例：身份证邮编必须在 身份证地址 cascader 选完之后填，否则会被 cascader 的
    //                      change 事件联动清空）
    const PRE_CLICK = new Set(["click"]);
    const PRE = new Set(["radio"]);
    const INSTANT = new Set(["text", "fileById"]);
    const keyOf = (item) => item.key || item.placeholder || item.fieldId || item.type;

    async function runOne(item) {
      try {
        let result;
        switch (item.type) {
          case "click": result = await handleClick(item); break;
          case "text": result = await handleText(item); break;
          case "fileById": result = await handleFile(item); break;
          case "datepicker": result = await handleDatepicker(item); break;
          case "businessTerm": result = await handleBusinessTerm(item); break;
          case "cascader": result = await handleCascader(item); break;
          case "select": result = await handleSelect(item); break;
          case "radio": result = await handleRadio(item); break;
          default: result = { ok: false, error: `未知类型 ${item.type}` };
        }
        if (item.optional && result && !result.ok) {
          return { ok: true, skipped: true, msg: result.error || "可选项未命中，跳过" };
        }
        return result;
      } catch (e) {
        if (item.optional) {
          return { ok: true, skipped: true, msg: e?.message || "可选项异常，跳过" };
        }
        return { ok: false, error: e?.message || String(e) };
      }
    }

    const preClickItems = plan.filter((it) => !it.afterPopup && PRE_CLICK.has(it.type));
    const preItems = plan.filter((it) => !it.afterPopup && PRE.has(it.type));
    const instantItems = plan.filter((it) => !it.afterPopup && !PRE_CLICK.has(it.type) && !PRE.has(it.type) && INSTANT.has(it.type));
    const popupItems = plan.filter((it) => !it.afterPopup && !PRE_CLICK.has(it.type) && !PRE.has(it.type) && !INSTANT.has(it.type));
    const postItems = plan.filter((it) => it.afterPopup);

    // Phase 0: 串行——结构性预点击（如切注册地）。每个 click 已自带 postDelay，整批跑完再等 300ms。
    const preClickResults = [];
    for (const item of preClickItems) {
      const r = await runOne(item);
      preClickResults.push({ key: keyOf(item), ...r });
    }
    if (preClickItems.length > 0) await sleep(300);

    // Phase 1: 串行——结构性 radio（如证件类型）。完成后多等 400ms 让 Vue 重渲染挂载新增 input/upload box
    const preResults = [];
    for (const item of preItems) {
      const r = await runOne(item);
      preResults.push({ key: keyOf(item), ...r });
      await sleep(140);
    }
    if (preItems.length > 0) await sleep(400);

    // Phase 2: 瞬间并发——文本输入与文件上传
    const instantResults = await Promise.all(
      instantItems.map(async (item) => ({ key: keyOf(item), ...(await runOne(item)) }))
    );

    // Phase 3: 串行——日期、营业期限、级联（共享单一弹窗面板）
    const popupResults = [];
    for (const item of popupItems) {
      const r = await runOne(item);
      popupResults.push({ key: keyOf(item), ...r });
      await sleep(120);
    }

    // Phase 4: 串行——afterPopup 标记的后置字段（例：身份证邮编须在 cascader 选完后填）
    // cascader 选完后 Vue 可能还在同步 state；多等 200ms 再填，避免被 change 事件清掉
    if (postItems.length > 0) await sleep(200);
    const postResults = [];
    for (const item of postItems) {
      const r = await runOne(item);
      postResults.push({ key: keyOf(item), ...r });
      await sleep(120);
    }

    // 保持原 plan 顺序输出结果，方便用户对照
    const byKey = new Map();
    for (const r of [...preClickResults, ...preResults, ...instantResults, ...popupResults, ...postResults]) byKey.set(r.key, r);
    const results = plan.map((item) => byKey.get(keyOf(item)) || { key: keyOf(item), ok: false, error: "未执行" });

    return { results };
  }

  // ============================================================================
  // 注入到目标页执行：清空所有可见表单数据
  // 顺序：① 上传删除链接 → ② cascader 清除图标 → ③ 日期清除图标 → ④ select 清除图标
  //      → ⑤ 关闭已开启的 ant-switch → ⑥ 清空所有 input/textarea
  // 返回 { stats: {...}, log: [...] } 供 popup 显示
  // ============================================================================
  async function pageClearForm() {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const fire = (el, types) => types.forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true })));

    function isVisible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.display === "none") return false;
      return r.width > 0 || r.height > 0 || el.offsetParent !== null;
    }

    function setNativeValue(el, value) {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      if (setter) setter.call(el, value);
      else el.value = value;
    }

    const stats = { delete: 0, cascader: 0, date: 0, select: 0, switch: 0, input: 0, textarea: 0 };
    const log = [];

    // 0. 「重新签名」链接 + 弹窗「确定」—— 让服务端重置签名/审核状态，
    //    再开始清空表单字段。这一步只在已签过名/已提交过的页面才会出现这个链接，
    //    没有时静默跳过。
    //    后端流程（参考 user.axisacct.com.har）：
    //      点 确定 → GET integrationByApplyId?applyId=...&reSign=1 → 返回新的 signObj.key
    //      → 页面重新渲染签名块，否则旧签名会一直残留导致一键填充后状态错乱。
    //    DOM 结构：
    //      <a class="ost-link-line ost-text-font14">重新签名</a>
    //      <button class="ant-btn ant-btn-primary"><span>确 定</span></button>  (antd 弹窗)
    const resignLink = Array.from(document.querySelectorAll(".ost-link-line"))
      .find((el) => el.textContent.trim() === "重新签名" && isVisible(el));
    if (resignLink) {
      try {
        resignLink.click();
        stats.resignClicked = 1;
        log.push(`已点击「重新签名」链接`);
        await sleep(350); // 等 antd modal 入场动画 (200~300ms)

        // antd 3.x Modal.confirm 渲染为 .ant-modal-content > .ant-modal-confirm-body-wrapper
        // 用 .ant-modal-content 同时覆盖普通 Modal 和 Modal.confirm，取最近渲染（最后一个）的
        const modals = Array.from(document.querySelectorAll(".ant-modal-content"))
          .filter(isVisible);
        const modal = modals[modals.length - 1];
        if (modal) {
          // 按钮文本是 "确 定"（中间有空格），去掉所有空白再比较
          const confirmBtn = Array.from(modal.querySelectorAll(".ant-btn-primary"))
            .find((el) => isVisible(el)
              && (el.textContent || "").replace(/\s+/g, "") === "确定");
          if (confirmBtn) {
            confirmBtn.click();
            stats.resignConfirmed = 1;
            log.push(`已点击「重新签名」弹窗「确定」`);
            // 等 modal 关闭（轮询 isVisible，最长 2s 兜底）
            const waitStart = Date.now();
            while (Date.now() - waitStart < 2000) {
              const stillVisible = Array.from(document.querySelectorAll(".ant-modal-content"))
                .some(isVisible);
              if (!stillVisible) break;
              await sleep(80);
            }
            // 再给 Vue 一点重渲染时间（页面会拉新的 integrationByApplyId 并刷新签名节点）
            await sleep(300);
          } else {
            log.push(`⚠️「重新签名」弹窗里未找到「确定」按钮，已跳过`);
          }
        } else {
          log.push(`⚠️ 点击「重新签名」后未检测到弹窗，已跳过「确定」步骤`);
        }
      } catch (e) {
        log.push(`⚠️「重新签名」流程异常：${e && e.message || e}`);
      }
    }

    // 1. 文件上传"删除"链接 —— 必须最先点，否则部分 form-item 还处于已上传只读态
    const delLinks = Array.from(document.querySelectorAll("span.text-primary.ost-link-line"))
      .filter((el) => el.textContent.trim() === "删除" && isVisible(el));
    for (const el of delLinks) {
      try { el.click(); stats.delete++; } catch (e) { /* ignore */ }
    }
    if (delLinks.length) log.push(`已点击 ${delLinks.length} 个"删除"链接（文件上传）`);
    await sleep(280);

    // 2. cascader 清除图标 —— antd 默认 hover 才显示，但 onClick 不依赖 hover
    const cascClears = Array.from(document.querySelectorAll(".ant-cascader-picker-clear"));
    for (const el of cascClears) {
      try { el.click(); stats.cascader++; } catch (e) { /* ignore */ }
    }
    if (cascClears.length) log.push(`已点击 ${cascClears.length} 个 cascader 清除图标`);
    await sleep(150);

    // 3. 日期框清除图标
    const dateClears = Array.from(document.querySelectorAll(".ant-calendar-picker-clear"));
    for (const el of dateClears) {
      try { el.click(); stats.date++; } catch (e) { /* ignore */ }
    }
    if (dateClears.length) log.push(`已点击 ${dateClears.length} 个日期清除图标`);
    await sleep(150);

    // 4. select 清除图标（如公司类型有 allowClear）
    const selectClears = Array.from(document.querySelectorAll(".ant-select-selection__clear"));
    for (const el of selectClears) {
      try { el.click(); stats.select++; } catch (e) { /* ignore */ }
    }
    if (selectClears.length) log.push(`已点击 ${selectClears.length} 个 select 清除图标`);
    await sleep(150);

    // 4b. ant-select 多选已选 tag 的删除图标（如"店铺主要经营范围"）
    //     每个已选项形如 <li class="ant-select-selection__choice"> ...
    //         <span class="ant-select-selection__choice__remove">×</span></li>
    //     点 remove span 会移除该 tag。antd 监听 mousedown，所以需要派发 mousedown。
    //     注意：删除会同步更新列表（.choice__remove 节点会被回收），因此每次循环都要重新查询。
    let multiSelectRemoved = 0;
    let safety = 50;
    while (safety-- > 0) {
      const removes = Array.from(document.querySelectorAll(".ant-select-selection__choice__remove"))
        .filter(isVisible);
      if (removes.length === 0) break;
      const el = removes[0];
      try {
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        multiSelectRemoved++;
      } catch (e) { /* ignore */ }
      await sleep(60);
    }
    if (multiSelectRemoved) {
      stats.multiSelectTag = multiSelectRemoved;
      log.push(`已移除 ${multiSelectRemoved} 个多选已选 tag`);
    }
    await sleep(120);

    // 5. 关闭已开启的 ant-switch（如营业期限"长期"开关）
    const switches = Array.from(document.querySelectorAll(".ant-switch.ant-switch-checked"))
      .filter(isVisible);
    for (const el of switches) {
      try { el.click(); stats.switch++; } catch (e) { /* ignore */ }
    }
    if (switches.length) log.push(`已关闭 ${switches.length} 个已开启的开关`);
    await sleep(150);

    // 5b. 取消"长期"按钮（.btn_warp.active）—— 这是自定义 div 按钮，不是 ant-switch
    //     未点击：<div class="btn_warp"><span>长期</span>...</div>
    //     已点击：<div class="btn_warp active">...</div>
    //     再点一次会切回未点击状态。
    const longTermBtns = Array.from(document.querySelectorAll(".btn_warp.active"))
      .filter(isVisible);
    for (const el of longTermBtns) {
      try { el.click(); stats.longTerm = (stats.longTerm || 0) + 1; } catch (e) { /* ignore */ }
    }
    if (longTermBtns.length) log.push(`已取消 ${longTermBtns.length} 个"长期"按钮`);
    await sleep(150);

    // 6. 清空所有可见、非只读、非文件的 input / textarea
    //    cascader/datepicker 的 input 都是 readonly，会被自动跳过 ✓
    //    注意：跳过 ant-select 内部的搜索输入（.ant-select-search__field），
    //    focus 它会触发 antd 把对应 select 弹开。
    const inputs = Array.from(
      document.querySelectorAll("input:not([type='file']):not([readonly]), textarea:not([readonly])")
    );
    for (const el of inputs) {
      if (!isVisible(el)) continue;
      if (!el.value) continue; // 已经是空就跳过，避免无谓事件
      if (el.classList.contains("ant-select-search__field")) continue; // 跳过 select 内部搜索框
      try {
        el.focus();
        setNativeValue(el, "");
        fire(el, ["input", "change", "blur"]);
        if (el.tagName === "TEXTAREA") stats.textarea++;
        else stats.input++;
      } catch (e) { /* ignore */ }
    }
    if (stats.input || stats.textarea) {
      log.push(`已清空 ${stats.input} 个 input、${stats.textarea} 个 textarea`);
    }

    // 7. 兜底：关闭所有仍处于 open 状态的 ant-select 弹层
    //    成因：4b 删除多选 tag 时，点击事件可能让 antd 把 select 切到 open 态；
    //    或之前 autofill 流程异常残留。这里用 document 级 mousedown 触发 rc-trigger
    //    的"点击外部"检测来强制关闭。
    const openSelects = Array.from(document.querySelectorAll(".ant-select.ant-select-open"));
    if (openSelects.length > 0) {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      await sleep(120);
      // 仍未关闭则在每个残留 trigger 上各 toggle 一次
      const stillOpen = Array.from(document.querySelectorAll(".ant-select.ant-select-open"));
      for (const sel of stillOpen) {
        try {
          sel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
          await sleep(40);
          sel.click();
        } catch (e) { /* ignore */ }
      }
      if (openSelects.length) {
        stats.openSelectClosed = openSelects.length;
        log.push(`已关闭 ${openSelects.length} 个 ant-select 残留弹层`);
      }
      await sleep(80);
    }

    return { stats, log };
  }

  // ============================================================================
  // 自动填充模块注册表（积木 dispatcher）
  // ============================================================================
  // 每个 autofillModule ID 对应一份独立的 buildPlan 实现，放在 autofill/ 目录下。
  // 加新销售目的地时只需要：
  //   1) 在 autofill/ 下新建 <id>.js（模板可参考 autofill/poland_seller_center.js）
  //   2) 在下方 AUTOFILL_REGISTRY 加一行 dynamic import
  //   3) 在 requirements.json 新组合的 autofillModule 字段填上该 ID
  // 不需要改 buildAutofillPlan 本身。注册表里没登记的 ID 会在启动时报错（见
  // validateConfigBricks）+ 运行时给出明确错误（见 buildAutofillPlan 的 throw）。
  // ============================================================================
  const AUTOFILL_REGISTRY = {
    poland_seller_center: () => import("./autofill/poland_seller_center.js"),
    france_seller_center: () => import("./autofill/france_seller_center.js"),
  };

  // 启动时校验：每个组合声明的 autofillModule 是否已在 AUTOFILL_REGISTRY 注册。
  // 不通过的组合会在控制台 console.error 列出，方便开发期及时发现 typo / 漏注册。
  // （aiDocTypes / addressLocale / xlsxTemplate 当前 Stage 1 仍是元数据，
  //   等 Sprint 3 / Sprint 4 拆出对应注册表后再扩展本函数。）
  function validateConfigBricks() {
    if (!config || typeof config !== "object") return;
    const issues = [];
    const requirements = config.requirements || {};
    for (const [comboKey, combo] of Object.entries(requirements)) {
      const m = combo && combo.autofillModule;
      if (!m) {
        issues.push(`[${comboKey}] 缺少 autofillModule 字段（requirements.json）`);
      } else if (!AUTOFILL_REGISTRY[m]) {
        issues.push(
          `[${comboKey}] autofillModule "${m}" 未在 popup.js 的 AUTOFILL_REGISTRY 注册` +
          `，请加上：${m}: () => import('./autofill/${m}.js'),`
        );
      }
    }
    if (issues.length > 0) {
      console.error(
        "[配置校验] 发现 " + issues.length + " 个问题：\n  " + issues.join("\n  ")
      );
    } else {
      console.log(
        "[配置校验] 已通过：" + Object.keys(requirements).length +
        " 个组合的 autofillModule 引用均有效"
      );
    }
  }

  // ============================================================================
  // Build the autofill plan from lastValidationResult + lastModulesData
  // ============================================================================
  // 本函数只是 dispatcher：根据当前组合的 autofillModule 字段动态加载对应积木，
  // 把数据 + 通用工具传过去，让积木产出 plan。具体每个销售目的地的 plan 内容
  // 都在 autofill/<id>.js 里定义。
  async function buildAutofillPlan() {
    const moduleId = currentReqConfig?.autofillModule;
    if (!moduleId) {
      throw new Error("当前组合 requirements.json 未配置 autofillModule 字段");
    }
    const loader = AUTOFILL_REGISTRY[moduleId];
    if (!loader) {
      throw new Error(
        `未注册的填充模块: "${moduleId}"\n` +
        `请在 popup.js 顶部 AUTOFILL_REGISTRY 里加上一行：\n` +
        `  ${moduleId}: () => import('./autofill/${moduleId}.js'),`
      );
    }
    let mod;
    try {
      mod = await loader();
    } catch (e) {
      throw new Error(
        `填充模块 ${moduleId} 加载失败：${e?.message || e}\n` +
        `请确认 autofill/${moduleId}.js 文件存在且无语法错误`
      );
    }
    const brick = mod && mod.default;
    if (!brick || typeof brick.buildPlan !== "function") {
      throw new Error(
        `填充模块 ${moduleId} 没有正确导出 default { id, buildPlan(...) }`
      );
    }

    return await brick.buildPlan({
      modulesData: lastModulesData,
      foundFiles: lastValidationResult?.found || [],
      aiData: lastAiData,
      // 当前组合 key（"<国家>|<注册地>"），积木里可据此走条件分支
      // （例：france_seller_center 在 France|HongKong 下需先点"香港公司"→"确定"切表单）
      combinationKey: `${countrySelect.value}|${registrationSelect.value}`,
      utils: {
        splitAddressIntoRegionAndDetail,
        splitHkAddressIntoRegionAndDetail,
        imageFileToPdfBlob,
        buildSinglePagePdfFromJpeg,
        fileToBase64Plain,
      },
    });
  }

  async function runAutofill() {
    const status = document.getElementById("autofill-status");
    const btn = document.getElementById("autofill-btn");
    const setStatus = (msg, kind = "info") => {
      status.textContent = msg;
      status.style.color = kind === "error" ? "#dc2626" : kind === "ok" ? "#16a34a" : "#475569";
    };

    if (!lastModulesData) {
      setStatus("请先完成检查后再点击填充", "error");
      return;
    }

    btn.disabled = true;
    setStatus("⏳ 正在准备数据...");
    try {
      const plan = await buildAutofillPlan();
      console.log("[autofill] plan:", plan.map((p) => ({ ...p, file: p.file ? `[${p.file.name}]` : null })));

      setStatus("⏳ 正在定位目标页面...");
      const { tab, reason } = await pickTargetTab();
      console.log("[autofill] 目标 tab:", tab && tab.id, tab && tab.url, "(reason:", reason, ")");

      if (!tab || !tab.id) {
        try {
          const wins = await chrome.windows.getAll({ populate: true });
          console.warn("[autofill] 未找到目标 tab。当前所有窗口:", wins);
        } catch (e) {
          console.warn("[autofill] chrome.windows.getAll 失败:", e);
        }
        setStatus(
          "未找到目标标签页。请确认：\n" +
          "1) 扩展已在 chrome://extensions 点击🔄 重新加载（manifest 改过后必须重载）\n" +
          "2) 已打开目标网页（http/https），且不是 chrome:// / 应用商店等内部页",
          "error"
        );
        return;
      }

      const url = tab.url || "";
      const isBlocked =
        url.startsWith("chrome://") || url.startsWith("chrome-extension://") ||
        url.startsWith("edge://") || url.startsWith("about:") ||
        url.startsWith("https://chrome.google.com/webstore");
      if (isBlocked) {
        setStatus(
          `❌ 目标页是不可注入的内部页：${url}\n请切到目标网页后，重新点击扩展图标打开 popup 再试`,
          "error"
        );
        return;
      }

      // 填充前先清空整页表单，避免旧值残留导致选择器/日期/上传等状态异常
      setStatus("⏳ 填充前清空页面...");
      try {
        const clearOut = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: pageClearForm,
          args: [],
        });
        const clearRet = clearOut && clearOut[0] && clearOut[0].result;
        if (clearRet && clearRet.stats) {
          const s = clearRet.stats;
          const totalCleared = (s.delete || 0) + (s.cascader || 0) + (s.date || 0) + (s.select || 0)
            + (s.switch || 0) + (s.input || 0) + (s.textarea || 0) + (s.longTerm || 0);
          const resignNote = s.resignConfirmed ? "（含重新签名）" : s.resignClicked ? "（已点重新签名）" : "";
          console.log("[autofill] 清空完成:", clearRet);
          setStatus(`⏳ 已清空 ${totalCleared} 项${resignNote}，等待页面稳定...`);
        }
      } catch (e) {
        console.warn("[autofill] 清空阶段异常（继续填充）:", e);
      }
      // 给 Vue 一点重渲染时间再开始填
      await new Promise((r) => setTimeout(r, 400));

      setStatus(`⏳ 正在注入并执行 ${plan.length} 项填充...`);
      const out = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: pageExecutePlan,
        args: [plan],
      });

      const ret = out && out[0] && out[0].result;
      if (!ret || !Array.isArray(ret.results)) {
        setStatus("❌ 注入失败：未收到页面返回结果", "error");
        return;
      }

      // Summarize results
      const lines = [];
      let okCount = 0, skipCount = 0, errCount = 0;
      for (const r of ret.results) {
        if (r.ok && r.skipped) {
          skipCount++;
          lines.push(`⏭️ ${r.key}: ${r.msg || "跳过"}`);
        } else if (r.ok) {
          okCount++;
          lines.push(`✅ ${r.key}${r.msg ? ": " + r.msg : ""}`);
        } else {
          errCount++;
          lines.push(`❌ ${r.key}: ${r.error || "失败"}`);
        }
      }
      const head = `完成：成功 ${okCount}，跳过 ${skipCount}，失败 ${errCount}`;
      const kind = errCount === 0 ? "ok" : okCount === 0 ? "error" : "info";
      setStatus(head + "\n" + lines.join("\n"), kind);
    } catch (e) {
      console.error(e);
      setStatus(`❌ 异常：${e?.message || e}`, "error");
    } finally {
      btn.disabled = false;
    }
  }

  // ============================================================================
  // 一键清空当前页面所有可见表单数据（注入 pageClearForm 到目标 tab 执行）
  // ============================================================================
  async function runClearForm() {
    const status = document.getElementById("clear-form-status");
    const btn = document.getElementById("clear-form-btn");
    const setStatus = (msg, kind = "info") => {
      status.textContent = msg;
      status.style.color = kind === "error" ? "#dc2626" : kind === "ok" ? "#16a34a" : "#475569";
    };

    btn.disabled = true;
    setStatus("⏳ 定位目标标签页...");
    try {
      const { tab } = await pickTargetTab();
      if (!tab || !tab.id) {
        setStatus("未找到目标标签页。请确认已打开目标网页（http/https），且不是 chrome:// 等内部页", "error");
        return;
      }
      const url = tab.url || "";
      const isBlocked =
        url.startsWith("chrome://") || url.startsWith("chrome-extension://") ||
        url.startsWith("edge://") || url.startsWith("about:") ||
        url.startsWith("https://chrome.google.com/webstore");
      if (isBlocked) {
        setStatus(`❌ 目标页是不可注入的内部页：${url}`, "error");
        return;
      }

      setStatus("⏳ 正在注入并执行清空脚本...");
      const out = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: pageClearForm,
        args: [],
      });

      const ret = out && out[0] && out[0].result;
      if (!ret || !ret.stats) {
        setStatus("❌ 注入失败：未收到页面返回结果", "error");
        return;
      }

      const { stats, log } = ret;
      const total = stats.delete + stats.cascader + stats.date + stats.select + stats.switch + stats.input + stats.textarea;
      // resign 动作不计入 total（它不是「清空字段」），但在 head 末尾附一句说明，
      // 避免「未发现可清空的字段」误导用户以为什么都没发生。
      const resignNote = stats.resignConfirmed ? "，已重新签名" : stats.resignClicked ? "，已点重新签名但未确认" : "";
      const head = total === 0
        ? `完成：页面未发现可清空的字段${resignNote}`
        : `完成：共操作 ${total} 项（删除${stats.delete} / cascader${stats.cascader} / 日期${stats.date} / select${stats.select} / 开关${stats.switch} / input${stats.input} / textarea${stats.textarea}）${resignNote}`;
      const body = (log || []).join("\n");
      const okFlag = total > 0 || !!stats.resignConfirmed;
      setStatus(body ? head + "\n" + body : head, okFlag ? "ok" : "info");
    } catch (e) {
      console.error(e);
      setStatus(`❌ 异常：${e?.message || e}`, "error");
    } finally {
      btn.disabled = false;
    }
  }

  // ============================================================================
  // 委托书圆章面板（仅 placeholders.power_of_attorney.kind=poa_with_seal 的组合显示）
  // - 公司中文名输入框：默认从 公司信息 → 公司名称 字段取，可手动覆盖
  // - 实时章预览（debounced）
  // - 高级参数：章直径 / 红框中心 X-Y / 颜色 / 外圈粗细 / 文字半径比 / 五角星比例 /
  //             弧线跨度 / 字号 / 字体（0 / 自适应 = 用 SealGenerator 内置默认）
  // - 点 「🖨️ 生成委托书 PDF」会把 PDF 用 applyPlaceholder(force=true) 塞回
  //   uploadedFiles + lastValidationResult.found，与「📎 生成临时占位」走同一通道。
  // 全部本地完成，无任何网络依赖；用户分发后即开即用。
  // ============================================================================

  // 最近一次成功生成的章 PNG Blob（供「⬇️ 下载章 PNG」复用，避免重复渲染）
  let lastPoaSealBlob = null;
  // 输入框 debounce 句柄
  let poaSealInputTimer = null;

  // 读取当前面板上的全部参数 —— 章颜色、字号、弧线跨度的 "自适应" 用 0 表示。
  // style 字段（mainland/hk）通过隐藏 input 跟踪：showPoaSealPanel 根据 placeholder 配置写入。
  // englishName 字段仅 HK 模式下可见的输入框（hidden 时取空）；会随 sealOpts 一起塞给 generator。
  //
  // 两种 style 的可调参数不完全一样：
  //   mainland: 外圈粗细 + 五角星比例 + 字体下拉
  //   hk      : 外 / 次外 / 内 三条线粗细 + 底部文本 + 底部字号；字体固定（英文宋体不加粗、中文宋体加粗）
  function readPoaSealParams() {
    const $ = (id) => document.getElementById(id);
    const num = (id) => parseFloat($(id).value);
    const arcDeg = num("poa-seal-arc");
    const fontSize = num("poa-seal-fontsize");
    const styleEl = $("poa-seal-style");
    const style = (styleEl && styleEl.value) || "mainland";
    const enEl = $("poa-seal-english");
    const englishName = (enEl && enEl.value || "").trim();

    // mainland 分支：沿用原有字段
    if (style !== "hk") {
      return {
        companyName: ($("poa-seal-company").value || "").trim(),
        englishName,
        style,
        sealBox: {
          centerX: num("poa-seal-cx"),
          centerY: num("poa-seal-cy"),
          diameter: num("poa-seal-diameter"),
        },
        sealOpts: {
          size: 600,
          color: $("poa-seal-color").value,
          ringWidth: num("poa-seal-ring"),
          textRadiusRatio: num("poa-seal-trr"),
          starRatio: num("poa-seal-star"),
          arcSpan: arcDeg ? (arcDeg * Math.PI / 180) : 0,
          fontSize: fontSize || 0,
          font: $("poa-seal-font").value,
          fontBold: true,
          style,
          englishName,
        },
      };
    }

    // HK 分支：三条边线 + 底部文本（替代五角星） + 固定字体（英文不加粗 / 中文加粗）
    const bottomFs = num("poa-seal-bottom-fontsize");
    // 中心中文名归一化：当公司中文名为空，或与英文名一致（如公司本身就是纯英文名，
    // xlsx 里"公司名称"和"公司英文名称"被填了同一串），则中心留空，只画外圈英文。
    const rawCompany = ($("poa-seal-company").value || "").trim();
    const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
    const sameAsEnglish = rawCompany && englishName && norm(rawCompany) === norm(englishName);
    const effectiveCompany = sameAsEnglish ? "" : rawCompany;
    return {
      companyName: effectiveCompany,
      englishName,
      style,
      sealBox: {
        centerX: num("poa-seal-cx"),
        centerY: num("poa-seal-cy"),
        diameter: num("poa-seal-diameter"),
      },
      sealOpts: {
        size: 600,
        color: $("poa-seal-color").value,
        ringWidth: num("poa-seal-ring"),
        secondaryRingWidth: num("poa-seal-ring2"),
        innerRingWidth: num("poa-seal-ring3"),
        textRadiusRatio: num("poa-seal-trr"),
        arcSpan: arcDeg ? (arcDeg * Math.PI / 180) : 0,
        fontSize: fontSize || 0,
        // 中心中文：宋体加粗（固定，不开放字体选择）
        font: '"SimSun","宋体","STSong","NSimSun",serif',
        fontBold: true,
        // 外圈英文：宋体不加粗（固定）
        enFont: '"SimSun","宋体","STSong","NSimSun",serif',
        enFontBold: false,
        // 底部文本（替代 mainland 的五角星）
        bottomText: ($("poa-seal-bottom-text").value || "").trim(),
        bottomFontSize: bottomFs || 0,
        style,
        englishName,
      },
    };
  }

  // 把 cfg.sealBox / cfg.sealOpts（来自 requirements.json）覆盖到面板默认值上。
  // 缺失字段保持面板初始值（也就是 SEAL_BOX_DEFAULT 同步过来的预设）。
  function applyPoaSealConfigToPanel(cfg) {
    const $ = (id) => document.getElementById(id);
    const setRange = (id, valId, v, fmt) => {
      if (v === undefined || v === null) return;
      $(id).value = v;
      if (valId) $(valId).textContent = fmt ? fmt(v) : v;
    };
    const box = (cfg && cfg.sealBox) || {};
    if (box.centerX !== undefined) setRange("poa-seal-cx", "poa-seal-cx-val", box.centerX);
    if (box.centerY !== undefined) setRange("poa-seal-cy", "poa-seal-cy-val", box.centerY);
    if (box.diameter !== undefined) setRange("poa-seal-diameter", "poa-seal-diameter-val", box.diameter);

    const opts = (cfg && cfg.sealOpts) || {};
    if (opts.color !== undefined) { $("poa-seal-color").value = opts.color; $("poa-seal-color-val").textContent = opts.color; }
    if (opts.ringWidth !== undefined) setRange("poa-seal-ring", "poa-seal-ring-val", opts.ringWidth);
    // HK 专属：次外圈 / 内圈 / 底部文本 / 底部字号
    if (opts.secondaryRingWidth !== undefined) setRange("poa-seal-ring2", "poa-seal-ring2-val", opts.secondaryRingWidth);
    if (opts.innerRingWidth !== undefined) setRange("poa-seal-ring3", "poa-seal-ring3-val", opts.innerRingWidth);
    if (opts.bottomText !== undefined) {
      const el = $("poa-seal-bottom-text"); if (el) el.value = opts.bottomText;
    }
    if (opts.bottomFontSize !== undefined) {
      setRange("poa-seal-bottom-fontsize", "poa-seal-bottom-fontsize-val", opts.bottomFontSize, (v) => v == 0 ? "自适应" : v + "px");
    }
    if (opts.textRadiusRatio !== undefined) setRange("poa-seal-trr", "poa-seal-trr-val", opts.textRadiusRatio);
    if (opts.starRatio !== undefined) setRange("poa-seal-star", "poa-seal-star-val", opts.starRatio);
    if (opts.arcSpan !== undefined) {
      const deg = Math.round(opts.arcSpan * 180 / Math.PI);
      setRange("poa-seal-arc", "poa-seal-arc-val", deg, (v) => v == 0 ? "自适应" : v + "°");
    }
    if (opts.fontSize !== undefined) {
      setRange("poa-seal-fontsize", "poa-seal-fontsize-val", opts.fontSize, (v) => v == 0 ? "自适应" : v + "px");
    }
    if (opts.font !== undefined) {
      const sel = $("poa-seal-font");
      // 若选项里不存在，则不动；让用户感知字体回退
      for (const o of sel.options) if (o.value === opts.font) { sel.value = opts.font; break; }
    }
  }

  // 实时渲染章 PNG 到预览 canvas（公司名为空时不画，提示用户输入）
  async function renderPoaSealPreview() {
    const info = document.getElementById("poa-seal-info");
    const previewCanvas = document.getElementById("poa-seal-canvas");
    if (!window.SealGenerator || !previewCanvas) {
      if (info) { info.textContent = "章生成模块未加载（annex/seal_generator.js）"; info.style.color = "#dc2626"; }
      return;
    }
    const params = readPoaSealParams();
    const pctx = previewCanvas.getContext("2d");
    pctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    // HK 风格的主文本是外圈英文名（中文名可空）；mainland 是中文弧文（必填）
    const mainText = params.style === "hk" ? params.englishName : params.companyName;
    if (!mainText) {
      info.textContent = params.style === "hk"
        ? "请输入公司英文名（中文名可空 → 中心留空）"
        : "请输入公司中文名";
      info.style.color = "#94a3b8";
      lastPoaSealBlob = null;
      return;
    }
    try {
      // generate(name, opts): mainland 用 name 作弧文，HK 用 name 作中心中文（可空），
      // 英文名走 opts.englishName。两种风格统一从 params.companyName 进，由 sealOpts.style 分流。
      const { canvas } = window.SealGenerator.generate(params.companyName, params.sealOpts);
      // 缩放到预览 canvas 大小
      pctx.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);
      lastPoaSealBlob = await new Promise((res) => canvas.toBlob((b) => res(b), "image/png"));
      const sizeKb = lastPoaSealBlob ? (lastPoaSealBlob.size / 1024).toFixed(1) : "?";
      const label = params.style === "hk"
        ? `${params.englishName}${params.companyName ? ` · 中心 "${params.companyName}"` : " · 中心留空"}`
        : params.companyName;
      info.textContent = `${label} · 输出 ${params.sealOpts.size}px · ${sizeKb}KB · 嵌入直径 ${params.sealBox.diameter}pt (≈ ${(params.sealBox.diameter / 72 * 25.4).toFixed(1)}mm)`;
      info.style.color = "";
    } catch (e) {
      info.textContent = "章渲染失败: " + (e.message || e);
      info.style.color = "#dc2626";
      console.error("[poa-seal] render failed:", e);
    }
  }

  // 点击「生成委托书 PDF」：合成 PDF + 通过 applyPlaceholder 塞回 uploadedFiles，
  // 让后续 一键注入 拿到的就是带章的真实委托书。
  async function runGeneratePoaPdf() {
    const btn = document.getElementById("poa-seal-generate");
    const status = document.getElementById("poa-seal-status");
    const frame = document.getElementById("poa-seal-pdf-frame");
    if (!btn || !status) return;

    if (!lastValidationResult) {
      status.textContent = "请先点 「🔍 开始检查」 完成检查，再生成委托书";
      status.style.color = "#dc2626";
      return;
    }

    const params = readPoaSealParams();
    // HK 风格必填英文名（中文可空），mainland 必填中文名
    if (params.style === "hk") {
      if (!params.englishName) {
        status.textContent = "请先填写公司英文名（香港样式必填，会绕外圈一周）";
        status.style.color = "#dc2626";
        return;
      }
    } else if (!params.companyName) {
      status.textContent = "请先填写公司中文名";
      status.style.color = "#dc2626";
      return;
    }

    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = "⏳ 生成中...";
    status.textContent = "正在合成委托书 PDF...";
    status.style.color = "#475569";

    try {
      const file = await applyPlaceholder("power_of_attorney", {
        force: true,
        overrides: {
          companyName: params.companyName,
          // HK 风格走 createPoaWithSealFile 的 cfg.englishName / cfg.style 入口，
          // 透传到 sealOpts 后由 SealGenerator.generate 分流到 renderHK
          englishName: params.englishName,
          style: params.style,
          sealBox: params.sealBox,
          sealOpts: params.sealOpts,
        },
      });
      if (!file) throw new Error("applyPlaceholder 未返回 File（可能 lastValidationResult 缺失）");

      // 把 PDF blob 显示到 iframe 预览
      const blob = new Blob([await file.arrayBuffer()], { type: "application/pdf" });
      if (frame.dataset.objectUrl) URL.revokeObjectURL(frame.dataset.objectUrl);
      const url = URL.createObjectURL(blob);
      frame.dataset.objectUrl = url;
      frame.src = url;
      frame.style.display = "";

      status.textContent = `✅ 已生成 ${file.name}（${(file.size / 1024).toFixed(1)}KB）— 已塞回上传队列，点 「⚡ 一键注入」 即可上传`;
      status.style.color = "#15803d";
    } catch (e) {
      status.textContent = "❌ 生成失败: " + (e.message || e);
      status.style.color = "#dc2626";
      console.error("[poa-seal] generate failed:", e);
    } finally {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }

  // 「⬇️ 下载章 PNG」：把当前预览的 PNG 存到本地
  function downloadPoaSealPng() {
    if (!lastPoaSealBlob) return;
    const params = readPoaSealParams();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(lastPoaSealBlob);
    a.download = `${params.companyName || "章"}_预览.png`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  // DOMContentLoaded 时调用一次：绑定所有输入控件 + 按钮事件。
  function setupPoaSealPanel() {
    const area = document.getElementById("poa-seal-area");
    if (!area) return;

    const $ = (id) => document.getElementById(id);

    // range / color 值变化 → 更新副标签 + 触发预览刷新（debounce）
    const bindLive = (inputId, valId, fmt) => {
      const el = $(inputId);
      const v = valId ? $(valId) : null;
      if (!el) return;
      const upd = () => {
        if (v) v.textContent = fmt ? fmt(el.value) : el.value;
        clearTimeout(poaSealInputTimer);
        poaSealInputTimer = setTimeout(renderPoaSealPreview, 80);
      };
      el.addEventListener("input", upd);
    };
    bindLive("poa-seal-diameter", "poa-seal-diameter-val");
    bindLive("poa-seal-cx", "poa-seal-cx-val");
    bindLive("poa-seal-cy", "poa-seal-cy-val");
    bindLive("poa-seal-color", "poa-seal-color-val");
    bindLive("poa-seal-ring", "poa-seal-ring-val");
    // HK 专属：次外圈、内圈、底部文本字号
    bindLive("poa-seal-ring2", "poa-seal-ring2-val");
    bindLive("poa-seal-ring3", "poa-seal-ring3-val");
    bindLive("poa-seal-bottom-fontsize", "poa-seal-bottom-fontsize-val", (v) => v == 0 ? "自适应" : v + "px");
    bindLive("poa-seal-trr", "poa-seal-trr-val");
    bindLive("poa-seal-star", "poa-seal-star-val");
    bindLive("poa-seal-arc", "poa-seal-arc-val", (v) => v == 0 ? "自适应" : v + "°");
    bindLive("poa-seal-fontsize", "poa-seal-fontsize-val", (v) => v == 0 ? "自适应" : v + "px");
    $("poa-seal-font").addEventListener("change", () => {
      clearTimeout(poaSealInputTimer);
      poaSealInputTimer = setTimeout(renderPoaSealPreview, 0);
    });
    // 底部文本是 text input，用 input 事件监听
    const bottomTextEl = $("poa-seal-bottom-text");
    if (bottomTextEl) {
      bottomTextEl.addEventListener("input", () => {
        clearTimeout(poaSealInputTimer);
        poaSealInputTimer = setTimeout(renderPoaSealPreview, 120);
      });
    }

    // 公司名输入：标记"用户已手动编辑"，避免后续 showPoaSealPanel 二次覆盖
    $("poa-seal-company").addEventListener("input", (e) => {
      e.target.dataset.userEdited = "1";
      clearTimeout(poaSealInputTimer);
      poaSealInputTimer = setTimeout(renderPoaSealPreview, 200);
    });
    // 公司英文名输入（HK 风格独有，mainland 时输入框 display:none）：同样用 userEdited 锁
    const enInput = $("poa-seal-english");
    if (enInput) {
      enInput.addEventListener("input", (e) => {
        e.target.dataset.userEdited = "1";
        clearTimeout(poaSealInputTimer);
        poaSealInputTimer = setTimeout(renderPoaSealPreview, 200);
      });
    }

    // 「↺ 恢复默认」按钮：清掉用户调整，按 requirements.json 的 placeholder 配置重置
    $("poa-seal-reset").addEventListener("click", () => {
      const styleEl = $("poa-seal-style");
      const style = (styleEl && styleEl.value) || "mainland";

      // 通用字段默认值（两种 style 都有）
      const common = {
        "poa-seal-diameter": 150, "poa-seal-cx": 408, "poa-seal-cy": 219,
      };
      // style 专属默认值
      const styleDefaults = style === "hk"
        ? {
            "poa-seal-color": "#333366",     // rgba(51,51,102,1)
            "poa-seal-ring": 17,
            "poa-seal-ring2": 8,
            "poa-seal-ring3": 8,
            "poa-seal-trr": 0.79,
            "poa-seal-arc": 246,
            "poa-seal-fontsize": 77,
            "poa-seal-bottom-fontsize": 100,
          }
        : {
            "poa-seal-color": "#c62828",
            "poa-seal-ring": 8,
            "poa-seal-trr": 0.8,
            "poa-seal-star": 0.39,
            "poa-seal-arc": 300,
            "poa-seal-fontsize": 86,
          };
      const defaults = Object.assign({}, common, styleDefaults);

      for (const [id, v] of Object.entries(defaults)) {
        const el = $(id);
        if (!el) continue;
        el.value = v;
        const valEl = $(id + "-val");
        if (valEl) {
          if (id === "poa-seal-arc") valEl.textContent = v == 0 ? "自适应" : v + "°";
          else if (id === "poa-seal-fontsize" || id === "poa-seal-bottom-fontsize") valEl.textContent = v == 0 ? "自适应" : v + "px";
          else valEl.textContent = v;
        }
      }
      // 底部文本回默认 "*"
      const bottomTextEl = $("poa-seal-bottom-text");
      if (bottomTextEl) bottomTextEl.value = "*";
      // 字体下拉只在 mainland 生效
      const fontEl = $("poa-seal-font");
      if (fontEl) fontEl.selectedIndex = 0;

      // 再用 requirements.json 的 cfg 覆盖（如果配过 sealBox/sealOpts）
      applyPoaSealConfigToPanel(getPlaceholderConfig("power_of_attorney"));
      renderPoaSealPreview();
    });

    $("poa-seal-download-png").addEventListener("click", downloadPoaSealPng);
    $("poa-seal-generate").addEventListener("click", runGeneratePoaPdf);
  }

  // 检查完成后调用：仅在当前组合配了 poa_with_seal placeholder 时显示面板，
  // 并用 lastModulesData 里的公司名作为默认值（用户已手动改过时不覆盖）。
  // showSignaturePanel 在同一次"开始检查"里会被调到两次，本函数同理。
  async function showPoaSealPanel() {
    const area = document.getElementById("poa-seal-area");
    if (!area) return;
    const cfg = getPlaceholderConfig("power_of_attorney");
    if (!cfg || cfg.kind !== "poa_with_seal") {
      area.style.display = "none";
      return;
    }
    area.style.display = "";

    // 章风格路由：requirements.json 在组合 placeholder 上声明 "style": "hk" / "mainland"。
    // 没写 = mainland（向后兼容）。HK 模式下面板会显示「公司英文名」输入框。
    const style = cfg.style || "mainland";
    const styleEl = document.getElementById("poa-seal-style");
    if (styleEl) styleEl.value = style;
    const enRow = document.getElementById("poa-seal-english-row");
    if (enRow) enRow.style.display = (style === "hk") ? "" : "none";
    // HK 专属控件（次/内边线、底部文本、底部字号）与 mainland 专属控件（五角星、字体下拉）
    // 在同一个 grid 里交替显示。grid 的 "label+input+val" 三列一组。
    const hkOnly = document.querySelectorAll(".poa-seal-hk-only");
    const mainlandOnly = document.querySelectorAll(".poa-seal-mainland-only");
    hkOnly.forEach((el) => { el.style.display = (style === "hk") ? "" : "none"; });
    mainlandOnly.forEach((el) => { el.style.display = (style === "hk") ? "none" : ""; });

    // HK 下：若面板当前还是 mainland 的默认值（红色 / ring=8 / star=0.39 / fontSize=86），
    // 切到 HK 时把 UI 设回 HK 的合理默认，避免用户看到"红章+全黑大字"这种诡异过渡形态。
    // 用户已经手动改过？通过 color 是否还是 #c62828 来粗判——过得去即可。
    if (style === "hk") {
      const colorEl = document.getElementById("poa-seal-color");
      if (colorEl && colorEl.value.toLowerCase() === "#c62828") {
        colorEl.value = "#333366";
        const cv = document.getElementById("poa-seal-color-val"); if (cv) cv.textContent = "#333366";
      }
      // 从 mainland 默认值切到 HK 默认值：只在当前值确实是 mainland 的默认时替换，
      // 否则认为是用户已经手动调过（或前一次 HK 留下的值），不动。
      const setIfDefault = (id, valId, mainlandDefault, hkDefault, fmt) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (parseFloat(el.value) === mainlandDefault) {
          el.value = hkDefault;
          const v = document.getElementById(valId);
          if (v) v.textContent = fmt ? fmt(hkDefault) : hkDefault;
        }
      };
      setIfDefault("poa-seal-ring", "poa-seal-ring-val", 8, 17);
      setIfDefault("poa-seal-trr", "poa-seal-trr-val", 0.8, 0.79);
      setIfDefault("poa-seal-arc", "poa-seal-arc-val", 300, 246, (v) => v == 0 ? "自适应" : v + "°");
      setIfDefault("poa-seal-fontsize", "poa-seal-fontsize-val", 86, 77, (v) => v == 0 ? "自适应" : v + "px");
    }

    const titleEl = area.querySelector(".poa-seal-title");
    if (titleEl) {
      titleEl.textContent = style === "hk"
        ? "🔵 委托书圆章 + 盖章（香港样式：外圈英文 + 中心中文）"
        : "🔴 委托书圆章 + 盖章";
    }

    // 用 requirements.json 里 cfg 的 sealBox/sealOpts 覆盖面板（如果有）。
    // HK 组合一般会在配置里把 color 默认成深蓝（#1e3a8a）。
    applyPoaSealConfigToPanel(cfg);

    // 公司中文名：从 lastModulesData 取，仅当用户没改过时回填（mainland/HK 都尝试，HK 时可为空）
    const companyInput = document.getElementById("poa-seal-company");
    const src = cfg.companyNameFrom || { module: "公司信息", field: "公司名称" };
    const company = readModuleField(src.module, src.field);
    if (companyInput.dataset.userEdited !== "1") {
      // HK 模式下：即使取到空也要清空输入框（避免上一次 mainland 残留），让用户看到"中心留空"
      // mainland 模式下：仅当取到非空才覆盖（保持原行为，避免清掉用户输入）
      if (style === "hk") {
        companyInput.value = company || "";
      } else if (company) {
        companyInput.value = company;
      }
    }

    // 公司英文名（HK 专属）：从 cfg.englishNameFrom 取，默认 店铺信息 → 公司英文名称
    if (style === "hk") {
      const enInput = document.getElementById("poa-seal-english");
      if (enInput) {
        const esrc = cfg.englishNameFrom || { module: "店铺信息", field: "公司英文名称" };
        const en = readModuleField(esrc.module, esrc.field);
        if (en && enInput.dataset.userEdited !== "1") {
          enInput.value = en;
        }
      }
    }

    // 等字体加载（系统宋体一般直接 ready）
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (_) {}
    if (window.SealGenerator && window.SealGenerator.preloadFont) {
      try { await window.SealGenerator.preloadFont(readPoaSealParams().sealOpts); } catch (_) {}
    }
    await renderPoaSealPreview();
  }

  // ============================================================================
  // 注入签名（在一键注入按钮下方）
  // 流程：生成手写签名（云烟体） → 上传 imgbb 拿到 https URL → 用 chrome.scripting
  //       注入 MAIN world 的 XHR hook，拦截 /vat/taxGrantInfo/signature/ 返回该 URL
  // 参考：handwriting/test.html v27 验证脚本
  // ============================================================================

  // imgbb 个人 API key（与 handwriting/test.html 一致，仅供该插件调试用）
  // 注意：免费 key 泄漏后他人可在你名下传图，请勿提交进公开仓库
  const IMGBB_API_KEY = "e4160a3203a90187c6e63117bffd66f8";

  // 最近一次生成的签名结果：{ blob, dataURL, canvas }
  let lastSigResult = null;
  let sigInputDebounce = null;

  // 计算签名输入框默认值。优先级（与页面"法人代表信息"模块显示的值保持一致）：
  //   1) lastModulesData → "法人代表信息" 模块 → "法人/个人代表拼音名（英文名）" 字段
  //   2) lastAiData.idCardFront.拼音名（驼峰拼接，例如 "ZhangSan"）
  //   3) lastAiData 的 姓拼音 + " " + 名拼音
  // 任意一级有值即返回；都拿不到则返回 ""，由调用方决定是否兜底 "Zhang San"
  //
  // 拼音归一化：AI 偶尔会把拼音输出成全大写（"WANGJINPING"）或全小写（"wangjinping"），
  // 我们要求签名按"首字母大写其余小写"的驼峰显示（"WangJinPing"）。
  // 规则：一段连续 ASCII 字母序列，若全大写或全小写，则保留第 1 个字母大写、其余强制小写；
  //       若已是混合大小写（如 "WangJinPing"）则维持原样，避免把正确的驼峰切坏。
  //       空格 / 连字符 / 数字等分隔符不处理。
  function normalizePinyinCamel(raw) {
    if (!raw) return "";
    return String(raw).replace(/[A-Za-z]+/g, (word) => {
      if (/^[A-Z]+$/.test(word) || /^[a-z]+$/.test(word)) {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }
      return word; // 混合大小写视为正确驼峰
    });
  }

  function getLegalPersonPinyinDefault() {
    // 1) 模块里展示给用户的字段（buildModuleData 之后才有）
    if (Array.isArray(lastModulesData)) {
      const repModule = lastModulesData.find((m) => m.title === "法人代表信息");
      const pinyinField = repModule && repModule.fields &&
        repModule.fields.find((f) => f.key === "法人/个人代表拼音名（英文名）");
      const v = (pinyinField && pinyinField.value || "").trim();
      if (v) return normalizePinyinCamel(v);
    }
    // 2) AI 原始驼峰拼音
    const front = (lastAiData && lastAiData.idCardFront) || {};
    const full = (front.拼音名 || "").trim();
    if (full) return normalizePinyinCamel(full);
    // 3) 姓 + 名 拼接（兜底）
    const surname = (front.姓拼音 || "").trim();
    const given = (front.名拼音 || "").trim();
    if (surname || given) return [surname, given].filter(Boolean).map(normalizePinyinCamel).join(" ");
    return "";
  }

  // 渲染当前预览（每次调用都用新的随机扰动，所以"再次生成"=重复调用本函数）
  async function renderSignaturePreview() {
    const HW = window.Handwriting;
    const info = document.getElementById("signature-info");
    if (!HW || !HW.generate) {
      info.textContent = "签名模块未加载（缺失 handwriting/index.js）";
      info.style.color = "#dc2626";
      return;
    }
    const nameInput = document.getElementById("signature-name");
    const canvas = document.getElementById("signature-canvas");
    const name = (nameInput.value || "").trim() || "Zhang San";

    try {
      const r = await HW.generate(name, {
        style: "yunyan_real",
        // 与 handwriting/test.html 默认输出尺寸一致，方便目标页签名框直接显示
        width: 752,
        height: 250,
        // 锁 dpr=1 → 输出 PNG 像素严格等于 width×height（上传体积可控）
        dpr: 1,
        transparent: true,
      });
      lastSigResult = r;
      // 把内部 canvas 拷贝到展示 canvas（CSS max-width 会自动缩放至面板宽度）
      canvas.width = r.canvas.width;
      canvas.height = r.canvas.height;
      canvas.getContext("2d").drawImage(r.canvas, 0, 0);
      info.textContent = `${name} · ${r.canvas.width}×${r.canvas.height}px · PNG ${(r.blob.size / 1024).toFixed(1)}KB`;
      info.style.color = "";
    } catch (e) {
      console.error("[signature] render failed:", e);
      info.textContent = "渲染失败：" + (e.message || e);
      info.style.color = "#dc2626";
    }
  }

  // 仅在 DOMContentLoaded 调用一次：绑定输入 / 重新生成 / 注入按钮
  function setupSignaturePanel() {
    const nameInput = document.getElementById("signature-name");
    const regenBtn = document.getElementById("signature-regen-btn");
    const injectBtn = document.getElementById("signature-inject-btn");
    if (!nameInput || !regenBtn || !injectBtn) return;

    nameInput.addEventListener("input", () => {
      // 标记"用户已手动编辑"，showSignaturePanel 后续刷新时不再覆盖（避免清掉用户输入）
      nameInput.dataset.userEdited = "1";
      clearTimeout(sigInputDebounce);
      sigInputDebounce = setTimeout(renderSignaturePreview, 200);
    });
    regenBtn.addEventListener("click", () => {
      // 同名同参数，仅重新随机扰动
      renderSignaturePreview();
    });
    injectBtn.addEventListener("click", runInjectSignature);
  }

  // ============================================================================
  // Tabs（主功能 / 配置）
  // ============================================================================
  function setupTabs() {
    const tabBtns = document.querySelectorAll(".tab-btn");
    const tabPanels = document.querySelectorAll(".tab-panel");
    if (!tabBtns.length) return;

    function showTab(name) {
      tabBtns.forEach(b => {
        const active = b.dataset.tab === name;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", active ? "true" : "false");
      });
      tabPanels.forEach(p => {
        p.classList.toggle("hidden", p.id !== `tab-${name}`);
      });
    }

    tabBtns.forEach(b => {
      b.addEventListener("click", () => showTab(b.dataset.tab));
    });

    // 顶部 banner 里的"前往配置"按钮
    const gotoBtn = document.getElementById("goto-config-btn");
    if (gotoBtn) gotoBtn.addEventListener("click", () => showTab("config"));

    // 暴露给初始化逻辑使用：未配置 API Key 时自动切到 config tab
    setupTabs._show = showTab;
  }

  // ============================================================================
  // 配置 tab 的 API Key 表单：保存 / 测试 / 清除
  // ============================================================================
  function setupConfigForm() {
    const input = document.getElementById("api-key-input");
    const toggleBtn = document.getElementById("api-key-toggle");
    const saveBtn = document.getElementById("api-key-save-btn");
    const clearBtn = document.getElementById("api-key-clear-btn");
    const testBtn = document.getElementById("api-key-test-btn");
    const hint = document.getElementById("api-key-hint");
    const status = document.getElementById("api-key-status");
    if (!input || !saveBtn) return;

    function refreshHint() {
      if (apiKey) {
        // 中间打码：sk-xxxx••••••••xxxx；过短的就直接显示前 6 位 + 省略号
        let masked;
        if (apiKey.length > 14) {
          masked = apiKey.slice(0, 6) + "•".repeat(8) + apiKey.slice(-4);
        } else {
          masked = apiKey.slice(0, 4) + "...";
        }
        hint.textContent = `已配置：${masked}（共 ${apiKey.length} 字符）`;
        hint.className = "form-hint ok";
      } else {
        hint.textContent = "尚未配置";
        hint.className = "form-hint warn";
      }
    }

    function setStatus(msg, kind) {
      status.textContent = msg || "";
      status.className = "config-status" + (kind ? ` ${kind}` : "");
    }

    // 初始化：把当前已加载的 apiKey 回填到输入框（默认 password 隐藏）
    input.value = apiKey || "";
    refreshHint();

    toggleBtn.addEventListener("click", () => {
      if (input.type === "password") {
        input.type = "text";
        toggleBtn.textContent = "🙈";
      } else {
        input.type = "password";
        toggleBtn.textContent = "👁";
      }
    });

    saveBtn.addEventListener("click", async () => {
      const v = (input.value || "").trim();
      if (!v) {
        setStatus("❌ API Key 不能为空", "error");
        return;
      }
      saveBtn.disabled = true;
      try {
        await saveApiKey(v);
        refreshHint();
        updateApiKeyGating();
        // 标准 Moonshot key 是 sk- 开头；不强制阻断保存，只给提示
        if (!/^sk-[A-Za-z0-9_-]{8,}$/.test(v)) {
          setStatus("✅ 已保存\n⚠️ Key 不像标准 sk-... 格式，如调用失败请检查", "warn");
        } else {
          setStatus("✅ 已保存。返回「📄 主功能」即可开始使用。", "ok");
        }
      } finally {
        saveBtn.disabled = false;
      }
    });

    clearBtn.addEventListener("click", async () => {
      if (!confirm("确认清除已保存的 API Key？清除后插件功能将被禁用，需要重新配置才能使用。")) return;
      await clearApiKey();
      input.value = "";
      input.type = "password";
      toggleBtn.textContent = "👁";
      refreshHint();
      updateApiKeyGating();
      setStatus("已清除。请重新配置后再使用插件。", "warn");
    });

    testBtn.addEventListener("click", async () => {
      const v = (input.value || "").trim();
      if (!v) {
        setStatus("❌ 请先填入 API Key 再测试", "error");
        return;
      }
      testBtn.disabled = true;
      setStatus("⏳ 正在验证 Key 是否有效...");
      try {
        const resp = await fetch("https://api.moonshot.cn/v1/users/me/balance", {
          method: "GET",
          headers: { "Authorization": `Bearer ${v}` }
        });
        if (!resp.ok) {
          const errText = await resp.text().catch(() => "");
          setStatus(`❌ 验证失败：${describeMoonshotError(resp.status, errText)}`, "error");
        } else {
          setStatus("✅ Key 有效", "ok");
        }
      } catch (e) {
        setStatus(`❌ 网络异常：${e.message || e}`, "error");
      } finally {
        testBtn.disabled = false;
      }
    });
  }

  // 检查完成后调用：显示面板 + 用法人拼音回填默认值 + 等字体加载并首次渲染
  // 同一次"开始检查"中可能被调用两次：renderAutofillButton 之后（AI 还没出结果） +
  // buildModuleData 之后（拿到拼音名）。第二次调用会刷新默认值。
  async function showSignaturePanel() {
    const area = document.getElementById("signature-area");
    const nameInput = document.getElementById("signature-name");
    if (!area || !nameInput) return;
    area.style.display = "";

    // 用法人拼音回填输入框 — 仅当用户没手动改过时才覆盖
    const def = getLegalPersonPinyinDefault();
    const userEdited = nameInput.dataset.userEdited === "1";
    if (!userEdited) {
      nameInput.value = def || "Zhang San";
    }

    // 等内嵌云烟体加载完，再首次渲染，避免 fallback 字体闪烁
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    } catch (_) {}
    if (window.Handwriting && window.Handwriting.preloadAll) {
      try { await window.Handwriting.preloadAll(); } catch (_) {}
    }
    await renderSignaturePreview();
  }

  // 上传 PNG blob 到 imgbb，返回直链 URL
  // 注意：不传 expiration 参数 → 永久存放（按用户要求）
  async function uploadToImgbb(blob) {
    const fd = new FormData();
    const filename = `signature-${Date.now()}.png`;
    fd.append("image", blob, filename);
    const url = `https://api.imgbb.com/1/upload?key=${encodeURIComponent(IMGBB_API_KEY)}`;
    const res = await fetch(url, { method: "POST", body: fd });
    let json;
    try { json = await res.json(); }
    catch (_) { throw new Error(`imgbb HTTP ${res.status}（响应不是 JSON）`); }
    if (json.success && json.data) {
      // 优先 data.image.url（i.ibb.co 直链，后端 fetch 最稳）
      return (json.data.image && json.data.image.url) || json.data.url || json.data.display_url;
    }
    const errMsg = (json.error && (json.error.message || json.error.context)) || json.status_txt || JSON.stringify(json).slice(0, 200);
    throw new Error(`imgbb 失败 (HTTP ${res.status}): ${errMsg}`);
  }

  // ============================================================================
  // 注入到目标页的 hook 函数（必须自包含，会被 chrome.scripting 序列化到 MAIN world）
  //
  // ★ 一次性引信（one-shot）★
  // 每次插件点【注入签名】 → arm（设 __SIG_HOOK_ARMED=true + 写入 __FAKE_URL）。
  // 下一次目标页发出的 /vat/taxGrantInfo/signature/ 请求被拦截一次后立即 disarm。
  // 用户再点页面【重新签名】时，因为已 disarm，请求直接走原始后端，不会再被插件接管。
  // 想再次注入：插件那边再点【注入签名】，自动重新 arm。
  //
  // hook 本体只挂一次（避免 prototype 多层包装），靠 armed 标志位控制是否生效。
  // ============================================================================
  function pageInstallSignatureHook(targetUrl) {
    // 每次调用都重新 arm + 更新 URL（用户可能重新生成签名再注入，URL 会变）
    window.__FAKE_URL = targetUrl;
    window.__SIG_HOOK_ARMED = true;

    if (window.__signatureHookInstalled) {
      console.log("[signature-hook] 已存在，重新 arm + 更新 URL:", targetUrl);
      return { ok: true, msg: "re-armed", url: targetUrl };
    }

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (m, u) {
      this.__sigUrl = u;
      this.__sigMethod = m;
      return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      const xhr = this;
      // 只在 armed 时拦截一次。命中即立刻 disarm，避免后续【重新签名】被自动接管。
      if (window.__SIG_HOOK_ARMED && xhr.__sigUrl &&
          xhr.__sigUrl.indexOf("/vat/taxGrantInfo/signature/") >= 0) {
        const url = window.__FAKE_URL;
        window.__SIG_HOOK_ARMED = false; // ← 一次性：拦完即卸膛
        const fakeStr = JSON.stringify({ code: 200, success: true, msg: "ok", data: url });
        console.log("[signature-hook] 拦 signature → 注入:", url, "（已 disarm，下次请求走真后端）");
        setTimeout(function () {
          try {
            Object.defineProperty(xhr, "readyState",   { value: 4,       configurable: true });
            Object.defineProperty(xhr, "status",       { value: 200,     configurable: true });
            Object.defineProperty(xhr, "statusText",   { value: "OK",    configurable: true });
            Object.defineProperty(xhr, "responseText", { value: fakeStr, configurable: true });
            Object.defineProperty(xhr, "response",     { value: fakeStr, configurable: true });
            xhr.getAllResponseHeaders = function () { return "content-type: application/json\r\n"; };
            xhr.getResponseHeader = function (n) { return /content-type/i.test(n) ? "application/json" : null; };
            if (xhr.onreadystatechange) xhr.onreadystatechange();
            if (xhr.onload) xhr.onload();
            xhr.dispatchEvent(new Event("load"));
            xhr.dispatchEvent(new Event("loadend"));
          } catch (e) { console.error("[signature-hook] inject err", e); }
        }, 10);
        return;
      }
      return origSend.apply(this, arguments);
    };

    window.__signatureHookInstalled = true;
    console.log(
      "%c[signature-hook] 已安装（一次性模式）。每点一次插件【注入签名】仅拦截下一次 signature 请求。",
      "color:#08f;font-weight:bold;font-size:13px"
    );
    console.log("  本次注入 URL:", targetUrl);
    return { ok: true, msg: "installed", url: targetUrl };
  }

  // 注入签名按钮：上传 imgbb → executeScript 安装 hook
  async function runInjectSignature() {
    const status = document.getElementById("signature-status");
    const btn = document.getElementById("signature-inject-btn");
    const setStatus = (msg, kind = "info") => {
      status.textContent = msg;
      status.style.color = kind === "error" ? "#dc2626" : kind === "ok" ? "#16a34a" : "#475569";
    };

    btn.disabled = true;
    try {
      // 没有签名结果（用户改完输入框还没等到 debounce 触发）→ 立即重新生成一次
      if (!lastSigResult) {
        setStatus("⏳ 还未生成签名，先生成一张...");
        await renderSignaturePreview();
      }
      if (!lastSigResult || !lastSigResult.blob) {
        setStatus("❌ 签名生成失败，请检查输入内容", "error");
        return;
      }

      setStatus("⏳ 正在上传 imgbb...");
      let hostedUrl;
      try {
        hostedUrl = await uploadToImgbb(lastSigResult.blob);
      } catch (e) {
        console.error("[signature] upload err:", e);
        setStatus(`❌ 上传 imgbb 失败：${e.message || e}`, "error");
        return;
      }
      console.log("[signature] imgbb url:", hostedUrl);

      setStatus("⏳ 正在定位目标页面...");
      const { tab, reason } = await pickTargetTab();
      if (!tab || !tab.id) {
        setStatus(
          "未找到目标标签页。请确认已打开目标网页（http/https），且不是 chrome:// 等内部页",
          "error"
        );
        return;
      }
      const url = tab.url || "";
      const isBlocked =
        url.startsWith("chrome://") || url.startsWith("chrome-extension://") ||
        url.startsWith("edge://") || url.startsWith("about:") ||
        url.startsWith("https://chrome.google.com/webstore");
      if (isBlocked) {
        setStatus(`❌ 目标页是不可注入的内部页：${url}`, "error");
        return;
      }

      setStatus(`⏳ 注入 hook 到目标页（${tab.url}）...`);
      let out;
      try {
        out = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          // MAIN world：必须能修改页面自身的 XMLHttpRequest.prototype
          world: "MAIN",
          func: pageInstallSignatureHook,
          args: [hostedUrl],
        });
      } catch (e) {
        console.error("[signature] hook inject err:", e);
        setStatus(`❌ 注入 hook 失败：${e.message || e}`, "error");
        return;
      }
      const ret = out && out[0] && out[0].result;
      if (!ret || !ret.ok) {
        setStatus("❌ 注入失败：未收到目标页返回结果", "error");
        return;
      }
      setStatus(
        `✅ 注入成功（tab: ${reason || "ok"}，状态：${ret.msg || "installed"}）\n` +
        `图床 URL: ${hostedUrl}\n` +
        `提示：本次注入仅生效一次。如需替换签名，请回到本插件再点【注入签名】。`,
        "ok"
      );
    } finally {
      btn.disabled = false;
    }
  }

  // --- File type summary ---
  function renderFileSummary(files) {
    const extCounts = {};
    files.forEach(f => {
      const ext = getFileExtension(f.name) || "其他";
      extCounts[ext] = (extCounts[ext] || 0) + 1;
    });

    const parts = Object.entries(extCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([ext, count]) => `${count}个${ext.replace(".", "")}`);

    const summaryEl = document.getElementById("file-summary");
    summaryEl.textContent = `检查结果：共${files.length}个文件（${parts.join("、")}）`;
  }

  // --- Detection: uses AI for images/PDFs when available, fallback to filename matching ---
  async function detectFiles(uploadedFiles, regConfig) {
    const found = [];
    const missing = [];
    const unmatchedFiles = [...uploadedFiles]; // clone for tracking

    // Helper: try matching an AI label to a requirement and add to found.
    // imageData (base64) and mimeType are stored so we can later run AI extraction
    // (e.g., extracting structured fields from a business license).
    const tryMatch = (file, aiLabel, idx, pageInfo = "", imageData = null, mimeType = null) => {
      if (!aiLabel) return false;
      const matchedReq = regConfig.files.find(req => req.label === aiLabel && !found.some(f => f.key === req.key));
      if (matchedReq) {
        found.push({
          ...matchedReq,
          file: { ...file, path: file.path + pageInfo },
          imageData,
          mimeType
        });
        return true;
      }
      return false;
    };

    if (apiKey) {
      // 预检查余额：避免一上来连着 5 个文件都被 429 拦截。
      const bal = await checkMoonshotBalance();
      const tierStr = bal.tier ? `，账号 tier: ${bal.tier}` : "";
      if (bal.ok && bal.balance <= 0) {
        statusLog(`[余额] 当前可用余额 ${bal.balance.toFixed(2)} 元${tierStr} → 余额不足，请前往 platform.kimi.com/console/account 充值。已跳过 AI 识别。`);
      } else {
        if (!bal.ok) {
          statusLog(`[余额] 查询失败：${bal.message}${tierStr}（仍然尝试调用 AI）`);
        }
        // 余额充足时不再打印 → 避免泄露余额/账号 tier 等敏感信息
        let aiCallCount = 0;
        for (let i = 0; i < unmatchedFiles.length; i++) {
          const file = unmatchedFiles[i];
          if (!file || !(file.file instanceof File)) {
            if (file && (isImageFile(file.name) || getFileExtension(file.name) === ".pdf")) {
              statusLog(`[跳过] ${file.name}: 无 File 对象，无法调用AI`);
            }
            continue;
          }

          const ext = getFileExtension(file.name);

          if (isImageFile(file.name)) {
            // Image: single AI call
            try {
              aiCallCount++;
              statusLog(`[AI] 识别图片: ${file.name}`);
              const base64Data = await readFileAsBase64(file.file);
              const imgMime = ext === ".png" ? "image/png" : "image/jpeg";
              const t0 = Date.now();
              const aiLabel = await detectWithAI(file.name, base64Data);
              statusLog(`[AI] ${file.name} → ${aiLabel || "未识别"}（${Date.now() - t0}ms）`);
              if (tryMatch(file, aiLabel, i, "", base64Data, imgMime)) {
                unmatchedFiles[i] = null;
              }
            } catch (e) {
              statusLog(`[AI] 失败 ${file.name}: ${e.message}`);
            }
          } else if (ext === ".pdf") {
            // PDF: convert each page to image, call AI per page
            try {
              statusLog(`[PDF] 解析 ${file.name}...`);
              const pages = await pdfToImages(file.file);
              const isMultiPage = pages.length > 1;
              statusLog(`[PDF] ${file.name} 共 ${pages.length} 页`);
              let anyMatched = false;
              for (let p = 0; p < pages.length; p++) {
                const pageLabel = isMultiPage ? `第${p + 1}页` : "";
                try {
                  aiCallCount++;
                  statusLog(`[AI] 识别 ${file.name}${pageLabel ? " " + pageLabel : ""}`);
                  const t0 = Date.now();
                  const aiLabel = await detectWithAI("page.jpg", pages[p]);
                  statusLog(`[AI] ${file.name}${pageLabel ? " " + pageLabel : ""} → ${aiLabel || "未识别"}（${Date.now() - t0}ms）`);
                  // 公司章程：通常是几页的长 PDF，命中后立即停止后续页扫描（节省 AI 调用）；
                  // 路径不带 "(第N页)" 后缀 —— 整份 PDF 都是章程内容，上传时也要传整份原文件（fileToPayload
                  // 走 imageFileToPdfBlob 的 PDF no-op 分支），所以不能用单页提取的逻辑。
                  // 防御：仅在当前组合配置了 "公司章程" 需求项（tryMatch 真的命中）时才 break；
                  // 否则继续扫后续页 —— 否则像波兰这种没有 公司章程 需求的组合，AI 偶发误报会
                  // 把多页 PDF（如 身份证正反面）的剩余页全部跳过，造成漏识别。
                  if (aiLabel === "公司章程") {
                    if (tryMatch(file, aiLabel, i, "", pages[p], "image/jpeg")) {
                      anyMatched = true;
                      statusLog(`[AI] ${file.name} 命中公司章程，跳过剩余 ${pages.length - p - 1} 页`);
                      break;
                    }
                    // 当前组合无 公司章程 需求项 → 不 break，继续扫后续页
                  }
                  const pageSuffix = isMultiPage ? ` (第${p + 1}页)` : "";
                  if (tryMatch(file, aiLabel, i, pageSuffix, pages[p], "image/jpeg")) {
                    anyMatched = true;
                  }
                } catch (e) {
                  statusLog(`[AI] 失败 ${file.name}${pageLabel ? " " + pageLabel : ""}: ${e.message}`);
                }
              }
              if (anyMatched) {
                unmatchedFiles[i] = null;
              }
            } catch (e) {
              statusLog(`[PDF] 解析失败 ${file.name}: ${e.message}`);
            }
          } else {
            statusLog(`[跳过] ${file.name}: 非图片/PDF`);
          }
        }
        statusLog(`[AI] 共调用 ${aiCallCount} 次模型`);
      } // end balance ok branch
    } else {
      statusLog(`[AI] 跳过：未配置 API Key`);
    }

    // Filename matching ONLY for non-image/non-PDF formats (e.g., xlsx)
    // Images and PDFs MUST be identified by AI content, never by filename
    for (const fileReq of regConfig.files) {
      if (found.some(f => f.key === fileReq.key)) {
        continue;
      }

      let matchedIdx = -1;
      for (let i = 0; i < unmatchedFiles.length; i++) {
        const f = unmatchedFiles[i];
        if (!f) continue;
        const ext = getFileExtension(f.name);
        // Skip image/PDF files - they must use AI only
        if (isImageFile(f.name) || ext === ".pdf") continue;
        if (!matchesFileRequirement(f.name, fileReq)) continue;
        // 额外内容校验：若 fileReq.xlsxA1Contains 配置了字符串，xlsx 第一个 sheet 的 A1 单元格
        // 必须包含该字符串才算命中。用于区分相同后缀的多份 xlsx（例如把别人发来的另一份 .xlsx
        // 误当成"基础信息表"）。任一环节异常都视为不匹配，让该文件继续在下一个 fileReq 候选中考虑。
        if (fileReq.xlsxA1Contains && ext === ".xlsx" && f.file instanceof File) {
          try {
            const sheet = await loadXlsxSheet(f.file);
            const a1 = getXlsxCell(sheet, "A1");
            if (!a1.includes(fileReq.xlsxA1Contains)) {
              statusLog(`[文件名] ${f.name} 跳过：A1="${a1.slice(0, 40)}" 不含"${fileReq.xlsxA1Contains}"`);
              continue;
            }
          } catch (e) {
            statusLog(`[文件名] ${f.name} 跳过：A1 读取失败 ${e.message}`);
            continue;
          }
        }
        matchedIdx = i;
        break;
      }

      if (matchedIdx >= 0) {
        const matched = unmatchedFiles[matchedIdx];
        found.push({
          ...fileReq,
          file: matched
        });
        unmatchedFiles[matchedIdx] = null;
        statusLog(`[文件名] ${matched.name} → ${fileReq.label}`);
      } else {
        missing.push(fileReq);
      }
    }

    const extra = unmatchedFiles.filter(f => f !== null);

    return { found, missing, extra };
  }

  // ============================================================================
  // Alternatives 解析：互斥文件组（如「身份证正反面」 vs 「护照」二选一）
  // ============================================================================
  // 配置见 requirements.json `alternatives` 字段：每条 alt 列出多个 option，
  // 每个 option 是一组 fileKeys（必须全部识别才算该 option 满足）。
  // 处理规则：
  //   1. 任一 option 完整满足 → 视为 alt 满足，把 alt 涉及的所有 fileKey 从 missing
  //      中剥离（多余 option 的文件不再算"必填"）；
  //   2. 没有任何 option 完整满足 → 同样把 alt 涉及的所有 fileKey 从 missing 剥离，
  //      改为合成单条 missing 项 { _alternative: true, _progress: [...] }，由
  //      renderMissingItems 单独渲染成「缺少法人证件（任选其一）：身份证 (1/2) 或 护照 (0/1)」。
  // 该函数应**幂等**：先剥离上一轮添加的 _alternative 合成项，再重新计算追加，
  // 这样 applyPlaceholder / 多次 runValidation 重复调用不会堆积重复条目。
  // ============================================================================
  function resolveAlternatives(result, alternatives) {
    if (!result || !Array.isArray(result.missing)) return result;
    // 不论入参是否合法，先剥离历史合成项，避免幂等性破坏
    result.missing = result.missing.filter(m => !m._alternative);
    if (!Array.isArray(alternatives) || alternatives.length === 0) return result;

    const foundKeys = new Set((result.found || []).map(f => f.key));

    for (const alt of alternatives) {
      if (!alt || !Array.isArray(alt.options) || alt.options.length === 0) continue;

      // 把该 alt 涉及的所有 fileKey 收成一个集合（用于 missing 剥离）
      const allKeysInAlt = new Set();
      for (const opt of alt.options) {
        for (const k of (opt.fileKeys || [])) allKeysInAlt.add(k);
      }

      // 任一 option fileKeys 全命中 → 视为已满足
      const satisfiedOption = alt.options.find(opt =>
        Array.isArray(opt.fileKeys) && opt.fileKeys.length > 0 &&
        opt.fileKeys.every(k => foundKeys.has(k))
      );

      // 不论是否满足，先把 alt 涉及的所有真实 fileKey 从 missing 剥离
      // （未满足时改用合成项展示，避免 missing 列表里同时出现 3 个相互排斥的零散项）
      result.missing = result.missing.filter(m => !allKeysInAlt.has(m.key));

      if (satisfiedOption) {
        statusLog(`[alternatives] ${alt.label} → 已满足（${satisfiedOption.label}）`);
        continue;
      }

      // 未满足：合成单条 missing，附带各 option 进度信息供 UI 展示
      const progress = alt.options.map(opt => ({
        label: opt.label,
        found: (opt.fileKeys || []).filter(k => foundKeys.has(k)).length,
        total: (opt.fileKeys || []).length
      }));
      result.missing.push({
        key: alt.key,
        label: alt.label,
        required: true,
        _alternative: true,
        _progress: progress
      });
      statusLog(`[alternatives] ${alt.label} → 未满足（${progress.map(p => `${p.label} ${p.found}/${p.total}`).join(' 或 ')}）`);
    }

    return result;
  }

  function renderDetectionResults(result) {
    const container = document.getElementById("detection-list");
    container.innerHTML = "";

    // Matched files: path → label
    result.found.forEach(item => {
      const el = document.createElement("div");
      el.className = "detection-item detection-found";
      el.innerHTML = `
        <span class="detection-path">${item.file.path}</span>
        <span class="detection-arrow">→</span>
        <span class="detection-label">${item.label}</span>
      `;
      container.appendChild(el);
    });

    // Extra (unmatched) files: path → 未识别
    result.extra.forEach(item => {
      const el = document.createElement("div");
      el.className = "detection-item detection-unmatched";
      el.innerHTML = `
        <span class="detection-path">${item.path}</span>
        <span class="detection-arrow">→</span>
        <span class="detection-label detection-unmatched-label">未识别</span>
      `;
      container.appendChild(el);
    });
  }

  function renderMissingItems(missing) {
    const container = document.getElementById("missing-list");
    const area = document.getElementById("missing-area");
    container.innerHTML = "";

    if (missing.length === 0) {
      area.style.display = "none";
      return;
    }

    area.style.display = "";
    missing.forEach(item => {
      const el = document.createElement("div");
      el.className = "missing-item";

      // alternatives 合成项（互斥文件组未满足）：单独一行渲染「任选其一 + 各 option 进度」。
      // 不挂占位按钮（个体文件没法当一组凑齐；用户应直接补传缺失文件）。
      if (item._alternative) {
        const optionsHtml = (item._progress || []).map(p => {
          const ok = p.found > 0 && p.found === p.total;
          const partial = p.found > 0 && p.found < p.total;
          const color = ok ? "#0f172a" : (partial ? "#b45309" : "#94a3b8");
          return `<span style="color:${color}">${escapeHtml(p.label)} (${p.found}/${p.total})</span>`;
        }).join(' <span style="color:#cbd5e1">或</span> ');
        el.innerHTML = `
          <span class="missing-icon">✗</span>
          <span class="missing-label">缺少${escapeHtml(item.label)}（任选其一）：${optionsHtml}</span>
          <span class="missing-badge">必填</span>
        `;
        container.appendChild(el);
        return;
      }

      const placeholderCfg = getPlaceholderConfig(item.key);
      // 委托书盖章 (kind=poa_with_seal) 不再走"📎 生成临时占位"通道：下方专门的
      // 「🔴 委托书圆章 + 盖章」面板已经能合成带章 PDF，再放一个生成临时占位按钮反而冗余
      // 且会让用户拿到一份不带章的空白模板。这里改成纯文字提示，引导用户去面板。
      const isPoaWithSeal = !!placeholderCfg && placeholderCfg.kind === "poa_with_seal";
      const canPlaceholder = !!placeholderCfg && !isPoaWithSeal;
      el.innerHTML = `
        <span class="missing-icon">✗</span>
        <span class="missing-label">缺少${escapeHtml(item.label)}</span>
        ${item.required ? '<span class="missing-badge">必填</span>' : '<span class="missing-badge missing-optional">选填</span>'}
        ${canPlaceholder ? `<button type="button" class="placeholder-btn" data-key="${escapeHtml(item.key)}" title="生成空白占位文件，避免必填卡住流程">📎 生成临时占位</button>` : ''}
        ${isPoaWithSeal ? '<span class="missing-hint">↓ 请在下方「🔴 委托书圆章 + 盖章」面板生成</span>' : ''}
      `;
      container.appendChild(el);
    });

    container.querySelectorAll(".placeholder-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const key = btn.dataset.key;
        btn.disabled = true;
        btn.textContent = "⏳ 生成中...";
        try {
          await applyPlaceholder(key);
        } catch (e) {
          statusLog(`[占位] ${key} 生成失败: ${e.message}`);
          btn.disabled = false;
          btn.textContent = "📎 生成临时占位";
        }
      });
    });
  }

  function renderResultSummary(result) {
    const container = document.getElementById("result-summary");
    const missingRequired = result.missing.filter(f => f.required).length;

    const allRequiredFound = missingRequired === 0;
    const statusClass = allRequiredFound ? "summary-pass" : "summary-fail";
    const statusText = allRequiredFound
      ? "✅ 所有必填文件齐全"
      : `❌ 缺少 ${missingRequired} 个必填文件`;

    container.className = `result-summary ${statusClass}`;
    container.innerHTML = `<div class="summary-status">${statusText}</div>`;
  }

  function hideResults() {
    document.getElementById("result-area").style.display = "none";
    const autofillArea = document.getElementById("autofill-area");
    if (autofillArea) autofillArea.style.display = "none";
    const sigArea = document.getElementById("signature-area");
    if (sigArea) sigArea.style.display = "none";
    const poaArea = document.getElementById("poa-seal-area");
    if (poaArea) poaArea.style.display = "none";
    // 新一轮检查：清掉签名输入框的"用户已编辑"标记，让默认值能被新数据覆盖
    const sigInput = document.getElementById("signature-name");
    if (sigInput) delete sigInput.dataset.userEdited;
    // 同理清掉 委托书圆章 公司名输入框的"用户已编辑"标记
    const poaCompany = document.getElementById("poa-seal-company");
    if (poaCompany) delete poaCompany.dataset.userEdited;
    // 清掉 PDF 预览 iframe 与状态
    const poaFrame = document.getElementById("poa-seal-pdf-frame");
    if (poaFrame) { poaFrame.style.display = "none"; if (poaFrame.dataset.objectUrl) { URL.revokeObjectURL(poaFrame.dataset.objectUrl); delete poaFrame.dataset.objectUrl; } poaFrame.src = ""; }
    const poaStatus = document.getElementById("poa-seal-status");
    if (poaStatus) poaStatus.textContent = "";
    lastValidationResult = null;
    lastModulesData = null;
  }

  // --- File validation helpers ---
  const DOCUMENT_EXTENSIONS = [
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp",
    ".txt", ".csv", ".zip", ".rar", ".7z"
  ];

  function matchesFileRequirement(fileName, fileReq) {
    const lower = fileName.toLowerCase();
    const pattern = fileReq.pattern.toLowerCase();
    switch (fileReq.matchType) {
      case "exact": return lower === pattern;
      case "contains": return lower.includes(pattern);
      case "startsWith": return lower.startsWith(pattern);
      case "endsWith": return lower.endsWith(pattern);
      case "regex": return new RegExp(pattern, "i").test(fileName);
      default: return lower.includes(pattern);
    }
  }

  // --- Init: load config, then restore state ---
  await loadConfig();
  // 加载配置后立即校验每个组合引用的积木是否已注册，不通过也不阻断启动
  // 只在控制台 console.error，让开发期及时发现 autofillModule 拼写错误 / 漏注册。
  validateConfigBricks();
  // 紧接着从 chrome.storage.local 加载 apiKey；loadConfig 必须先跑完，
  // 因为 loadApiKey 内做了一次性迁移：若 storage 里没有但 JSON legacy 字段有，则复制过来
  await loadApiKey();
  // 配置 tab 的 API Key 表单：必须在 loadApiKey 之后初始化，
  // 这样 input 框才能正确回填已保存的 key（修复重开 popup 看似未配置的 bug）
  setupConfigForm();
  initCountrySelect();

  const saved = await loadState();

  // Restore country - programmatically populate and set without triggering cascading events
  if (saved.country && config.countries[saved.country]) {
    countrySelect.value = saved.country;
    // Manually populate registration options
    const regKeys = Object.keys(config.registrations);
    registrationSelect.disabled = false;
    registrationSelect.innerHTML = '<option value="">-- 请选择注册地 --</option>';
    regKeys.forEach(key => {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = config.registrations[key].label;
      registrationSelect.appendChild(opt);
    });

    // Restore registration if saved
    if (saved.registration && config.registrations[saved.registration]) {
      registrationSelect.value = saved.registration;
      const reqKey = `${saved.country}|${saved.registration}`;
      currentReqConfig = config.requirements[reqKey] || null;
      document.getElementById("no-config-warning").style.display = currentReqConfig ? "none" : "";
    }
  }

  // Note: uploaded files are NOT restored across popup sessions because
  // File objects cannot be serialized. User must re-upload each session.
  // Clean up any stale metadata from older versions.
  chrome.storage.local.remove("uploadedFilesMetadata");

  // 应用 API Key 门禁：未配置 → 顶部 banner + 禁用入口按钮；已配置 → 全部启用
  updateApiKeyGating();

  // 首次使用 / 已清除 → 自动切到「⚙️ 配置」tab，引导用户填 Key
  if (!apiKey && setupTabs._show) {
    setupTabs._show("config");
  }
});
;(() => {
  const LEGAL_REP_ID_CARD_TEXT = "法人代表身份证";
  const HIDDEN_ATTR = "data-pltool-hidden-legal-rep-id";

  const normalizeText = (value) => String(value || "").replace(/\s+/g, "");

  const getSelectedContextText = () => {
    if (typeof document === "undefined") return "";

    return Array.from(
      document.querySelectorAll(
        [
          "select",
          "input",
          "textarea",
          "[role='combobox']",
          "[aria-selected='true']",
          "[data-selected='true']",
          ".selected",
          ".active",
        ].join(",")
      )
    )
      .map((element) => {
        const tagName = element.tagName ? element.tagName.toLowerCase() : "";

        if (tagName === "select") {
          return Array.from(element.selectedOptions || [])
            .map((option) => `${option.textContent || ""} ${option.value || ""}`)
            .join(" ");
        }

        if (tagName === "input") {
          const type = (element.type || "").toLowerCase();
          if ((type === "checkbox" || type === "radio") && !element.checked) {
            return "";
          }
        }

        return [
          element.value,
          element.textContent,
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          element.getAttribute("data-value"),
        ]
          .filter(Boolean)
          .join(" ");
      })
      .join(" ");
  };

  const isFrenchHongKongPassportContext = () => {
    if (typeof document === "undefined" || !document.body) return false;

    const selectedText = normalizeText(getSelectedContextText());
    const pageText = normalizeText(document.body.innerText || document.body.textContent || "");
    const hasFrenchHongKong = `${selectedText}${pageText}`.includes("法国")
      && `${selectedText}${pageText}`.includes("香港");
    const selectedPassport = selectedText.includes("护照");
    const labelledPassport = /证件(?:类型)?[^法人代表身份证]{0,30}护照/.test(pageText)
      || /法人代表?证件[^法人代表身份证]{0,30}护照/.test(pageText);

    return hasFrenchHongKong && (selectedPassport || labelledPassport);
  };

  const getHideTarget = (element) => {
    const target = element.closest(
      [
        "[data-requirement-item]",
        "[data-field]",
        ".requirement-item",
        ".requirement-row",
        ".material-item",
        ".field-row",
        ".form-row",
        "li",
        "tr",
      ].join(",")
    );

    if (target && target !== document.body) return target;

    let current = element;
    for (let depth = 0; depth < 4 && current.parentElement; depth += 1) {
      const parent = current.parentElement;
      if (parent === document.body) break;
      if (normalizeText(parent.textContent).length <= 120) return parent;
      current = parent;
    }

    return element;
  };

  const restoreHiddenFields = () => {
    document.querySelectorAll(`[${HIDDEN_ATTR}='true']`).forEach((element) => {
      element.hidden = false;
      element.style.display = element.dataset.pltoolPreviousDisplay || "";
      delete element.dataset.pltoolPreviousDisplay;
      element.removeAttribute(HIDDEN_ATTR);
    });
  };

  const hideLegalRepIdCardFields = () => {
    restoreHiddenFields();

    if (!isFrenchHongKongPassportContext()) return;

    Array.from(document.querySelectorAll("label, li, tr, div, span, p"))
      .filter((element) => {
        const text = normalizeText(element.textContent);
        if (!text.includes(LEGAL_REP_ID_CARD_TEXT)) return false;
        return text.length <= 200 || ["LABEL", "LI", "TR"].includes(element.tagName);
      })
      .map(getHideTarget)
      .forEach((element) => {
        if (element.getAttribute(HIDDEN_ATTR) === "true") return;
        element.dataset.pltoolPreviousDisplay = element.style.display || "";
        element.setAttribute(HIDDEN_ATTR, "true");
        element.hidden = true;
      });
  };

  const startLegalRepIdCardFilter = () => {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", startLegalRepIdCardFilter, { once: true });
      return;
    }

    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        hideLegalRepIdCardFields();
      });
    };

    schedule();
    new MutationObserver(schedule).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["checked", "selected", "value", "class", "aria-selected", "data-selected"],
    });
    document.addEventListener("change", schedule, true);
    document.addEventListener("input", schedule, true);
    document.addEventListener("click", schedule, true);
  };

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startLegalRepIdCardFilter, { once: true });
    } else {
      startLegalRepIdCardFilter();
    }
  }
})();
