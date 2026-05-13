# PL-tool2 架构文档

本插件按 **国家（销售目的地）+ 注册地（卖家公司所在地）** 的组合来支持不同业务场景。
本文档定义"组合"的配置结构、可复用积木的接口、以及加新组合时的标准流程。

---

## 1. 核心概念

### 1.1 组合 (Combination)

一个**组合** = `<国家>|<注册地>`，例如 `Poland|China`、`France|China`、`France|HongKong`。

每个组合声明：

- **必填字段**（`fields`）—— 检查清单
- **必备文件**（`files`）—— 文件名匹配规则
- **互斥文件组**（`alternatives`，可选）—— 多个 `fileKeys` 选项里"满足其一即可"的二选一组
- **AI 识别的文档类型**（`aiDocTypes`）—— 引用积木 ID
- **地址解析体系**（`addressLocale`）—— 引用积木 ID
- **自动填充模块**（`autofillModule`）—— 引用积木 ID
- **数据模块定义**（`modules`）—— 自动填充使用的数据来源映射；字段可声明 `showIf` 根据运行时 identityFlow（身份证流程 / 护照流程）过滤显示
- **占位文件配置**（`placeholders`）—— 哪些缺失项可生成临时空白占位；`kind: "poa_with_seal"` 的委托书盖章可带 `style: "mainland" | "hk"` 风格切换

### 1.2 积木 (Brick)

跨组合复用的逻辑单元。当前规划的积木类型：

| 积木类型 | 命名空间 | 当前已实现 | 描述 |
|---|---|---|---|
| AI 文档识别器 | `cn_business_license` / `cn_id_card_front` / `cn_id_card_back` / `cn_tax_cert` / `cn_company_articles` / `hk_business_registration` / `passport` | 是（写死在 `popup.js`，对应 `extractLicenseFields` / `extractIdCardFrontFields` / `extractIdCardBackFields` / `extractHkCrFields` / `extractPassportFields` 等） | 单一文档类型的 AI 分类 + 字段提取 |
| 地址工具 | `zh-CN` | 是（写死在 `popup.js`，内置中国邮编查询 + 香港 18 区 cascader 三级解析 `resolveHkAddress`） | 省市区拆分、邮编查询、地区→省映射、HK 区议会选区识别 |
| 自动填充模块 | `poland_seller_center` / `france_seller_center` | 是（已拆到 `autofill/<id>.js`，与 `popup.js` 顶部的 `AUTOFILL_REGISTRY` 动态 import）；`france_seller_center` 同时服务 `France\|China` 与 `France\|HongKong` | 平台卖家中心 DOM 注入计划（`buildPlan(input)` 返回 plan 数组） |
| 附件合成器 | `poa_with_seal` | 是（`annex/poa_composer.js` + `annex/seal_generator.js`，由 `placeholders.<key>.kind` 调用；支持 `style: "mainland" / "hk"` 双风格） | 委托书 PDF 模板 + Canvas 圆章→ 带章 PDF（pdf-lib） |
| xlsx 模板映射 | `basic_info_v1` | 是（单元格地址写死在 `modules.fields[].cell`，支持 `fallbackCell` 主 cell 空值回退） | 把基础信息表的单元格映射到字段 |

> **当前阶段（Stage 1 → Stage 2 过渡中）**：`autofill` 积木已物理拆出（详见 `autofill/poland_seller_center.js` / `autofill/france_seller_center.js`）；附件合成器也已独立（`annex/`）。**AI 文档识别器**、**地址工具**、**xlsx 模板映射**仍写死在 `popup.js`，计划在 Stage 2 拆到 `ai/`、`address/`、`xlsx/` 子目录。

---

## 2. `requirements.json` 配置结构

```jsonc
{
  // 注：apiKey 已迁移到 chrome.storage.local（用户在「⚙️ 配置」tab 配置），
  //     不再放在 requirements.json 里。
  "countries": {
    "Poland": { "label": "波兰 (Poland)" },
    "France": { "label": "法国 (France)" }
  },
  "registrations": {
    "China": { "label": "中国大陆 (China Mainland)" }
  },
  "requirements": {
    "Poland|China": {
      "label": "波兰 - 中国大陆注册",

      // ===== 元数据：引用积木 ID =====
      "addressLocale": "zh-CN",                    // 用哪套地址解析
      "autofillModule": "poland_seller_center",    // 用哪份卖家中心填充计划（autofill/<id>.js）
      "xlsxTemplate": "basic_info_v1",             // 用哪个 xlsx 模板映射
      "aiDocTypes": [                              // 需要识别的文档类型
        "cn_business_license",
        "cn_id_card_front",
        "cn_id_card_back",
        "cn_tax_cert"
      ],

      // ===== 检查清单 =====
      // fields 与 files 的 key 需一一对应，供modules.file_path source及进度面板互联使用
      "fields": [
        { "key": "business_license", "label": "营业执照", "required": true }
      ],

      // ===== 文件匹配规则 =====
      "files": [
        { "key": "id_card_front", "pattern": "身份证正面", "label": "身份证正面", "matchType": "contains", "required": true },
        { "key": "business_license", "pattern": "营业执照", "label": "营业执照", "matchType": "contains", "required": true,
          "showInAutofill": true, "autofillStatusLabel": "营业执照文件", "convertImageToPdf": true }
      ],

      // ===== 临时占位文件（key 与 files[].key 对应） =====
      "placeholders": {
        "tax_certificate":         { "kind": "pdf", "filename": "完税证明_临时占位.pdf",     "text": "完税证明（临时占位）" },
        "shop_backend_screenshot": { "kind": "png", "filename": "店铺后台截图_临时占位.png", "text": "店铺后台截图（临时占位）" },
        // France|China 组合专有：委托书自动盖章合成
        "power_of_attorney":       { "kind": "poa_with_seal", "filename": "委托书盖章_自动生成.pdf",
                                     "companyNameFrom": { "module": "公司信息", "field": "公司名称" } }
      },

      // ===== 自动填充用的数据模块 =====
      "modules": [
        {
          "title": "公司信息",
          "fields": [
            { "key": "公司名称",           "source": "xlsx",        "cell": "C3" },
            { "key": "营业执照",           "source": "file_path",   "fileKey": "business_license" },
            { "key": "公司类型",           "source": "ai_license",  "aiField": "类型" },
            { "key": "公司成立日期",       "source": "ai_license",  "aiField": "成立日期" },
            { "key": "登记机关所在地税务局名称", "source": "default", "value": "国家税务总局" }
          ]
        }
      ]
    }
  }
}
```

### 2.1 `modules[].fields[].source` 取值

| source | 含义 | 必需的额外字段 |
|---|---|---|
| `xlsx` | 从基础信息表 xlsx 读取单元格 | `cell`（如 `"C3"`）；可选 `fallbackCell`（字符串或数组，主 cell 空值时按序尝试） |
| `xlsx_translate_to_zh` | 读 xlsx 单元格，若不含汉字则调 Kimi 翻译为简体中文（`France\|HongKong` 的护照流程详细地址用） | `cell` |
| `file_path` | 取已识别文件的路径 | `fileKey`（对应 `files[].key`，如 `"business_license"`） |
| `ai_license` | 从 AI 识别的营业执照字段取值 | `aiField` |
| `ai_idcard_front` | 从 AI 识别的身份证正面取值 | `aiField` |
| `ai_idcard_back` | 从 AI 识别的身份证反面取值 | `aiField` |
| `ai_hk_cr` | 从 AI 识别的香港公司注册证书 CR 取值（如 `发出日期` → 公司成立日期） | `aiField` |
| `ai_passport` | 从 AI 识别的护照取值 | `aiField` |
| `identity_field` | 身份证 / 护照通用字段——根据当前 identityFlow 自动从 `aiIdCardFront` 或 `aiPassport` 取值 | `idField`（身份证流取该字段名）+ `passportField`（护照流取该字段名） |
| `passport_validity` | 把 AI 识别的护照"签发日期 - 有效期至"拼成有效期限字符串 | （无） |
| `postal_from_idcard_address` | 从身份证地址查邮编 | （无） |
| `idcard_or_passport` | 根据是否检测到身份证/护照返回 `"法人身份证"` / `"法人护照"` / 空 | （无） |
| `platform_from_url` | 从 xlsx 一个店铺链接单元格推导「主要销售平台」（amazon→亚马逊 / aliexpress→速卖通 / temu→Temu / tiktok→TikTok / 其他→其他） | `urlCell`（如 `"C13"`） |
| `default` | 硬编码默认值 | `value` |

任何 source 都可以加 `defaultValue`，作为取不到值时的兜底。

字段还可声明 `showIf: "idcard"` 或 `showIf: "passport"`，由运行时 `identityFlow`（基于 AI 识别结果推断："idcard" / "passport" / 空）决定该字段是否参与渲染——主要用于 `France|HongKong` 的"身份证流程 vs 护照流程"分支。`showIf` 缺省的字段永远显示。

### 2.2 `placeholders[fileKey]`

> 注：键名 **必须与 `files[].key` 完全对应**（如 `tax_certificate` / `power_of_attorney`），不是中文 label。进度面板从 `files[].key` 反查 placeholder 是否可用。

| 字段 | 取值 | 说明 |
|---|---|---|
| `kind` | `"pdf"` / `"png"` / `"poa_with_seal"` | 占位 / 生成文件的类型 |
| `filename` | 字符串 | 生成的文件名 |
| `text` | 字符串 | （`pdf` / `png`）占位图上显示的文字 |
| `style` | `"mainland"` / `"hk"`（仅 `poa_with_seal`，默认 `"mainland"`） | 圆章风格。`mainland`：红色外圈 + 弧形中文名 + 中心五角星；`hk`：深蓝外圈 + 弧形英文名 + 中心多行中文名方块 + 底部小星 |
| `companyNameFrom` | `{ module, field }` | （`poa_with_seal`）从 `lastModulesData` 取公司中文名作为圆章文字；可被面板内手动输入覆盖 |
| `englishNameFrom` | `{ module, field }` | （`poa_with_seal` + `style: "hk"`）从 `lastModulesData` 取公司英文名作为外圈弧形文字，默认指向 `店铺信息 → 公司英文名称` |
| `sealOpts` | 对象 | （`poa_with_seal`）圆章渲染参数初值——`color` / `ringWidth` / `secondaryRingWidth` / `textRadiusRatio` / `fontSize` / `bottomFontSize` 等；可在「委托书圆章」面板的高级参数实时调节 |

**`kind: "poa_with_seal"`** 是一个与 `kind: "pdf"` / `"png"` 同级的附件合成器，调用 `annex/poa_composer.js`：
- 加载 `annex/委托书.pdf` 作为模板
- `annex/seal_generator.js` 用 Canvas 生成公司圆章 PNG：
  - `mainland` 风格：红色外圈描边 + 弧形中文名 + 中心五角星（`Poland|China` / `France|China` 默认）
  - `hk` 风格：深蓝色外圈描边 + 弧形英文名 + 中心多行中文名方块 + 底部小星（`France|HongKong` 专用）
- pdf-lib `embedPng` 后在红框中心叠加章→ 输出带章 PDF
- popup 会额外显示「委托书圆章」面板（`showPoaSealPanel()`），支持预览与高级参数微调（`sealBox.centerX/Y/diameter/rotateRad`、`sealOpts.color/font/ringWidth/secondaryRingWidth/textRadiusRatio/fontSize/bottomFontSize/starRatio`）。

### 2.3 `aiDocTypes` 当前可用 ID

> 注：Stage 1 阶段，`detectWithAI` 的 prompt 仍枚举所有这些类型；该字段当前**仅作元数据**记录组合使用了哪些类型。Stage 2 会把它变成动态 prompt 拼接。

- `cn_business_license` —— 中国营业执照
- `cn_id_card_front` —— 中国居民身份证人像面
- `cn_id_card_back` —— 中国居民身份证国徽面
- `cn_tax_cert` —— 中国完税证明（中国税收居民身份证明）
- `cn_company_articles` —— 中国公司章程（`France|China` 组合使用）
- `hk_business_registration` —— 香港公司注册证书 CR / 商業登記證（`France|HongKong` 组合使用；AI 返回标签 `香港公司注册证书` → 映射到 label `香港公司注册证书CR`）
- `passport` —— 护照（**地区无关**：识别 PASSPORT/护照 标题 + 国籍 / Nationality / 护照号 / MRZ 等护照专属字段；与 `cn_id_card_*` 在 `France|HongKong` 的 `legal_person_identity` 互斥组里"二选一"）

### 2.4 `alternatives` 配置（互斥文件组，二选一）

某些组合的文件清单是动态的——例如 `France|HongKong` 的法人证件可以是「身份证正反面」**或**「护照」，根据用户提供哪种来定。这种语义用 `alternatives` 数组表达：

```jsonc
"alternatives": [
  {
    "key": "legal_person_identity",          // 互斥组的稳定 ID（合成 missing 项的 key）
    "label": "法人证件",                       // UI 渲染的中文名
    "options": [                              // 各互斥 option，**全部 fileKeys 都识别到**才算该 option 满足
      { "label": "身份证（正面+反面）", "fileKeys": ["id_card_front", "id_card_back"] },
      { "label": "护照",                "fileKeys": ["passport"] }
    ]
  }
]
```

**前置条件**：参与 alt 的 `files[].required` 应设为 `false`（它们是条件必填，由 `resolveAlternatives` 在运行时根据已识别的文件决定是否真的缺）。

**运行时行为（`popup.js:resolveAlternatives`）**：

1. 任一 option 的 `fileKeys` 全部命中 → 该 alt 视为满足，alt 涉及的所有 `fileKey` 从 `missing` 中剥离（多余 option 的文件不再算"必填"）；
2. 没有任何 option 完整满足 → 同样剥离 alt 涉及的所有 `fileKey`，改为追加一条合成项 `{ key: alt.key, label: alt.label, required: true, _alternative: true, _progress: [...] }`，由 `renderMissingItems` 单独渲染成"缺少法人证件（任选其一）：身份证（正面+反面） (1/2) 或 护照 (0/1)"。

**幂等性**：函数会先剥离上一轮 `_alternative` 合成项再重算，所以 `applyPlaceholder` 等多次调用不会堆积重复条目。

---

## 3. 加新组合的标准流程

### 场景 A：新组合的注册地与现有组合相同、且卖家中心 DOM 也相同（最轻量）

例如已有 `Poland|China`，要加另一个同样调用 `poland_seller_center` 的组合。

**步骤**：仅改 `requirements.json`：加 country / 复制一份组合改 `label` + `fields` + `files` + `modules` 即可。

**预计工作量**：几小时。

### 场景 B：新组合的卖家中心 DOM 不同（最常见，`Poland|China` → `France|China` 是该场景）

例如已有 `Poland|China`，要加 `France|China`；两组证件 / 地址 都是中国体系，但注入的是不同的卖家中心页面。

**步骤**：

1. 在 `requirements.json` 的 `countries` 加入 `"France": { "label": "法国 (France)" }`
2. 在 `requirements.json` 的 `requirements` 加入新条目 `"France|China"`，**复制 `Poland|China` 整个对象**
3. 修改新条目的 `label`、`fields`、`files`（按法国合规要求调整）
4. 修改新条目的 `modules` 中**法国卖家中心需要的字段**（不一样的字段加进去、不需要的删掉）
5. 修改新条目的 `autofillModule`，填一个新 ID 如 `france_seller_center`
6. **新写一份 `autofill/france_seller_center.js`**，参考 `autofill/poland_seller_center.js` 的结构实现 `default.buildPlan({ modulesData, foundFiles, aiData, utils })` 返回 plan 数组。重点在按页面 DOM 准确的 type / selector / labelFallback。
7. **在 `popup.js` 顶部 `AUTOFILL_REGISTRY` 里加一行**：
   ```js
   const AUTOFILL_REGISTRY = {
     poland_seller_center: () => import("./autofill/poland_seller_center.js"),
     france_seller_center: () => import("./autofill/france_seller_center.js"), // ← 新增
   };
   ```
   启动时 `validateConfigBricks` 会检查所有组合声明的 `autofillModule` 都在注册表里，漏登记会在控制台报错。
8. （可选）若需要委托书自动盖章之类的附件，在 `placeholders` 加 `{ "kind": "poa_with_seal", … }`；popup 会自动显示面板。
9. 联调：测识别、xlsx 读取、AI 提取、填表、（委托书）合成。

**预计工作量**：1-3 天（主要在新写 `autofill/france_seller_center.js` 并对页面 DOM 调试）。**不需要改 `popup.js` 主逻辑**，只加一行 dynamic import。

### 场景 C：新组合的注册地是全新的（需新证件 + 新地址体系）

例如已有 `Poland|China`，要加 `Poland|HongKong`（HK 卖家）。

**额外要做的事**（在场景 B 步骤之上）：

- 新增 `aiDocTypes` ID（如 `hk_id_card`、`hk_business_registration`）
- 在 `popup.js` 的 `detectWithAI` 函数里给 prompt 增加新文档类型的判断分支
- 新写 `extractHkIdCardFields` / `extractHkBrFields` 等 AI 字段提取函数，并在 `buildModuleData` 加对应 source（如 `ai_hk_id_card`）
- 新增 `addressLocale: "zh-HK"` ——
  - 写一个 HK 地区的地址解析函数（区议会选区 / 邮政编码体系）
  - 在 `buildModuleData` 的 `postal_from_idcard_address` 分支按 `currentReqConfig.addressLocale` 分派

**预计工作量**：3-5 天。该场景是 Stage 2 "AI 识别器 / 地址工具 拆到独立目录"的触发点。

### 场景 D：新组合是"销售目的地 = 注册地"（境外本地卖家）

例如 `France|France`（法国本地卖家在法国销售）。

= 场景 C + 完全不一样的证件（KBIS、法国身份证、护照）+ `fr-FR` 地址体系。需在 `ai/` / `address/` 拆出后才够优雅。

**预计工作量**：1 周以上。建议这种场景出现时再推动 Stage 2 重构。

---

## 4. 已知问题与未来改进

### 4.1 国家/注册地下拉框未联动（✅ 已修复）

原问题：`popup.js` 在 `countrySelect` change 事件里把**所有 `registrations`** 都列出来，让用户能选到不存在的组合。

**修复**：现在通过 `getRegistrationsForCountry(countryKey)` 只列出该国家有配置的注册地；若只剩一个会自动选中。仅「恢复上次会话」分支仍会填全部 `registrations`（但会被 `currentReqConfig === null` 的红色 warning 兜底，影响低）。

### 4.2 API Key 硬编码（✅ 已修复）

Moonshot API Key 已迁出代码，用户在「⚙️ 配置」 tab 输入，存 `chrome.storage.local`。

> imgbb API Key（手写签名图床）仍硬编码在 `popup.js`，公开发布前需要一起迁到配置面板。

### 4.3 Stage 2 重构清单

按优先级（勾选表示已完成）：

- [x] **把 `buildAutofillPlan` 拆到 `autofill/<id>.js`**，导出 `default.buildPlan(input) => plan[]`，并在 `popup.js` 顶部用 `AUTOFILL_REGISTRY` 动态 import（启动时有 `validateConfigBricks` 校验）
- [x] **修复 4.1 的下拉联动 bug**（`getRegistrationsForCountry`）
- [x] **API Key 迁 `chrome.storage.local`**，配合「⚙️ 配置」 tab + 连通性测试
- [x] **附件合成器（`annex/`）**：`poa_composer.js` + `seal_generator.js` + `placeholders.<key>.kind = "poa_with_seal"`，支持 `mainland` / `hk` 双风格
- [x] **互斥文件组 `alternatives`**：支持"身份证 或 护照"这类二选一必填，进度面板 `renderMissingItems` 统一渲染（`France|HongKong` 已启用）
- [x] **身份流分支 `identityFlow` + `showIf` 字段过滤 + `identity_field` 通用 source**：让 `requirements.json` 能声明同一组合内两套证件流程共存
- [ ] **把 `MODULES` 引用的"AI 字段提取函数"拆到 `ai/docTypes/*.js`**，每份导出统一接口：
   ```js
   export default {
     id: "cn_business_license",
     classifyPromptFragment: "...",
     extract: async (base64, mimeType) => ({...})
   };
   ```
- [ ] **让 `detectWithAI` 的 prompt 由 `currentReqConfig.aiDocTypes` 动态拼接**（依赖上一项）
- [ ] **把地址逻辑拆到 `address/zh_CN.js` / `address/zh_HK.js`**（`splitAddressPrefix` / `splitAddressIntoRegionAndDetail` / `getPostalCodeForAddress` / `resolveHkAddress` / `normalizeRegistrationAuthority`），按 `addressLocale` 动态加载
- [ ] **把 `requirements.json` 拆成 `config/combinations/*.json`** 多文件，便于 git diff 与多人并行加组合
- [ ] **imgbb API Key 迁出代码**（代码里现以明文存放）

---

## 5. 文件结构

### 当前

```
PL-tool2/
  manifest.json                      # MV3 清单
  popup.html
  popup.css
  popup.js                           # 主逻辑（~5000 行，~235 KB；UI / AI 调度 / 字段构建 / 委托书面板 / 手写签名 / 互斥组解析 / 身份流分支）
  requirements.json                  # 全部组合配置（apiKey 已移至 chrome.storage.local；当前含 Poland|China / France|China / France|HongKong）
  autofill/                          # ✅ 自动填充积木（已拆出）
    poland_seller_center.js
    france_seller_center.js          # 同时服务 France|China 与 France|HongKong
  annex/                             # ✅ 附件合成器（已拆出）
    poa_composer.js                  # pdf-lib 委托书合成
    seal_generator.js                # Canvas 公司圆章（mainland 红章 / hk 深蓝章双风格）
    委托书.pdf                       # 委托书 A4 模板（含红框盖章位）
  handwriting/                       # 手写签名（云烟体 + 7-sigma 扰动）
    fonts/yunyan-data.js
    renderer.js
    styles.js
    index.js
    test.html
  libs/
    pdf.min.js                       # PDF.js（拆页 → 图）
    pdf.worker.min.js
    pdf-lib.min.js                   # ★ pdf-lib（委托书合成：加载模板 PDF + 嵌入圆章 PNG）
    postal-codes.js                  # zh-CN 邮编 + 省市区数据
    xlsx.full.min.js                 # SheetJS
  icons/                             # 16 / 48 / 128 px
  ARCHITECTURE.md                    # 本文档
  README.md
  .gitignore                         # 屏蔽 temp1/ / *.har / .venv / 打包产物等
```

### Stage 2 目标

```
PL-tool2/
  manifest.json
  popup.html
  popup.css
  popup.js              # 仅 UI + 状态管理
  config/
    countries.json
    registrations.json
    combinations/
      Poland_China.json
      France_China.json
      ...
  ai/
    docClassifier.js
    docTypes/
      cn_business_license.js
      cn_id_card_front.js
      cn_id_card_back.js
      cn_tax_cert.js
      cn_company_articles.js
      hk_id_card.js
      ...
  address/
    zh_CN.js
    zh_HK.js
    fr_FR.js
  autofill/             # ✅ 已达成
    poland_seller_center.js
    france_seller_center.js
    ...
  annex/                # ✅ 已达成
    poa_composer.js
    seal_generator.js
  xlsx/
    templates.js
  utils/
    placeholders.js
    pdf.js
  libs/                 # 第三方库（pdf.js / pdf-lib / xlsx / postal-codes）
  icons/
```

---

## 6. 命名规范

| 类型 | 规范 | 示例 |
|---|---|---|
| 组合 key | `<国家>|<注册地>`，国家名首字母大写英文 | `Poland|China`、`France|HongKong` |
| AI doc type id | `<地区前缀>_<文档简称>`，全小写下划线 | `cn_business_license`、`hk_id_card` |
| Address locale | BCP 47 风格，连字符 | `zh-CN`、`zh-HK`、`fr-FR` |
| Autofill module id | `<国家小写>_<场景>`，下划线 | `poland_seller_center`、`france_seller_center` |
| xlsx 模板 id | `<用途>_v<版本>` | `basic_info_v1` |

---

## 7. Checklist：加新组合前自查

- [ ] 该组合的"注册地"对应的 `aiDocTypes` 是否已有现成积木？
  - 是 → 复用，只改 `requirements.json`
  - 否 → 在 `popup.js` 新写 AI prompt + 提取函数，新加 docType ID
- [ ] 该组合的 `addressLocale` 是否已有现成积木？
  - 是 → 复用
  - 否 → 在 `popup.js` 新写地址工具，新加 locale ID
- [ ] 该组合的卖家中心 DOM 是否与已有 `autofillModule` 相同？
  - 是 → 复用同一个 module ID
  - 否 → 新建 `autofill/<id>.js` 实现 `default.buildPlan(input)`，并在 `popup.js` 顶部 `AUTOFILL_REGISTRY` 加一行 dynamic import（启动时 `validateConfigBricks` 会检查是否漏登记）
- [ ] `modules` 里所有字段的 source 是否都有对应实现？（参见 2.1）
- [ ] `placeholders` 键名是否与 `files[].key` 一一对应？是否覆盖了所有需要生成的占位项（PDF / PNG / poa_with_seal）？
- [ ] 若需委托书自动盖章：`placeholders.<key>.kind` 是否设为 `"poa_with_seal"`？`companyNameFrom.{module,field}` 是否能在该组合的 `modules` 里取到公司中文名？
- [ ] `modules.fields[].source = "file_path"` 是否使用 `fileKey`（而不是旧的 `label`），且 `fileKey` 能在 `files[].key` 找到？
