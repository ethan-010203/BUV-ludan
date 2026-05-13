# 📄 录单助手 · Document Checker

> Chrome 扩展（Manifest V3）。给跨境电商「录单」场景的开发助手——按 **国家 × 注册地** 组合检查上传材料齐全度，AI 识别营业执照 / 身份证 / 完税证明 / 公司章程等关键证件，并把识别结果一键回填到目标平台的卖家中心；同时支持手写签名生成 + 注入、委托书自动盖章合成。

当前已支持组合：**`Poland|China`（波兰销售 × 中国大陆注册）**、**`France|China`（法国销售 × 中国大陆注册）**、**`France|HongKong`（法国销售 × 香港注册）**。加新组合的标准流程见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

---

## ✨ 核心功能

| # | 功能 | 说明 |
|---|---|---|
| 1 | **国家 × 注册地组合** | 不同组合（如 `Poland\|China`、`France\|China`、`France\|HongKong`）有不同的必填字段、必备文件、识别项、填表计划 |
| 2 | **拖拽文件夹上传** | 支持文件夹和单个文件，前端纯 JS 处理 |
| 3 | **AI 文档识别** | 调 Moonshot（Kimi）vision 模型识别营业执照 / 身份证正反面 / 完税证明 / 公司章程 / 香港公司注册证书 CR / 护照等，输出结构化 JSON |
| 4 | **PDF 多页识别** | 通过 `pdf.js` 拆页转图后逐页送 AI |
| 5 | **xlsx 模板读取** | 读"基础信息表"单元格回填字段，支持 `fallbackCell` 主 cell 取空时按序回退备选 cell |
| 6 | **缺失文件兜底** | 必填项缺失时可生成临时空白占位文件（jpg/pdf/png） |
| 7 | **互斥文件组（二选一）** | 通过 `alternatives` 声明"身份证（正反面）**或**护照"这类二选一必填组，进度面板合成 `法人证件 (1/2)` 单行呈现 |
| 8 | **委托书自动盖章** | `pdf-lib` 加载委托书 PDF 模板 + Canvas 生成公司圆章 → 合成带章 PDF；支持两种风格：大陆红章（弧形中文名 + 中心五角星）与香港深蓝章（弧形英文名 + 中心多行中文名 + 底部小星） |
| 9 | **一键注入卖家中心** | 把识别 + 表格的字段按组合对应的 `autofill/<id>.js` 计划批量填到当前页面（DOM + cascader + 上传框） |
| 10 | **身份流分支（identityFlow）** | 根据 AI 识别到的证件自动切换「身份证流程」或「护照流程」，字段级 `showIf` 控制各字段是否渲染（仅 `France\|HongKong` 使用） |
| 11 | **手写签名注入** | 本地用云烟体生成手写签名 → 上传 imgbb → MAIN world hook 拦截后端 signature 接口注入 URL |
| 12 | **AI 地址翻译** | 护照流程下，xlsx 里的英文/拉丁详细地址会自动调 Kimi 翻译为简体中文（`xlsx_translate_to_zh` source） |
| 13 | **全表清空** | 一键清掉当前页所有字段 / 上传 / 复选框，便于重测 |

---

## 🚀 安装与加载（开发者模式）

1. `git clone https://github.com/ethan-010203/BUV-ludan.git`
2. 打开 Chrome → `chrome://extensions`
3. 右上角打开「开发者模式」
4. 点「加载已解压的扩展程序」 → 选择本仓库根目录（即 `manifest.json` 所在目录）
5. 工具栏出现 📄 图标即装好

---

## ⚙️ 首次配置

插件依赖 Moonshot（Kimi）AI 做证件识别，**首次使用前必须配置 API Key**。

1. 点击工具栏 📄 图标打开 popup
2. 首次打开会自动跳到「⚙️ 配置」tab（之后随时可手动切换）
3. 前往 [platform.moonshot.cn/console/api-keys](https://platform.moonshot.cn/console/api-keys) 创建 API Key
4. 粘贴到输入框 → 点 `🧪 测试连通` 验证 → 点 `💾 保存`
5. 切回「📄 主功能」tab 即可开始使用

> 🔒 Key 仅保存在本浏览器的 `chrome.storage.local`，不会上传任何服务器。
> ❌ 未配置时主功能 tab 会显示提示 banner，所有操作按钮被禁用。

---

## 🔄 标准使用流程

```
1. 选国家 + 注册地  →  2. 拖文件夹上传  →  3. 点【🔍 开始检查】
                                            │
                                            ▼
                                    ┌─────────────────┐
                                    │ AI 识别 + 字段   │
                                    │ 提取 + 模块构建  │
                                    └────────┬────────┘
                                             │
                ┌────────────────────────────┼────────────────────────────┐
                ▼                            ▼                            ▼
        ┌──────────────┐           ┌──────────────┐           ┌──────────────┐
        │ 缺失项 + 占位 │           │  ⚡ 一键注入  │           │ ✍️ 注入签名  │
        └──────────────┘           └──────────────┘           └──────────────┘
```

---

## 📂 项目结构

```
PL-tool2/
├── manifest.json            # MV3 清单（permissions: storage / activeTab / scripting / tabs）
├── popup.html               # 主 UI（Tabs：主功能 / 配置）
├── popup.css                # 样式
├── popup.js                 # 主逻辑（~5000 行，UI / AI 调度 / 字段构建 / 签名 / 委托书盖章面板 / 互斥组解析 / 身份流分支）
├── requirements.json        # 国家 × 注册地组合的字段配置（fields / files / alternatives / placeholders / modules）
├── ARCHITECTURE.md          # 架构文档（必读：怎么加新组合 / 积木 / 模块）
├── README.md                # 本文档
├── autofill/                # 自动填充积木（按 autofillModule ID 拆分，dynamic import）
│   ├── poland_seller_center.js   # 波兰卖家中心 buildPlan
│   └── france_seller_center.js   # 法国卖家中心 buildPlan（同时服务 France|China 与 France|HongKong）
├── annex/                   # 附件合成模块（委托书 / 公章）
│   ├── poa_composer.js      # pdf-lib 合成：模板 PDF + 章 PNG → 带章 PDF
│   ├── seal_generator.js    # Canvas 渲染圆章：mainland 红章（弧形中文名+中心五角星）/ hk 深蓝章（弧形英文名+中心多行中文名+底部小星）
│   └── 委托书.pdf            # 委托书 A4 模板（红框盖章位）
├── handwriting/             # 手写签名生成模块
│   ├── fonts/yunyan-data.js # ★云烟体字体（base64 内嵌，~8 MB）
│   ├── renderer.js          # 7-sigma 扰动渲染核心
│   ├── styles.js            # 签名风格预设
│   ├── index.js             # 入口（window.Handwriting）
│   └── test.html            # 独立预览页（不被插件加载）
├── libs/
│   ├── pdf.min.js           # PDF.js（PDF 拆页 → 图）
│   ├── pdf.worker.min.js    # PDF.js worker
│   ├── pdf-lib.min.js       # pdf-lib（委托书合成：加载模板 PDF + 嵌入章 PNG）
│   ├── xlsx.full.min.js     # SheetJS（读 xlsx）
│   └── postal-codes.js      # 中国邮编 / 区划数据
└── icons/                   # 16 / 48 / 128 px 图标
```

详细的"组合配置结构 / 积木 / 加新组合 SOP"见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

---

## 🛠 技术栈

- **运行环境**：Chrome MV3 Extension（无 background / 无 content script，全部在 popup + `chrome.scripting.executeScript`）
- **AI**：Moonshot vision (`kimi-k2.6` / `moonshot-v1-32k-vision-preview`)，另含 Kimi 文本模型用于英文地址→中文翻译
- **PDF 解析**：[PDF.js](https://mozilla.github.io/pdf.js/)
- **PDF 合成**：[pdf-lib](https://pdf-lib.js.org/)（委托书模板 + 公章嵌入）
- **Excel 解析**：[SheetJS](https://sheetjs.com/)
- **图床**：[imgbb](https://imgbb.com/)（仅签名图片用）
- **手写签名**：参考 [Handright](https://github.com/Gsllchb/Handright) 的 7-sigma 扰动算法 + 云烟体内嵌字体
- **公章渲染**：Canvas 2D，双风格——大陆风（红外圈描边 + 弧形公司中文名 + 中心五角星）、香港风（深蓝外圈描边 + 弧形英文名 + 中心多行中文名方块 + 底部小星），离线生成
- **持久化**：`chrome.storage.local`（API Key、上次选择的国家/注册地）

---

## 🔐 安全 & 隐私说明

- **Moonshot API Key**：用户在「⚙️ 配置」tab 自行填入，仅存本机 `chrome.storage.local`，不会上传任何服务器
- **imgbb API Key**：当前仍硬编码在 `popup.js`（开发用），如需公开发布需移到配置面板
- **temp1/ 抓包文件**：含 cookie / session，已 `.gitignore`，永不进库
- **AI 识别图片**：图片以 base64 形式直接 POST 给 Moonshot，不会经过插件作者服务器
- **委托书合成**：模板 PDF + 圆章 PNG 全程在浏览器本地完成（pdf-lib + Canvas），不上传任何服务器

---

## 🐞 已知行为

- **手写签名注入**为「一次性引信」模式：每次插件点【注入签名】只生效一次，被 hook 拦下后立即卸膛；想替换签名 → 回到插件再点【注入签名】重新 arm
- **签名图床 URL 5 分钟有效**（imgbb 免费额度），目标页若延迟较久才发请求会拿到失效图
- **委托书圆章面板**仅在当前组合的 `placeholders.power_of_attorney.kind === "poa_with_seal"` 时显示（目前 `France\|China` / `France\|HongKong` 均启用）；章风格由 `placeholders.power_of_attorney.style`（`"mainland"` / `"hk"`）决定，面板参数（位置、颜色、字号、环宽、文字半径等）可在「高级参数」实时微调
- **`France\|HongKong` 组合的法人证件**是互斥二选一（身份证正反面 **或** 护照），用户只需提供其中一种；进度面板合成单行 `缺少法人证件（任选其一）：身份证（正面+反面） (1/2) 或 护照 (0/1)` 展示，底层由 `alternatives` 配置驱动

---

## 📝 开发提示

- popup.js 是单文件大模块，所有逻辑都在 `DOMContentLoaded` 闭包内；改前先读 `ARCHITECTURE.md` 第 §2 节的"组合配置结构"
- 加新「销售目的地」（卖家中心 DOM 不同）：在 `autofill/<id>.js` 新写一份 `buildPlan`，并在 `popup.js` 顶部 `AUTOFILL_REGISTRY` 加一行 dynamic import 即可，**不需要改 `popup.js` 主逻辑**
- 加新国家 × 注册地组合（注册地相同、卖家中心相同）：只改 `requirements.json` 的 `countries` / `registrations` / `requirements`
- 加新 AI 文档识别器 / 地址体系：见 `ARCHITECTURE.md` 第 §3-§4 节（这两块仍写死在 `popup.js`，Stage 2 待拆）

---

## 📜 License

私有项目，仅供本团队内部使用。
