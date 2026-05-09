# PL-tool2 架构文档

本插件按 **国家（销售目的地）+ 注册地（卖家公司所在地）** 的组合来支持不同业务场景。
本文档定义"组合"的配置结构、可复用积木的接口、以及加新组合时的标准流程。

---

## 1. 核心概念

### 1.1 组合 (Combination)

一个**组合** = `<国家>|<注册地>`，例如 `Poland|China`、`France|HongKong`。

每个组合声明：

- **必填字段**（`fields`）—— 检查清单
- **必备文件**（`files`）—— 文件名匹配规则
- **AI 识别的文档类型**（`aiDocTypes`）—— 引用积木 ID
- **地址解析体系**（`addressLocale`）—— 引用积木 ID
- **自动填充模块**（`autofillModule`）—— 引用积木 ID
- **数据模块定义**（`modules`）—— 自动填充使用的数据来源映射
- **占位文件配置**（`placeholders`）—— 哪些缺失项可生成临时空白占位

### 1.2 积木 (Brick)

跨组合复用的逻辑单元。当前规划的积木类型：

| 积木类型 | 命名空间 | 当前已实现 | 描述 |
|---|---|---|---|
| AI 文档识别器 | `cn_business_license` / `cn_id_card_front` / `cn_id_card_back` / `cn_tax_cert` | 是（写死在 `popup.js`） | 单一文档类型的 AI 分类 + 字段提取 |
| 地址工具 | `zh-CN` | 是（写死在 `popup.js`） | 省市区拆分、邮编查询、地区→省映射等 |
| 自动填充模块 | `poland_seller_center` | 是（`buildAutofillPlan` 写死在 `popup.js`） | 平台卖家中心 DOM 注入计划 |
| xlsx 模板映射 | `basic_info_v1` | 是（单元格地址写死在 `modules.fields[].cell`） | 把基础信息表的单元格映射到字段 |

> **当前阶段（Stage 1）**：积木仍写死在 `popup.js` 里，但每个组合 JSON 已经声明了"我使用哪些积木"。
> **下一阶段（Stage 2）**：把这些积木物理拆分到 `ai/`、`address/`、`autofill/` 等子目录，按 ID 动态加载。

---

## 2. `requirements.json` 配置结构

```jsonc
{
  // 注：apiKey 已迁移到 chrome.storage.local（用户在「⚙️ 配置」tab 配置），
  //     不再放在 requirements.json 里。
  "countries": {
    "Poland": { "label": "波兰 (Poland)" }
  },
  "registrations": {
    "China": { "label": "中国大陆 (China Mainland)" }
  },
  "requirements": {
    "Poland|China": {
      "label": "波兰 - 中国大陆注册",

      // ===== 元数据：引用积木 ID =====
      "addressLocale": "zh-CN",                    // 用哪套地址解析
      "autofillModule": "poland_seller_center",    // 用哪份卖家中心填充计划
      "xlsxTemplate": "basic_info_v1",             // 用哪个 xlsx 模板映射
      "aiDocTypes": [                              // 需要识别的文档类型
        "cn_business_license",
        "cn_id_card_front",
        "cn_id_card_back",
        "cn_tax_cert"
      ],

      // ===== 检查清单 =====
      "fields": [ ... ],

      // ===== 文件匹配规则 =====
      "files": [
        { "pattern": "身份证正面", "label": "身份证正面", "matchType": "contains", "required": true }
      ],

      // ===== 临时占位文件 =====
      "placeholders": {
        "完税证明":     { "kind": "pdf", "filename": "完税证明_临时占位.pdf",     "text": "完税证明（临时占位）" },
        "店铺后台截图": { "kind": "png", "filename": "店铺后台截图_临时占位.png", "text": "店铺后台截图（临时占位）" }
      },

      // ===== 自动填充用的数据模块 =====
      "modules": [
        {
          "title": "公司信息",
          "fields": [
            { "key": "公司名称",           "source": "xlsx",        "cell": "C3" },
            { "key": "营业执照",           "source": "file_path",   "label": "营业执照" },
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
| `xlsx` | 从基础信息表 xlsx 读取单元格 | `cell`（如 `"C3"`） |
| `file_path` | 取已识别文件的路径 | `label`（如 `"营业执照"`） |
| `ai_license` | 从 AI 识别的营业执照字段取值 | `aiField` |
| `ai_idcard_front` | 从 AI 识别的身份证正面取值 | `aiField` |
| `ai_idcard_back` | 从 AI 识别的身份证反面取值 | `aiField` |
| `postal_from_idcard_address` | 从身份证地址查邮编 | （无） |
| `idcard_or_passport` | 根据是否检测到身份证返回 `"法人身份证"` 或空 | （无） |
| `default` | 硬编码默认值 | `value` |

任何 source 都可以加 `defaultValue`，作为取不到值时的兜底。

### 2.2 `placeholders[label]`

| 字段 | 取值 | 说明 |
|---|---|---|
| `kind` | `"pdf"` 或 `"png"` | 占位文件格式 |
| `filename` | 字符串 | 生成的文件名 |
| `text` | 字符串 | 占位图上显示的文字 |

### 2.3 `aiDocTypes` 当前可用 ID

> 注：Stage 1 阶段，`detectWithAI` 的 prompt 仍枚举所有这 4 种类型；该字段当前**仅作元数据**记录组合使用了哪些类型。Stage 2 会把它变成动态 prompt 拼接。

- `cn_business_license` —— 中国营业执照
- `cn_id_card_front` —— 中国居民身份证人像面
- `cn_id_card_back` —— 中国居民身份证国徽面
- `cn_tax_cert` —— 中国完税证明

---

## 3. 加新组合的标准流程

### 场景 A：新组合的注册地与现有组合相同（最常见）

例如已有 `Poland|China`，要加 `France|China`。

**步骤**：

1. 在 `requirements.json` 的 `countries` 加入 `"France": { "label": "法国 (France)" }`
2. 在 `requirements.json` 的 `requirements` 加入新条目 `"France|China"`，**复制 `Poland|China` 整个对象**
3. 修改新条目的 `label`、`fields`、`files`（按法国合规要求调整）
4. 修改新条目的 `modules` 中**法国卖家中心需要的字段**（不一样的字段加进去、不需要的删掉）
5. 修改新条目的 `autofillModule`（先填一个新 ID 如 `france_seller_center`，标记需要新写）
6. **新写一份填表函数**——目前 `popup.js` 里 `buildAutofillPlan` 只支持 `poland_seller_center`，需要：
   - 把 `buildAutofillPlan` 重命名为 `buildAutofillPlan_poland`
   - 写一个 `buildAutofillPlan_france`
   - 在 `runAutofill` 里按 `currentReqConfig.autofillModule` dispatch
7. 联调：测识别、xlsx 读取、AI 提取、填表

**预计工作量**：1-2 天（主要在新写 `buildAutofillPlan_france`）

### 场景 B：新组合的注册地是全新的（需要新证件 + 新地址）

例如已有 `Poland|China`，要加 `Poland|HongKong`（HK 卖家）。

**额外要做的事**（在场景 A 步骤之上）：

- 新增 `aiDocTypes` ID（如 `hk_id_card`、`hk_business_registration`）
- 在 `popup.js` 的 `detectWithAI` 函数里给 prompt 增加新文档类型的判断分支
- 新写 `extractHkIdCardFields` / `extractHkBrFields` 等 AI 字段提取函数
- 新增 `addressLocale: "zh-HK"` ——
  - 写一个 HK 地区的地址解析函数（区议会选区/邮政编码体系）
  - 在 `buildModuleData` 的 `postal_from_idcard_address` 分支按 `currentReqConfig.addressLocale` 分派
- `modules` 里的 source 配置可能需要扩展（如 `ai_hk_id_card`）

**预计工作量**：3-5 天

### 场景 C：新组合是"销售目的地 = 注册地"（境外本地卖家）

例如 `France|France`（法国本地卖家在法国销售）。

= 场景 B + 完全不一样的填表模块（法国卖家中心 DOM）+ 完全不一样的证件（KBIS、法国身份证、护照）+ `fr-FR` 地址体系。

**预计工作量**：1 周以上。建议这种场景出现时再做 Stage 2 整体重构。

---

## 4. 已知问题与未来改进

### 4.1 国家/注册地下拉框未联动（已知 bug）

`popup.js` 在 `countrySelect` change 事件里把**所有 `registrations`** 都列出来，而不是只列出"该国家有配置的注册地"。

**当前影响**：只有一个组合时无感。当组合 ≥ 2 时会让用户能选到不存在的组合（比如 France|HongKong），靠 `currentReqConfig === null` 的红色 warning 兜底。

**修复**：在 `registrationSelect` 填充时遍历 `config.requirements`，只列出该国家有配置的注册地。**加第二个组合时一并修复**。

### 4.2 API Key 硬编码

详见 README / 之前的讨论。发布前必须改为用户输入存 `chrome.storage.local`。

### 4.3 Stage 2 重构清单

按优先级：

1. 把 `MODULES` 引用的"AI 字段提取函数"拆分到 `ai/docTypes/*.js`，每份导出统一接口：
   ```js
   export default {
     id: "cn_business_license",
     classifyPromptFragment: "...",
     extract: async (base64, mimeType) => ({...})
   };
   ```
2. 把 `buildAutofillPlan` 拆到 `autofill/poland_seller_center.js`，导出 `buildPlan(moduleData) => plan[]`
3. 把地址逻辑（`splitAddressPrefix` / `splitAddressIntoRegionAndDetail` / `getPostalCodeForAddress` / `normalizeRegistrationAuthority`）拆到 `address/zh_CN.js`，按 `addressLocale` 动态加载
4. 让 `detectWithAI` 的 prompt 由 `currentReqConfig.aiDocTypes` 动态拼接
5. 修复 4.1 的下拉联动 bug
6. 把 `requirements.json` 拆成 `config/combinations/*.json` 多文件，便于 git diff

---

## 5. 文件结构

### 当前

```
PL-tool2/
  manifest.json
  popup.html
  popup.css
  popup.js              # 主逻辑（135KB）
  requirements.json     # 全部组合配置（apiKey 已移至 chrome.storage.local）
  libs/
    pdf.min.js
    pdf.worker.min.js
    postal-codes.js     # zh-CN 邮编+省市区数据
    xlsx.full.min.js
  icons/
  ARCHITECTURE.md       # 本文档
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
      hk_id_card.js
      ...
  address/
    zh_CN.js
    zh_HK.js
    fr_FR.js
  autofill/
    poland_seller_center.js
    france_seller_center.js
    ...
  xlsx/
    templates.js
  utils/
    placeholders.js
    pdf.js
  libs/                 # 第三方库
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
  - 否 → 在 `popup.js` 新写 `buildAutofillPlan_<id>`，并在 `runAutofill` 里 dispatch
- [ ] `modules` 里所有字段的 source 是否都有对应实现？（参见 2.1）
- [ ] 占位文件 `placeholders` 是否覆盖了所有 PDF/PNG 必填项？
- [ ] 国家/注册地下拉联动 bug（4.1）是否需要顺手修？
