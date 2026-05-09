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
  let currentReqConfig = null;
  let config = null;
  let apiKey = "";
  let lastValidationResult = null;
  let lastModulesData = null;
  // 存放 AI 提取的原始字段，供 buildAutofillPlan 使用（特别是显示模块里没有的辅助字段，例如 姓拼音/名拼音）
  let lastAiData = { license: {}, idCardFront: {}, idCardBack: {} };
  // 临时占位文件：label -> File 对象。用户在缺失列表点击"生成临时占位"按钮时填入。
  // 这些文件会被推入 uploadedFiles + lastValidationResult.found，参与一键注入上传。
  let placeholderState = {};

  // 占位文件配置改由 currentReqConfig.placeholders 提供（见 requirements.json）。
  // 这两个 helper 只是从当前组合配置里取值，使下方代码读起来更直观。
  // pdf 用于上传框 accept=".pdf" 的字段（如 完税证明）。
  // png 用于必须保留为图片的字段（如 店铺后台截图，要求 JPG/JPEG/PNG）。
  function getPlaceholderConfig(label) {
    return (currentReqConfig && currentReqConfig.placeholders && currentReqConfig.placeholders[label]) || null;
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
1. 营业执照：图片主体是**一张完整的中国营业执照**，顶部有"营业执照"标题，能看到"统一社会信用代码"或"法定代表人"或"注册资本"等中文字段，通常带红章。
2. 身份证正面：图片主体是**一张中国居民身份证的人像面**，必须能看到清晰的人物头像 + "姓名"、"性别"、"民族"、"出生"、"住址"、"公民身份号码"等中文字段，缺一个关键字段都不算。
3. 身份证反面：图片主体是**一张中国居民身份证的国徽面**，必须能同时看到"中华人民共和国居民身份证"标题 + "签发机关" + "有效期限"中文字段，缺一个都不算。
4. 完税证明：图片主体是**一张完税证明文件**，标题含"完税证明"或"税收完税证明"，包含纳税人、税款等中文字段。

**必须返回"未知类型"的情况（强制）：**
- 网页截图、浏览器界面、后台管理系统、卖家中心、商家中心、表单、Dashboard
- 英文界面、英文表单、英文文档（中国证件全部是中文，看到大量英文几乎可断定不是）
- Excel / Word / PPT 截图、表格列表
- 仅看到证件的某一栏、某个字段、缩略图、预览图
- 看不清完整证件原件、模糊不清、被严重遮挡
- 不满足上述4种类型字段要求的任何图片

**判断步骤（必须严格遵守）：**
1. 先看图片整体：是网页UI还是单一文档？是网页/UI → 直接"未知类型"
2. 再看语言：满屏英文 → "未知类型"
3. 最后核对该类型要求的中文字段是否**全部**可见，缺任何一个 → "未知类型"

只输出以下之一，不要任何解释、不要任何标点：
营业执照
身份证正面
身份证反面
完税证明
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

      // Map AI response to label
      const typeMapping = {
        '营业执照': '营业执照',
        '身份证正面': '身份证正面',
        '身份证反面': '身份证反面',
        '完税证明': '完税证明',
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
  function initCountrySelect() {
    Object.keys(config.countries).forEach(key => {
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

    const regKeys = Object.keys(config.registrations);
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
      saveState(); // saves metadata only
      updateFileCount();
      updateValidateBtn();
      hideResults();
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
      fileCountText.textContent = `已选择 ${uploadedFiles.length} 个文件`;
      uploadArea.classList.add("has-files");
    } else {
      fileCount.style.display = "none";
      uploadArea.classList.remove("has-files");
    }
  }

  clearFilesBtn.addEventListener("click", () => {
    uploadedFiles = [];
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

  // 顶部 tabs（主功能 / 配置）+ 配置 tab 的 API Key 表单
  setupTabs();
  setupConfigForm();

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
    // 省缺失时反查：身份证/营业执照地址常省略省份（如"广州市白云区..."），
    // cascader 第 1 级必须是省，否则会抛 `cascader 第 1 级匹配不到`。
    // 用地级市→省 反向表补全省级，让 cascader 能定位完整三级。
    if (!province && city) {
      const provMap = (typeof window !== "undefined" && window.CHINA_PREFECTURE_TO_PROVINCE) || {};
      if (provMap[city]) province = provMap[city];
    }
    const region = [province, city, district].filter(Boolean).join(" / ");
    return { region, detail: rest.trim() };
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
  "出生日期": "出生日期，输出格式 YYYY-MM-DD（如 1990-01-15）。",
  "身份证号": "18位身份证号码，纯数字（最后一位可能是X，保持大写）。",
  "住址": "住址字段的完整原文。"
}

只输出JSON对象，不要任何额外解释。每个字段如果识别不到，值为null。`;
    return callVisionJson(base64Data, mimeType, prompt, "AI身份证正面");
  }

  // AI: extract structured fields from a 身份证反面 (国徽面) image
  async function extractIdCardBackFields(base64Data, mimeType) {
    const prompt = `这是一张中国居民身份证国徽面图片。请识别"有效期限"字段，以严格的JSON格式输出：
{
  "有效期限": "身份证有效期限原文，例如'2020.05.20-2040.05.20'、'2020.05.20-长期'。保持原始分隔符与格式。"
}

只输出JSON对象，不要任何额外解释。识别不到值为null。`;
    return callVisionJson(base64Data, mimeType, prompt, "AI身份证反面");
  }

  // AI: extract structured fields from a 营业执照 image
  async function extractBusinessLicenseFields(base64Data, mimeType) {
    if (!apiKey || !base64Data) return {};
    const prompt = `这是一张中国营业执照图片。请仔细识别图中的字段，以严格的JSON格式输出以下信息：
{
  "类型": "公司类型，例如'有限责任公司'、'有限责任公司(自然人投资或控股)'、'个体工商户'、'股份有限公司'等。原样输出执照上写的内容。",
  "成立日期": "成立日期或注册日期，输出格式 YYYY-MM-DD（如 2024-09-15）。如果只有'注册日期'就用注册日期。",
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
    const xlsxFound = result.found.find(f => f.label === "基础信息表");
    if (xlsxFound && xlsxFound.file && xlsxFound.file.file instanceof File) {
      try {
        sheet = await loadXlsxSheet(xlsxFound.file.file);
      } catch (e) {
        statusLog(`[解析] xlsx 失败: ${e.message}`);
      }
    }

    // Source: AI license fields (only call if 营业执照 has imageData)
    let aiLicense = {};
    const licenseFound = result.found.find(f => f.label === "营业执照");
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
    const idFrontFound = result.found.find(f => f.label === "身份证正面");
    if (idFrontFound && idFrontFound.imageData) {
      statusLog(`[AI提取] 解析身份证正面字段...`);
      const t0 = Date.now();
      aiIdCardFront = await extractIdCardFrontFields(idFrontFound.imageData, idFrontFound.mimeType);
      statusLog(`[AI提取] 完成（${Date.now() - t0}ms）`);
    }

    // Source: AI 身份证反面 fields
    let aiIdCardBack = {};
    const idBackFound = result.found.find(f => f.label === "身份证反面");
    if (idBackFound && idBackFound.imageData) {
      statusLog(`[AI提取] 解析身份证反面字段...`);
      const t0 = Date.now();
      aiIdCardBack = await extractIdCardBackFields(idBackFound.imageData, idBackFound.mimeType);
      statusLog(`[AI提取] 完成（${Date.now() - t0}ms）`);
    }

    // 持久化原始 AI 结果，供后续 buildAutofillPlan 使用（如 姓拼音 / 名拼音 不在显示模块里）
    lastAiData = {
      license: aiLicense || {},
      idCardFront: aiIdCardFront || {},
      idCardBack: aiIdCardBack || {}
    };

    // Document-type label for "上传法人代表证件信息":
    // - If either side of 身份证 is detected → "法人身份证"
    // - (passport detection not implemented yet; leave blank otherwise)
    const idCardOrPassportLabel = (idFrontFound || idBackFound) ? "法人身份证" : "";

    // Build modules
    const modulesData = [];
    for (const mod of getCurrentModules()) {
      const fields = [];
      for (const f of mod.fields) {
        let value = "";
        switch (f.source) {
          case "xlsx":
            value = getXlsxCell(sheet, f.cell);
            break;
          case "file_path": {
            const item = result.found.find(x => x.label === f.label);
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
    } catch (e) {
      statusLog(`[模块] 构建失败: ${e.message}`);
      lastModulesData = null;
      renderModules(null);
    }
  }

  // Show autofill button when there is at least something in 公司信息 to push to the page.
  function renderAutofillButton(result) {
    const area = document.getElementById("autofill-area");
    const status = document.getElementById("autofill-status");
    const btn = document.getElementById("autofill-btn");
    const license = result?.found?.find(f => f.label === "营业执照");
    const taxRes = result?.found?.find(f => f.label === "完税证明" || f.label === "中国税收居民身份证明");
    const shopShot = result?.found?.find(f => f.label === "店铺后台截图");
    const hasLicenseFile = license && license.file && license.file.file instanceof File;
    const hasTaxFile = taxRes && taxRes.file && taxRes.file.file instanceof File;
    const hasShopShotFile = shopShot && shopShot.file && shopShot.file.file instanceof File;

    const isImg = (n) => /\.(jpe?g|png|gif|webp|bmp)$/i.test(n || "");
    const tag = (item) => item?.placeholder ? "（临时占位）" : "";
    area.style.display = "";
    btn.disabled = false;
    const lines = [];
    lines.push(`营业执照文件：${hasLicenseFile ? "✅ " + license.file.name + tag(license) + (isImg(license.file.name) ? "（图片→自动转 PDF）" : "") : "⚠️ 未识别（不会上传文件）"}`);
    lines.push(`中国税收居民身份证明：${hasTaxFile ? "✅ " + taxRes.file.name + tag(taxRes) + (isImg(taxRes.file.name) ? "（图片→自动转 PDF）" : "") : "⚠️ 未识别（不会上传文件）"}`);
    lines.push(`店铺后台截图：${hasShopShotFile ? "✅ " + shopShot.file.name + tag(shopShot) : "⚠️ 未识别（不会上传文件）"}`);
    lines.push("点击按钮：填充文本字段 + 上传文件 + 选择日期 / 省市区");
    status.textContent = lines.join("\n");
    status.style.color = "#475569";

    // 同步显示签名面板，并用 AI 提取的法人拼音作为默认值（不阻塞主流程）
    showSignaturePanel().catch((e) => console.warn("[signature] showPanel err:", e));
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

  async function generatePlaceholderFile(label) {
    const cfg = getPlaceholderConfig(label);
    if (!cfg) throw new Error(`未配置占位生成: ${label}`);
    if (cfg.kind === "pdf") return createBlankPdfFile(cfg.filename, cfg.text);
    if (cfg.kind === "png") return createBlankPngFile(cfg.filename, cfg.text);
    throw new Error(`未知占位类型: ${cfg.kind}`);
  }

  // 在缺失项上生成临时占位文件，并把它"塞回" uploadedFiles 与 lastValidationResult，
  // 让后续渲染、模块构建、一键注入都能像识别成功一样使用它。
  async function applyPlaceholder(label) {
    if (!lastValidationResult) {
      statusLog(`[占位] 请先完成检查再生成 ${label}`);
      return;
    }
    if (lastValidationResult.found.some(f => f.label === label)) {
      statusLog(`[占位] ${label} 已存在，跳过`);
      return;
    }

    const file = await generatePlaceholderFile(label);
    placeholderState[label] = file;

    const fileMeta = {
      name: file.name,
      path: `(临时占位) ${file.name}`,
      size: file.size,
      file,
      placeholder: true
    };
    uploadedFiles.push(fileMeta);

    const req = (currentReqConfig?.files || []).find(r => r.label === label) || {
      pattern: label, label, required: true, matchType: "contains"
    };
    lastValidationResult.found.push({
      ...req,
      file: fileMeta,
      placeholder: true
    });
    lastValidationResult.missing = lastValidationResult.missing.filter(m => m.label !== label);

    statusLog(`[占位] 已生成 ${label} → ${file.name}（${file.size} 字节）`);

    updateFileCount();
    renderDetectionResults(lastValidationResult);
    renderMissingItems(lastValidationResult.missing);
    renderResultSummary(lastValidationResult);
    renderAutofillButton(lastValidationResult);
    refreshFilePathModuleFields();
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
          const item = lastValidationResult.found.find(x => x.label === fcfg.label);
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
      // 定位优先级：xpath（最精确） > labelText（按表单标签 + elementSelector） > placeholder（全局首个匹配）
      let input = null;
      let how = "";
      if (item.xpath) {
        input = findByXPath(item.xpath);
        if (input) how = "xpath";
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

      // Find by placeholder span (always present in DOM, even when hidden behind a selected value)
      const phSpans = document.querySelectorAll(".ant-select-selection__placeholder");
      let trigger = null;
      for (const sp of phSpans) {
        const t = (sp.textContent || "").trim();
        if (t === item.placeholder || t.includes(item.placeholder)) {
          trigger = sp.closest(".ant-select");
          if (trigger) break;
        }
      }
      if (!trigger) return { ok: false, error: `未找到 ant-select placeholder="${item.placeholder}"` };

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

      const value = String(item.value);
      const optTexts = lis.map((li) => (li.textContent || "").trim());

      // 1. Exact match wins
      let idx = optTexts.indexOf(value);
      // 2. Otherwise pick the highest-F1 option (must clear a low threshold to avoid garbage)
      if (idx < 0) {
        let bestScore = 0, bestIdx = -1;
        for (let i = 0; i < optTexts.length; i++) {
          const s = score(value, optTexts[i]);
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
      // 优先用 labelText 精确定位（多个 cascader 共享同一 placeholder 时必须用 label 区分）
      let input = null;
      if (item.labelText) {
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

        const target = matchItem(items, valueStr);
        if (!target) {
          if (level === 0) return { ok: false, error: `cascader 第 1 级匹配不到 (value="${valueStr}")` };
          // Otherwise allow partial match (e.g., only province/city, no district)
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

    // ----- Run plan -----
    // 四个阶段：
    //   Phase 0 (PRE, 串行): radio —— 先选证件类型/性别/国籍等，因为某些 radio 会改变后续表单结构
    //                      （例：证件类型从"法人护照"切到"法人身份证"会重新挂载身份证上传/中文名等输入）
    //                      跑完后等 Vue 完成可能的重渲染再进入 Phase 1
    //   Phase 1 (INSTANT, 并发): text + fileById —— 输入框赋值 + 上传 PDF 都是非弹窗、互不干扰
    //   Phase 2 (POPUP, 串行): datepicker / businessTerm / cascader / select —— 共享 antd 浮层，必须串行
    //   Phase 3 (POST, 串行): 带 afterPopup:true 标记的 item —— 依赖 Phase 2 副作用的字段
    //                      （例：身份证邮编必须在 身份证地址 cascader 选完之后填，否则会被 cascader 的
    //                      change 事件联动清空）
    const PRE = new Set(["radio"]);
    const INSTANT = new Set(["text", "fileById"]);
    const keyOf = (item) => item.key || item.placeholder || item.fieldId || item.type;

    async function runOne(item) {
      try {
        switch (item.type) {
          case "text": return await handleText(item);
          case "fileById": return await handleFile(item);
          case "datepicker": return await handleDatepicker(item);
          case "businessTerm": return await handleBusinessTerm(item);
          case "cascader": return await handleCascader(item);
          case "select": return await handleSelect(item);
          case "radio": return await handleRadio(item);
          default: return { ok: false, error: `未知类型 ${item.type}` };
        }
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    }

    const preItems = plan.filter((it) => !it.afterPopup && PRE.has(it.type));
    const instantItems = plan.filter((it) => !it.afterPopup && !PRE.has(it.type) && INSTANT.has(it.type));
    const popupItems = plan.filter((it) => !it.afterPopup && !PRE.has(it.type) && !INSTANT.has(it.type));
    const postItems = plan.filter((it) => it.afterPopup);

    // Phase 0: 串行——结构性 radio（如证件类型）。完成后多等 400ms 让 Vue 重渲染挂载新增 input/upload box
    const preResults = [];
    for (const item of preItems) {
      const r = await runOne(item);
      preResults.push({ key: keyOf(item), ...r });
      await sleep(140);
    }
    if (preItems.length > 0) await sleep(400);

    // Phase 1: 瞬间并发——文本输入与文件上传
    const instantResults = await Promise.all(
      instantItems.map(async (item) => ({ key: keyOf(item), ...(await runOne(item)) }))
    );

    // Phase 2: 串行——日期、营业期限、级联（共享单一弹窗面板）
    const popupResults = [];
    for (const item of popupItems) {
      const r = await runOne(item);
      popupResults.push({ key: keyOf(item), ...r });
      await sleep(120);
    }

    // Phase 3: 串行——afterPopup 标记的后置字段（例：身份证邮编须在 cascader 选完后填）
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
    for (const r of [...preResults, ...instantResults, ...popupResults, ...postResults]) byKey.set(r.key, r);
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
  // Build the autofill plan from lastValidationResult + lastModulesData
  // ============================================================================
  async function buildAutofillPlan() {
    const moduleData = (lastModulesData || []).find((m) => m.title === "公司信息");
    const fields = moduleData?.fields || [];
    const get = (key) => (fields.find((f) => f.key === key)?.value || "").trim();

    const license = lastValidationResult?.found?.find((f) => f.label === "营业执照");
    const taxRes = lastValidationResult?.found?.find((f) => f.label === "完税证明" || f.label === "中国税收居民身份证明");

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
          converted: true
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
    const shopScreenshot = lastValidationResult?.found?.find((f) => f.label === "店铺后台截图");
    const shopScreenshotPayload = await fileToPayload(shopScreenshot, { keepImage: true });

    // 公司/个体经营注册地址(中文) 表单含 cascader(省市区) + textarea(详细地址)
    // AI 提取的"住所"是完整地址，需要拆分成两段分别填入。
    const regAddrSplit = splitAddressIntoRegionAndDetail(get("公司/个体经营注册地址(中文)"));

    // ============== 法人代表信息（来自 lastModulesData["法人代表信息"] + lastValidationResult + lastAiData） ==============
    const repModule = (lastModulesData || []).find((m) => m.title === "法人代表信息");
    const repFields = repModule?.fields || [];
    const getRep = (key) => (repFields.find((f) => f.key === key)?.value || "").trim();

    const idFront = lastValidationResult?.found?.find((f) => f.label === "身份证正面");
    const idBack = lastValidationResult?.found?.find((f) => f.label === "身份证反面");
    const idFrontPayload = await fileToPayload(idFront);
    const idBackPayload = await fileToPayload(idBack);

    // 拼音姓 / 拼音名：优先用 AI 直接给的两段，缺失时按"首字母大写音节"拆分（仅保 1+rest 拆分，复姓识别交给 AI）
    const aiFront = lastAiData.idCardFront || {};
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

    // ============== 店铺信息（来自 lastModulesData["店铺信息"]） ==============
    const shopModule = (lastModulesData || []).find((m) => m.title === "店铺信息");
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
      { type: "text", key: "法人/个人代表身份证地址-详细", placeholder: "请输入法人身份证上的住址", elementSelector: "textarea", value: idAddrSplit.detail },

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
      // 若 lastValidationResult 中没有该项（用户未点击"生成临时占位"且未自行上传），file 为 null，
      // handleFile 会以 "无文件，跳过" 优雅跳过。
      { type: "fileById", key: "店铺后台截图", labelFallback: "店铺后台截图", file: shopScreenshotPayload },
    ];

    return plan;
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
          console.log("[autofill] 清空完成:", clearRet);
          setStatus(`⏳ 已清空 ${totalCleared} 项，等待页面稳定...`);
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
      const head = total === 0
        ? "完成：页面未发现可清空的字段"
        : `完成：共操作 ${total} 项（删除${stats.delete} / cascader${stats.cascader} / 日期${stats.date} / select${stats.select} / 开关${stats.switch} / input${stats.input} / textarea${stats.textarea}）`;
      const body = (log || []).join("\n");
      setStatus(body ? head + "\n" + body : head, total > 0 ? "ok" : "info");
    } catch (e) {
      console.error(e);
      setStatus(`❌ 异常：${e?.message || e}`, "error");
    } finally {
      btn.disabled = false;
    }
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
  function getLegalPersonPinyinDefault() {
    // 1) 模块里展示给用户的字段（buildModuleData 之后才有）
    if (Array.isArray(lastModulesData)) {
      const repModule = lastModulesData.find((m) => m.title === "法人代表信息");
      const pinyinField = repModule && repModule.fields &&
        repModule.fields.find((f) => f.key === "法人/个人代表拼音名（英文名）");
      const v = (pinyinField && pinyinField.value || "").trim();
      if (v) return v;
    }
    // 2) AI 原始驼峰拼音
    const front = (lastAiData && lastAiData.idCardFront) || {};
    const full = (front.拼音名 || "").trim();
    if (full) return full;
    // 3) 姓 + 名 拼接（兜底）
    const surname = (front.姓拼音 || "").trim();
    const given = (front.名拼音 || "").trim();
    if (surname || given) return [surname, given].filter(Boolean).join(" ");
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
      const matchedReq = regConfig.files.find(req => req.label === aiLabel && !found.some(f => f.label === req.label));
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
      if (found.some(f => f.label === fileReq.label)) {
        continue;
      }

      let matchedIdx = -1;
      for (let i = 0; i < unmatchedFiles.length; i++) {
        const f = unmatchedFiles[i];
        if (!f) continue;
        const ext = getFileExtension(f.name);
        // Skip image/PDF files - they must use AI only
        if (isImageFile(f.name) || ext === ".pdf") continue;
        if (matchesFileRequirement(f.name, fileReq)) {
          matchedIdx = i;
          break;
        }
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
      const canPlaceholder = !!getPlaceholderConfig(item.label);
      el.innerHTML = `
        <span class="missing-icon">✗</span>
        <span class="missing-label">缺少${escapeHtml(item.label)}</span>
        ${item.required ? '<span class="missing-badge">必填</span>' : '<span class="missing-badge missing-optional">选填</span>'}
        ${canPlaceholder ? `<button type="button" class="placeholder-btn" data-label="${escapeHtml(item.label)}" title="生成空白占位文件，避免必填卡住流程">📎 生成临时占位</button>` : ''}
      `;
      container.appendChild(el);
    });

    container.querySelectorAll(".placeholder-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const label = btn.dataset.label;
        btn.disabled = true;
        btn.textContent = "⏳ 生成中...";
        try {
          await applyPlaceholder(label);
        } catch (e) {
          statusLog(`[占位] ${label} 生成失败: ${e.message}`);
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
    // 新一轮检查：清掉签名输入框的"用户已编辑"标记，让默认值能被新数据覆盖
    const sigInput = document.getElementById("signature-name");
    if (sigInput) delete sigInput.dataset.userEdited;
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
  // 紧接着从 chrome.storage.local 加载 apiKey；loadConfig 必须先跑完，
  // 因为 loadApiKey 内做了一次性迁移：若 storage 里没有但 JSON legacy 字段有，则复制过来
  await loadApiKey();
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
