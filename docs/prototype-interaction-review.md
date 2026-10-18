# 有招 · 管理控制台原型（OD）交互审核

> 审核对象：`/Users/flor/Library/Application Support/Open Design/namespaces/release-stable/data/projects/aba094e4-ab46-4abc-b64e-13f273d1a7c3/admin-console.html`
> （1564 行 / 163 KB，`<title>有招 · 管理控制台</title>`，OD 项目 `aba094e4`）
> 审核目标：交互功能是否满足 `docs/permission-design.md`（权限模型）与 `docs/frontend-design.md`（页面设计 P1–P8）
> 审核日期：2026-10-19

## 1. 审核方法

原型是**自包含静态页 + 内存 state**（无后端），因此审核分两层：

| 层 | 方法 | 能证明什么 |
|---|---|---|
| 代码层 | 直接读 HTML/CSS/JS，定位渲染与门控分支 | 门控**是否被实现**、实现方式（`hidden` 属性 / 重建 / 移除） |
| 交互层 | 无头 Chrome + CDP 真实点击/填表/切身份，读取 DOM 与可见性（`getClientRects`） | 门控**是否实际生效**、写操作是否可提交 |

可复现脚本（工作区外临时目录）：`/tmp/od-audit2.mjs`（23 场景全量）、`/tmp/od-audit3.mjs`、`/tmp/od-audit4.mjs`、`/tmp/od-audit5.mjs`、`/tmp/od-audit6.mjs`、`/tmp/od-audit7.mjs`、`/tmp/od-audit8.mjs`、`/tmp/od-audit9.mjs`；输出 `/tmp/od-out*.json`。

**方法局限（未验证项，勿当作已通过）**

- 静态原型无后端，所有写操作只落在内存 `state`，刷新即重置；本审核只评判**交互与可见性**，不代表真实服务端鉴权。
- `input[type=file]` 无法程序化赋值 → **ZIP 上传/解包/路径穿越校验路径未实测**，只验证了入口与必填声明。
- 预览 `iframe` 的 `src` 为空 → 产物加载、超时、产物缺失、无权等状态未实测。
- 原型用 `#role-switch`（演示身份）切换身份，"普通用户" 固定映射到 `user-chen`（`admin-console.html:638`），登录表单接受任意种子账号但身份仍按 `role` 硬编码（用 `wu.shiyu` 登录后顶栏仍显示"陈以宁"）。这是原型的演示简化，不计为设计缺陷。

## 2. 结论

**未完全满足。** 权限**模型层**的表达相当到位（四区段、按身份裁剪的人员列表、A 的可委派范围裁剪、只读授权单列、一次性 Token 显示、冲突恢复、按发布能力裁剪 Token 能力），但**门控的"落地"存在系统性缺陷**，导致三类问题：

1. **身份切换后不重渲染、不走守卫** → 越权视图与写入口残留在屏幕上（P0）；
2. **`hidden` 属性对 `.btn` 一类元素完全失效** → 所有"按能力隐藏"的入口实际都可见（P0）；
3. **卡片操作区未按能力装配，且维护写操作无校验** → 只有查看权的用户可见并能**成功提交**维护/改名（P0）。

统计：**P0 × 4、P1 × 5、P2 × 5、语义待确认 × 5**。

## 3. 缺陷清单

### P0 — 门控失效（会让不具权限的身份看到/触达写操作）

| # | 现象 | 实测证据 | 设计依据 | 根因 |
|---|---|---|---|---|
| **D1** | **身份切换后当前页不重渲染、页面守卫不执行**。平台所有者停在「蓝图」页切到普通用户后：顶栏身份已变、导航已隐藏，但**列表仍是所有者的 4 张卡、"可见蓝图 6 项"、卡片上仍挂着 `maintain/cover/delete/publish`**；停在「权限」页切换后，**「添加管理员」「所有者移交」入口仍可见可点**。切身份提示 toast 也不出现。 | `switch-user-on-blueprints`：after.cards=4、count="可见蓝图 6 项"、cardActs=[["maintain","cover","delete","publish"],…]、`#create-blueprint-button` hidden=false；`switch-user-on-permissions`：after.addAdminVis=true、transferVis=true、toast=null | P4/P5「按身份裁剪」「直达 URL 一律 /403」；`docs/permission-design.md` §4 不变量 10（命名空间隔离） | `admin-console.html:797` 引用**从未定义**的 `permissionsVisible`（全文件仅此一处），`switchRole()` 每次在此抛 `ReferenceError` → 函数自该行中断：① 守卫不执行 ② `:801-805` 的 `renderBlueprints/renderUsers/renderPermissions/renderTokens/renderAccount` 全部不执行 ③ `:806` 的切换 toast 不执行。导航隐藏（`:794-796`）在抛错之前，所以"导航看起来是对的" |
| **D2** | **凡用 `hidden` 属性门控、且元素自身带强制 `display` 的控件，隐藏全部失效**。普通用户（仅查看权）**看得见并点得开**「新建蓝图」；`#blueprint-more-wrap` 已到底仍可见；「新建分组」对任何角色都可见。 | 陈以宁：`#create-blueprint-button` `hidden=true` 但 `getComputedStyle.display='flex'`、`getClientRects()=1`（可见）；`#blueprint-more-wrap` `hidden=true` 而"加载更多"按钮仍可见；`[data-action="create-group"]` `hidden=false` 且可见（周予安同） | P2「有发布能力才有发布新版本、两者皆无则整个操作区不渲染」 | 只有 `.nav-link[hidden]`(`:95`)、`.page[hidden]`(`:121`)、`.account-menu-panel[hidden]`(`:316`)、`.shell[hidden]`(`:327`)、`.auth-form[hidden]`(`:335`) 有 `display:none` 规则；而 `.btn`(`:128`) 是 `display:inline-flex`、`.load-more-row`(`:250`) 是 `display:flex` → `hidden` 属性被作者样式覆盖。受影响控件：新建蓝图、新建分组、卡片维护/覆盖/删除/删除版本、归档、加载更多、添加管理员、添加业务能力、移交所有者、新建 Token（新建用户因普通用户不可达该页而无实际影响） |
| **D3** | **卡片操作区未按能力装配 + 维护写操作无权限校验**。陈以宁（查看权 + 仅"蓝图管理"）首卡实测操作 = `maintain`、`cover`、`delete`；**点「维护」→ 保存 → 返回成功 toast「蓝图信息已保存」**（写操作实际执行）；「覆盖已有版本？」「删除蓝图」确认弹窗同样可达。 | `member-manage-attempt`：maintainDialog.title="维护蓝图"、deleteDialog 文案完整；`member-maintain-save`：after.toast="蓝图信息已保存：分组、标签与归档状态已更新。"、dialogOpen=false | P2 卡片操作按能力装配表（预览/查看权；维护·覆盖·删除/`blueprint.manage`；发布/`blueprint.publish`） | `:975` 已正确算出 `blueprintCapabilities(blueprint)`（manage/publish），但卡片渲染与 `submit-blueprint` 提交路径没有使用它 |
| **D4** | 「新建分组」未做能力门控，对所有角色可见（`:1005` 只在删除分组上判断了 `groupManage`）。 | `[data-action="create-group"]` hidden=false / vis=true（陈以宁、周予安、所有者均可见） | P2「新建分组需覆盖目标范围的 `blueprint.manage`」 | 同上，入口未接 `blueprintCapabilities` |

### P1 — 一致性与状态表达

| # | 现象 | 实测证据 | 根因 |
|---|---|---|---|
| **D5** | 页头数量与列表口径不一致：数量算的是"全部可见"，列表还叠了状态筛选。 | 所有者为「可见蓝图 6 项」，未归档列表先 4 张、加载更多后 5 张（第 6 项为已归档，`archivedVisible=0`） | `:989` 用 `authorized.length`，`:996` 列表用 `visible`（已应用 `status` 筛选） |
| **D6** | 「加载更多」到底后仍显示。 | after：`#blueprint-more-wrap.hidden=true` 但按钮 `vis=true` | `:1016` 判断正确，被 `.load-more-row{display:flex}` 覆盖（同 D2） |
| **D7** | 令牌表列错位：表头 7 列（含「绑定用户」），用户管理员与普通用户的行只有 6 个单元格 → 操作列渲染在「绑定用户」列下方。 | `token-row-cells`：owner headers=7/cells=7；user headers=7/cells=[6]；`admin-tokens-view` cells=[6] | 表头与行不同源裁剪 |
| **D8** | 预览未进入"无外壳全屏"：预览激活时 `#console-shell` 仍 `display:grid`，侧栏/顶栏可见；且预览不是独立页面状态（`page` 仍为 `blueprints`）。`#preview-frame.src` 为空 → 未加载产物。 | after：shell.vis=true/display=grid、sidebar.vis=true、`.nav-list` rects=1、iframe.src=""、bodyOverflow=hidden、toolbar 文案「返回 活动管理 切换蓝图版本 v3.1 · 最新 v3.0」 | P3「无外壳全屏 + 顶部悬浮工具条」；`:744-746` 仅切 `.page` 的 hidden，未隐藏 `#console-shell`（规则已存在于 `:327`，未被使用） |
| **D9** | 未知/带查询串的 hash 直接落 403，无容错回退。 | `#blueprints?status=archived` → `page=forbidden` | `:729` 路由白名单不含带参数的路径 |

### P2 — 文案与细节

| # | 现象 | 实测证据 |
|---|---|---|
| **D10** | 删除蓝图的确认弹窗**标题复用了「维护蓝图」** | `deleteDialog.title="维护蓝图"`，正文为删除确认 |
| **D11** | 新建蓝图弹窗「上传 ZIP 压缩包」标签带 `*`，但 `#bp-file` 未设 `required`（仅 `bp-name`/`bp-version` 为 required）→ 前端不强制上传包 | `owner-create-detail`：requiredIds=["bp-name","bp-version"]、file.required=false、file.accept=".zip,application/zip" |
| **D12** | 无发布范围时弹窗不可用但入口可见：新建蓝图「所属分组」下拉为空（陈以宁 0 选项、周予安 0 选项；所有者 3 项且默认选中"默认分组"）；且提交失败后无可见错误文案（弹窗不关闭、无 toast、无文本提示） | `admin-create-dialog`/`member-create-attempt`：groupOpts=[]、提交后 dialogOpen=true、toast=null |
| **D13** | 普通用户令牌页仍渲染「绑定用户」表头（见 D7） | `token-row-cells.user.headers` 含「绑定用户」 |
| **D14** | 令牌页「全部用户」过滤器对用户管理员列出全部 6 个用户，但列表只有其自己的 1 条令牌 → 过滤器暗示的范围与数据不一致 | `admin-tokens-view`：filters=["全部用户","林知远",…]、rows=1（个人工作站） |

## 4. 符合设计的部分（实测通过）

| 设计项 | 实测证据 |
|---|---|
| 导航按身份隐藏 | 普通用户 navUsers/navPerm `hidden=true` 且不可见（`.nav-link[hidden]` 规则完好） |
| 直达 URL 拦截 | 普通用户访问 `#users`/`#permissions` → `page=forbidden` 403 页（`setPage` `:731` `canEnterAdminRoute`） |
| 用户页（所有者） | 6 人；列为 姓名/用户名/管理归属/状态/创建时间/操作；**所有者行操作列显示「受保护」**（不可被编辑/停用/重置/改派）；筛选「全部管理员 / 周予安」；指标 用户总数 6 / 用户管理员 1 / 已停用 1 |
| 用户页（用户管理员范围裁剪） | 周予安只见所管理的 2 人（陈以宁、许明澈）；说明文案「你只能管理平台所有者指派给你的用户，以及由你创建且尚未改派的用户」；**无「改派」**；指标 我管理的用户 2 / 其中已停用 1 |
| 新建用户（所有者） | 字段 用户名*/姓名/邮箱/手机号/初始密码*/**管理归属**（暂不指派 / 周予安）；提示「创建后可前往「权限」分配蓝图查看范围」；提交成功 → 新行 管理归属=未指派、指标 用户总数 7、toast 引导「下一步：分配查看范围」 |
| 新建用户（用户管理员） | **无「管理归属」字段**；创建后新用户**自动归属该管理员**（实测 管理归属=周予安、我管理的用户 3） |
| 权限页四区段 | 普通角色裁剪正确：所有者四段全显；用户管理员只有「查看范围分配」显、其余三区段 `vis=false` |
| 权限页人员列表裁剪 | 所有者候选 5 人（不含所有者本人）；用户管理员只有其所管理的 2 人 |
| 管理员与可委派范围 | 表格列 用户管理员/管理用户/可委派范围/操作；周予安 = 2 人 / 产品蓝图组、新用户引导、内容审核流程 / 调整范围 |
| 查看范围面板（用户管理员） | 「我可以调整的共 3 项」= 恰好其 delegable 三项；**他人授予的只读单列**并标注「由林知远于 2026-02-12 授予 · 只读」；`hasManageOrPublish=false`（A 无法授 manage/publish） |
| 添加用户管理员弹窗 | 候选仅普通用户；文案「任命后请明确设置其可委派范围。」 |
| 添加业务能力弹窗 | 蓝图管理/蓝图发布 单选 + 全范围多选；文案「每项能力都必须明确绑定资源范围，不存在默认的全部分组。」 |
| 所有者移交弹窗 | 接任者选择 + 输入用户名二次确认；文案「移交不可自助恢复」「移交后你将失去平台所有者身份」 |
| 冲突恢复 | 保存时模拟「权限已发生变化，请刷新后重试；未保存的变更未覆盖当前授权」+ 放弃/刷新 两动作；**用户未保存的勾选被保留**；点刷新 → toast「权限已刷新：已载入当前授权状态，冲突变更已清除」并回滚勾选；再次保存成功 |
| 未保存变更离开保护 | `:735` `hasPendingChanges()` → `confirmDiscard()` 先确认再离开权限页 |
| Token 一次性显示 | 创建成功后进入「Token 已创建」：文案「原文仅在此处显示一次。关闭后无法再次查看。请立即复制并保存。」+ 明文 + 「复制 Token」+「我已保存」 |
| Token 能力裁剪 | 所有者：只读/发布 两个单选；**普通用户：只有「只读」**，且文案「当前账号未获授蓝图发布能力，因此不可创建发布 Token」 |
| Token 有效期 | 永不过期 / 30 天 / 90 天 / 自定义日期（+ 日期输入） |
| Token 可见范围 | 所有者见 4 条（含各种用户）、有「全部用户」筛选；普通用户只见自己 1 条、无用户筛选、行内只有 停用/启用、删除 |
| 蓝图两级结构（所有者） | 分组区头（名称 + 数量 + 默认标签 + 上下移 + 编辑/删除）+ 卡内版本切换（"选择内容审核流程版本 v1.8 · 最新 / v1.7"）+ 状态筛选（未归档/已归档/全部） |
| 卡片操作（所有者） | 首卡 `maintain/cover/delete/publish`；多版本卡额外 `delete-version`；单版本卡无 `delete-version`（符合"不得删最后一个版本"） |
| 新建蓝图弹窗（内容） | 蓝图名称*/版本号*/概述/标签/所属分组/发布说明 + **上传 ZIP 压缩包**（文案「最多 20 MB；压缩包根目录必须包含 index.html。路径穿越会被拒绝。」）；所有者下拉 3 个分组且默认「默认分组」；提示「创建蓝图的同时发布首个版本。」 |
| 覆盖确认文案 | 「将替换 v2.4 的产物，版本号与发布记录保持不变，原产物无法恢复。」（与设计一致） |
| 删除蓝图确认文案 | 「此操作将永久删除「新用户引导」及其全部版本与产物，且无法恢复。」 |
| 预览工具条与沙箱 | 工具条「返回 / 活动管理 / 切换蓝图版本」；`iframe` 带 `sandbox=""` 与 `referrerpolicy="no-referrer"`；`body.overflow=hidden` |
| 切身份时预览撤权保护 | `switchRole` `:776-781`：若预览中的蓝图在新身份下不可访问 → 停止预览 + 403 + 文案「此蓝图的查看权限已撤销。已停止显示之前的预览内容。」 |
| 我的账号（P8） | 顶栏头像菜单可进入；区段 账号资料 / 修改密码 / 我的身份与范围 / 退出登录；退出确认声明不连接真实账号 |

## 5. 语义待确认（不是缺陷，需要你裁决）

| # | 问题 | 原型现状 |
|---|---|---|
| Q1 | 「用户管理员的可委派范围」是否**同时**等于其本人查看范围？两个概念在权限文档里是分开的（可委派范围 = 能授予别人的上限；查看范围 = 自己能看到什么）。 | 周予安可见 3 项蓝图（新用户引导、内容审核流程、客户反馈处理），恰好等于其 delegable 集合；连"分组下移"排序入口都对其可见 |
| Q2 | 用户管理员是否应看到其所管理用户的 Token？ | 只显示自己 1 条；但表头有「绑定用户」列、过滤器列全部用户，二者与数据不一致 |
| Q3 | 平台所有者能否为他人创建 Token？ | 不能：创建弹窗只有一个「有效期」选择，无绑定用户/目标用户控件；但令牌表对所有者展示「绑定用户」列 |
| Q4 | 用户管理员能否被叠加业务能力？ | 「添加业务能力」的候选用户包含周予安（用户管理员） |
| Q5 | 演示身份切换器（`#role-switch`，位于「我的账号」菜单） | 原型自用；进入正式实现应移除或隔离（否则任何身份都能自升为所有者） |

## 6. 最小修复清单（按优先级）

1. **修 D1 的根因**：`:797` 的 `permissionsVisible` 改为 `canEnterAdminRoute(state.role)`（`setPage` 已在用），或在 `switchRole()` 里复用 `setPage` 的守卫并把重渲染放到守卫之前。一处修复同时解决"守卫不执行 / 不重渲染 / 无切换提示"。
2. **修 D2 的根因**：加一条全局 `[hidden] { display: none !important; }`（或至少给 `.btn`、`.load-more-row` 补 `[hidden]` 规则）。一次性修复所有"按能力隐藏"的入口与 D6。
3. **卡片操作区按 `blueprintCapabilities(blueprint)` 装配**（`:975` 已有该函数，视图与 `submit-blueprint` 提交路径都要用），并补 D4 的"新建分组"门控。
4. 计数改用 `visible.length`（`:989`）修 D5。
5. 令牌表头与行同源裁剪「绑定用户」列，修 D7/D13。
6. 预览进入时隐藏 `#console-shell`（`:327` 规则已备），并让预览成为独立路由状态，修 D8。
7. 细节：删除弹窗标题（D10）、`#bp-file` 的 `required` 与就地报错（D11/D12）、未知 hash 回退到蓝图列表（D9）、A 的令牌范围与过滤器一致（D14）。

## 7. 未覆盖项（下一轮建议）

- ZIP 包的真实上传/解包/路径穿越拦截（需真实或模拟后端）。
- 预览的真实产物加载：成功、超时、产物缺失、无权四种状态的呈现。
- 骨架/空状态/失败重试等瞬时状态（本轮的 CSS/JS 静态原型未提供可注入的失败开关）。
- P2「删除分组」确认文案是否写明"蓝图回落到默认分组 + 该分组授权被移除"两项后果。
