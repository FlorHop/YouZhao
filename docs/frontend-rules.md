# 前端统一规则约束

本文档用于约束原型 DSL 与自动部署系统 MVP 的前端实现。目标是让平台页面、DSL 渲染页面、原型预览页面在技术栈、视觉语言、组件行为和交付质量上保持一致。

## 1. 技术基线

- 前端框架：Vue 3。
- 构建工具：Vite。
- UI 组件库：PrimeVue v4。
- 图标库：PrimeIcons。
- 主题模式：PrimeVue Styled Mode。
- 图表库：ECharts，封装为平台内部图表组件。
- 状态管理：Pinia。
- 路由：Vue Router。
- 代码语言：TypeScript。
- 样式策略：PrimeVue design token 优先，业务 CSS 次之，禁止大面积覆盖 PrimeVue 内部类名。

## 2. 产品形态约束

平台分为两个前端域：

- 交付平台工作台：用于项目、DSL、版本、部署、预览管理。
- 原型运行时：用于渲染 DSL 生成的可视化原型。

两者可以共享基础组件、主题 token、图标规范和数据格式，但必须保持运行边界清晰：

- 工作台负责编辑、管理、发布。
- 原型运行时负责消费 DSL、渲染页面、承载交互。
- 原型运行时不直接依赖工作台业务状态。
- 原型运行时必须可独立构建和部署。

## 3. 页面结构

工作台采用操作型后台结构：

```text
AppShell
├─ TopBar
├─ SideNav
├─ MainContent
│  ├─ PageHeader
│  ├─ Toolbar
│  └─ ContentRegion
└─ Toast / ConfirmDialog / Dialog
```

页面必须优先服务高频操作，不做营销式落地页。

页面类型约束：

- 列表页：`DataTable` + 筛选区 + 行操作 + 批量操作。
- 详情页：基础信息 + 关联资产 + 版本记录 + 操作历史。
- 编辑页：表单区 + 结构化配置区 + 实时预览区。
- 预览页：左侧 DSL/页面树，右侧原型 iframe 或运行时画布。
- 发布页：版本选择、构建状态、部署地址、回滚入口。

## 4. PrimeVue 使用规则

### 4.0 PrimeVue 生态参考规则

实现页面前必须优先参考 PrimeVue 官方生态，而不是只使用零散组件：

- 基础组件用法参考 PrimeVue Components 文档。
- 页面区块组合优先参考 PrimeBlocks 的后台、列表、卡片、表单、设置页模式。
- 完整后台布局可参考 PrimeVue Templates 的导航、工具栏、内容区密度和状态处理。
- 视觉稿和 token 命名优先参考 PrimeVue Figma UI Kit 与 Styled Mode token。
- 自研页面不得脱离 PrimeVue 的交互习惯另起一套控件语言。

约束：

- 业务页面不得直接堆叠大量 PrimeVue 原子组件，必须经过平台基础组件或页面母版组织。
- 如 PrimeVue 官方示例已有成熟模式，应优先复用其布局思想，再做业务适配。
- 不允许用 PrimeVue 默认 `Card` 样式直接大量铺页面；资源卡、设置面板、列表容器应封装为平台自己的视觉组件。

### 4.1 组件优先级

常规 UI 必须优先使用 PrimeVue 组件：

- 按钮：`Button`、`SplitButton`、`SpeedDial`。
- 表格：`DataTable`、`Column`、`Paginator`。
- 表单：`InputText`、`Textarea`、`InputNumber`、`Select`、`MultiSelect`、`DatePicker`、`Checkbox`、`RadioButton`、`ToggleSwitch`。
- 反馈：`Toast`、`Message`、`ProgressBar`、`ProgressSpinner`、`Skeleton`。
- 弹层：`Dialog`、`Drawer`、`Popover`、`ConfirmDialog`、`Tooltip`。
- 导航：`Menu`、`Menubar`、`PanelMenu`、`Breadcrumb`、`Tabs`。
- 容器：`Panel`、`Accordion`、`Splitter`、`Toolbar`、`Card`。

自定义组件必须封装 PrimeVue 组件，而不是绕开组件库重新实现基础控件。

### 4.2 DataTable 约束

所有结构化列表默认使用 `DataTable`。

必选规则：

- 必须显式定义 `dataKey`。
- 数据超过 20 行必须启用分页。
- 远程数据必须使用 lazy 模式。
- 加载状态必须使用 `loading` 或 `Skeleton`。
- 空数据必须展示明确的空状态。
- 行操作必须放在最后一列。
- 多字段排序只用于确有需要的分析型列表。
- 表格列必须来自配置或常量，避免散落在模板中。

建议默认配置：

```vue
<DataTable
  :value="rows"
  dataKey="id"
  paginator
  :rows="20"
  :rowsPerPageOptions="[10, 20, 50, 100]"
  :loading="loading"
  removableSort
  tableStyle="min-width: 64rem"
>
  <Column field="name" header="名称" sortable />
  <Column field="status" header="状态" />
  <Column header="操作" />
</DataTable>
```

### 4.3 图标约束

- 所有 PrimeVue 控件图标使用 PrimeIcons。
- 图标类名统一使用 `pi pi-{name}`。
- 工具按钮优先使用图标，不用文字模拟图形动作。
- 图标按钮必须提供 `aria-label` 或 `Tooltip`。
- 常用图标命名必须稳定，不在不同页面混用含义。

常用映射：

| 动作 | 图标 |
| --- | --- |
| 新建 | `pi pi-plus` |
| 编辑 | `pi pi-pencil` |
| 删除 | `pi pi-trash` |
| 保存 | `pi pi-save` |
| 刷新 | `pi pi-refresh` |
| 搜索 | `pi pi-search` |
| 筛选 | `pi pi-filter` |
| 上传 | `pi pi-upload` |
| 下载 | `pi pi-download` |
| 预览 | `pi pi-eye` |
| 发布 | `pi pi-cloud-upload` |
| 回滚 | `pi pi-history` |
| 设置 | `pi pi-cog` |
| 更多 | `pi pi-ellipsis-v` |

## 5. 主题与视觉规则

PrimeVue Styled Mode 采用 base + preset 架构。MVP 默认使用内置 preset，后续通过自定义 preset 扩展品牌风格。

默认策略：

- 默认 preset：Aura。
- CSS 变量前缀：`p`。
- 深色模式：使用类选择器 `.app-dark`，由平台显式切换。
- 主题扩展：优先修改 primitive token 和 semantic token。
- 单组件特殊样式：只在必要时修改 component token。
- 禁止通过深层 CSS 选择器批量覆盖 PrimeVue 内部结构。

主题初始化建议：

```ts
import PrimeVue from 'primevue/config';
import Aura from '@primeuix/themes/aura';

app.use(PrimeVue, {
  theme: {
    preset: Aura,
    options: {
      prefix: 'p',
      darkModeSelector: '.app-dark',
      cssLayer: false
    }
  }
});
```

视觉约束：

- 平台主界面以浅色为默认，保留深色模式。
- 不使用大面积渐变背景。
- 不使用装饰性光斑、漂浮球、复杂插画背景。
- 卡片圆角不超过 8px，除非 PrimeVue preset 默认值更小。
- 页面区块不嵌套卡片，卡片只用于独立资产、列表项、弹窗内容。
- 字体大小不随视口宽度缩放。
- 字间距保持 `0`。
- 所有固定格式区域必须有稳定尺寸或响应式约束。

### 5.1 设计风格基线

有招工作台的默认风格是企业级 SaaS 交付平台：

- 克制、清晰、可扫描。
- 信息密度中高，首屏优先展示可操作内容。
- 页面气质接近成熟后台产品，不做营销页、官网页、炫酷大屏页。
- 强调资产管理、版本管理、授权管理的秩序感。
- 主色只用于当前选中态和主要动作，危险色只用于删除、撤销等高风险动作。

### 5.2 Design Tokens

业务 CSS 必须优先使用平台 token，禁止在页面内随意新增颜色、阴影、圆角和间距。

基础 token 建议：

```css
:root {
  --app-bg: #f6f8fb;
  --app-panel: #ffffff;
  --app-panel-muted: #f8fafc;
  --app-border: #e2e8f0;
  --app-border-soft: #edf2f7;
  --app-text: #111827;
  --app-muted: #64748b;
  --app-subtle: #94a3b8;
  --app-primary: #2563eb;
  --app-primary-weak: #eff6ff;
  --app-success: #16a34a;
  --app-warning: #d97706;
  --app-danger: #dc2626;
  --app-radius: 8px;
  --app-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
}
```

字号约束：

| 层级 | 用途 | 字号 |
| --- | --- | --- |
| Page title | 页面标题 | 22px |
| Section title | 区块标题 | 16px |
| Body | 正文、表格 | 14px |
| Meta | 辅助信息 | 12px / 13px |

间距约束：

- 页面外边距：24px。
- 区块间距：16px / 20px。
- 卡片内边距：16px。
- 表单字段间距：14px。
- 按钮组间距：8px。

### 5.3 页面母版

后续页面必须优先套用母版：

- 工作台母版：`AppShell + TopBar + SideNav + ContentRegion`。
- 卡片分组页母版：`PageHeader + Toolbar + GroupSection + ResourceCardGrid`。
- 表格列表页母版：`PageHeader + Toolbar + DataTable`。
- 权限配置页母版：`UserPicker + PermissionPanel + StickyActions`。
- 弹窗表单母版：`Dialog + FormField + FooterActions`。

页面母版要求：

- 页面头部不超过 72px。
- 一个页面最多一个主按钮。
- 管理类次要动作使用 `outlined` 或 `text`。
- 高风险动作使用 `severity="danger"`，并必须二次确认。
- 空状态、无权限状态必须使用统一视觉。

### 5.4 负面清单

禁止出现以下模式：

- 页面像 PrimeVue 默认组件示例的简单拼接。
- 大量默认 `Card` 堆叠形成粗糙后台模板感。
- 所有按钮都使用主色。
- 每个区块都有重阴影。
- 标题过大、留白过大，导致首屏信息过少。
- 卡片高度不齐、文本撑破、标签换行失控。
- 表格和表单没有清晰的操作层级。
- 页面内出现无业务价值的装饰文案。

## 6. 布局规则

工作台布局：

- 顶栏高度固定。
- 侧边栏宽度固定，可折叠。
- 主内容区域使用弹性布局，避免页面整体横向滚动。
- 表格、编辑器、预览器允许内部滚动。
- 筛选区默认单行收纳，复杂筛选放入 Drawer。
- 高风险操作放入 ConfirmDialog。

原型运行时布局：

- 大屏默认设计基准为 `1920x1080`。
- PC 仪表盘默认使用栅格布局。
- 移动端原型必须使用单列或明确断点布局。
- DSL 中必须声明画布尺寸、布局模式和组件边界。
- 渲染器不得让动态文本撑破组件边界。

## 7. 表单规则

- 表单字段必须有 label。
- 必填字段必须有校验。
- 错误信息显示在字段附近。
- 提交按钮进入 loading 状态，避免重复提交。
- 复杂表单按业务分组，不使用超长单列表单。
- JSON / DSL 编辑必须提供格式化、校验和错误定位。

## 8. 反馈与状态规则

所有异步动作必须有状态反馈：

- 加载中：`ProgressSpinner`、`ProgressBar` 或 `Skeleton`。
- 成功：`Toast`。
- 失败：`Toast` + 错误详情入口。
- 高风险确认：`ConfirmDialog`。
- 长任务：任务状态面板 + 日志输出 + 可复制错误信息。

必须覆盖以下状态：

- 初始空状态。
- 加载状态。
- 成功状态。
- 失败状态。
- 无权限状态。
- 构建中状态。
- 部署中状态。
- 版本不可用状态。

## 9. DSL 编辑与渲染约束

DSL 是平台与原型运行时之间的契约。前端不得直接依赖自然语言描述生成页面，必须通过结构化 DSL 渲染。

DSL 最小结构：

```json
{
  "schemaVersion": "0.1.0",
  "projectId": "project-demo",
  "page": {
    "id": "page-overview",
    "name": "项目总览",
    "viewport": {
      "width": 1920,
      "height": 1080
    },
    "layout": {
      "type": "grid",
      "columns": 24,
      "rows": 12,
      "gap": 16
    },
    "components": []
  }
}
```

组件渲染规则：

- 每个组件必须有 `id`、`type`、`title`、`layout`、`dataBinding`。
- 未识别组件类型必须渲染为错误占位组件。
- 数据缺失必须渲染为空状态，不得导致页面崩溃。
- 图表组件必须有默认安全配置。
- 文本组件必须处理超长文本。
- 渲染器只消费已校验 DSL。

## 10. 组件 DSL 命名

MVP 组件类型先控制在小集合：

| 类型 | 用途 |
| --- | --- |
| `metric-card` | 核心指标卡 |
| `trend-line` | 趋势折线图 |
| `category-bar` | 分类柱状图 |
| `rank-list` | 排名列表 |
| `data-table` | 明细表格 |
| `status-tag-group` | 状态分布 |
| `map-panel` | 地图占位或区域分布 |
| `text-block` | 标题、说明、结论 |
| `filter-bar` | 筛选条件 |

命名规则：

- `type` 使用 kebab-case。
- 字段名使用 camelCase。
- 枚举值使用 kebab-case。
- 所有 ID 使用稳定字符串，不使用数组下标作为 ID。

## 11. 目录建议

MVP 前端建议目录：

```text
src/
├─ app/
│  ├─ main.ts
│  ├─ router.ts
│  └─ primevue.ts
├─ assets/
├─ components/
│  ├─ common/
│  ├─ workspace/
│  └─ prototype/
├─ dsl/
│  ├─ schema/
│  ├─ validators/
│  ├─ renderer/
│  └─ examples/
├─ pages/
├─ stores/
├─ services/
├─ styles/
└─ types/
```

## 12. 质量门禁

提交前必须满足：

- TypeScript 无类型错误。
- ESLint 无错误。
- 关键页面无控制台错误。
- 主要页面在 1440px、1920px、移动端宽度下不重叠。
- DSL 示例可以成功渲染。
- 构建产物可以本地预览。

前端实现中禁止：

- 在页面中硬编码大量 mock 数据，mock 数据应放入 `dsl/examples` 或 `services/mock`。
- 将业务字段散落在模板中。
- 使用未封装的第三方 UI 控件替代 PrimeVue 基础控件。
- 直接拼接 HTML 渲染模型输出。
- 让 AI 生成内容绕过 DSL schema 校验进入运行时。

## 13. 参考来源

- PrimeVue 官网：https://primevue.org
- PrimeVue DataTable：https://primevue.org/datatable/
- PrimeVue Icons：https://primevue.org/icons/
- PrimeVue Styled Mode：https://primevue.org/theming/styled/
