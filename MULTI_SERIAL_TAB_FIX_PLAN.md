# 多串口组标签修复计划

状态：F1–F5、M1–M2 代码修复、自动化回归及隔离桌面验证完成。Node >=22.12.0、原生交互、真实双端口及长时验收仍待完成，详见第 7 节。

关联文档：[多串口重构方案](MULTI_SERIAL_REFACTOR.md)、[维护快照](agent_notes.md)。本文补充当前实现的缺陷闭环，不替代既有产品约束。

## 1. 范围与证据边界

本轮审查覆盖 `tab-model.js`、`workspace-model-manager.js`、`renderer.js`、`workspace-layout-state.js` 及标签资源清理链路。执行过隔离 Node 内存探针，未启动 Electron、未连接真实端口、未运行完整测试。探针环境为 Node 20.16，实施验证须使用项目要求的 Node >=22.12.0。历史 642/642 记录不算本轮验证结果。

保持以下语义：

- 单组时 main/filter/chart/Shell 可在组内分屏之间移动；多组时串口叶不得脱离 owner，Shell 位于根级。
- 每个可见格独立保留活动标签；全局焦点决定当前终端操作，控制组决定串口设置及发送目标。Shell 获焦不改变串口控制组。
- 移动和分屏复用既有终端、parser、图表及 PTY；关闭组保留 Shell，默认组不可关闭。
- 运行态布局继续由 `workspaceModel` 唯一写入。当前配置 v16、布局快照 v1；优先修正行为，不预先升级 schema。
- 本次不扩展发布、遥测、安全模型或搜索性能改造范围。

## 2. 问题清单

行号为审查时定位，实施时以函数名和调用链为准。

| ID | 优先级 | 问题及证据 | 主要定位 |
| --- | --- | --- | --- |
| F1 | 高 | 关闭控制组后 activeGroupId 已变化，但未完整同步侧栏和别名。实际关闭函数探针中同步次数为 0；连接前会把旧控件值写入剩余组，错误端口后果来自调用链，尚未实机验证 | renderer.js：closeSerialGroup（5810）、applyActiveSerialGroup（4570）、persistActiveGroupSerialOptions（8298）、getGroupSerialOptionsForConnect（9355） |
| F2 | 高 | 整组关闭仅删除 filter/chart 清单，遗漏子资源释放。探针中终端 dispose、Worker close 均为 0 | renderer.js：closeSerialGroup、closeFilterTab、closeChartTab；serial-group-tab-lists.js：removeList；chart-parser-ipc-client.js：close |
| F3 | 中 | 多组激活根 Shell 后搜索仍返回 tab-main；导出也按控制组活动格取目标，清空却按全局焦点 | renderer.js：setFocusedTab（4713）、getActiveSearchTarget（9598）、getActiveTerminalExport（9309）、clearActiveTerminal |
| F4 | 中 | split-tab 后焦点与目标格 active 已变化，container.activePaneId 仍为旧格；探针已复现 | tab-model.js：activateTab、moveTabToPane、split-tab；workspace-model-manager.js：activePane |
| F5 | 中 | 关闭非活动过滤页强制激活回退标签，探针焦点由 Shell 变为主终端；图表关闭有相同代码模式，须补独立用例 | renderer.js：closeFilterTab（6610）、closeChartTab（7063） |
| M1 | 防御性 | 纯模型允许单组串口叶进入根行，新增组后未收回且无法移回 owner；保存恢复不等价。正常拖拽入口目前仅允许 Shell 进入根行，未确认普通 UI 可达 | tab-model.js：moveTabToRoots、add-group、moveTabToPane；workspace-layout-state.js：恢复根叶 |
| M2 | 防御性 | 共享列 add-leaf 可更新焦点但未更新列 activeTabs，使焦点叶不可见；当前创建入口额外 activate 通常补正 | tab-model.js：add-leaf、activateTab、layoutColumns |

## 3. 状态与生命周期约束

### 3.1 激活与查询

统一模型内部的激活更新路径：需要激活的 add/move/split/activate 动作同步叶焦点、所属格 active、所属组 activePaneId 和所属共享列 activeTabs。纯重排及 activate:false 操作不得隐式抢焦点。

不要求所有格都跟随全局焦点：其他格继续显示自己的活动标签。活动格必须属于组；当动作把焦点移入某组格时，该组活动格应指向此格。恢复时保留有效局部激活并修复失效引用。

提供统一的当前操作目标解析入口，返回明确的 tabId/kind/owner/terminal 能力；搜索、选区搜索、导出、清空共用身份解析，能力不足时明确禁用或提示。焦点在图表时不得静默操作另一串口终端。串口发送仍显式使用控制组，不能因为当前终端是 Shell 就改变发送对象。

### 3.2 关闭流程

区分模型移除与业务实例销毁。单标签、关闭组和 reset 复用按类型销毁流程；销毁不得再次激活、发布布局动作或逐标签保存。幂等清理应覆盖：

- filter：日志 flush、搜索监听、document listener、延迟回调、xterm、按钮及面板。
- chart：closed 标记、render frame、stream、parser IPC listener/Worker、view、异步发现及设置/导出引用。
- main：本组终端、输入绑定、解析器、输出队列及上下文。
- 组运行态：断开请求、路由、连接中回调、发送链与触发状态；旧异步完成不得复活已关闭组。

先校验关闭合法性并记录待销毁身份，再统一移除模型、清理资源、更新业务清单和控制上下文，最后渲染与合并保存。不得在清理开始前发布包含幽灵业务身份的快照。Shell 必须在删除旧列之前搬到合法宿主。

具体实现需核对断开/日志刷盘协议：本计划不假定发送 disconnect IPC 等于端口已关闭，也不把日志写失败后的丢弃当作成功清理。

## 4. 实施阶段

所有阶段先建立能暴露缺陷的行为回归，再修复。以下检查框作为完整验收门槛保留；代码实施和自动化结果已更新至第 7 节，未覆盖的人工/硬件/工具链门槛不提前勾选。

### P1：控制组切换与关闭资源（F1、F2）

- [ ] 建立显式控制组同步入口，覆盖 registry、标签/manager 别名、串口参数、显示开关、组标识及连接按钮。
- [ ] 关闭控制组后同步选定的剩余组，不额外覆盖模型已经选定的焦点；关闭后台组不改变控制组。
- [ ] 提取并接入统一业务销毁流程，逐项对照单标签关闭、整组关闭和 reset，保持日志归属与 Shell 存活。
- [ ] 覆盖 opening 中关闭、迟到回调、重复关闭、关闭后同名组 ID 复用；确认旧事件不会污染新组。

退出条件：A/B 使用不同端口及参数，关闭 B 后侧栏与控制组 A 完全一致；连接 IPC 只携带 A 参数。重复创建/关闭组后子资源与监听计数回到基线，其他组收发及 Shell 不受影响。

### P2：模型激活一致性（F4、M2）

- [ ] 让 activate/add/move/split 共用激活更新规则，明确 activate:false 与重排行为。
- [ ] 补充动作后校验：引用有效、焦点叶可见、所属格/列选择一致；不破坏其他可见格的 active。
- [ ] 比较菜单、拖拽、程序动作、manager 和恢复入口的完整链路，避免依赖 renderer 再 activate 补救。

退出条件：三组共享列与独立列中，新建/移动/拆格后焦点叶立即可见，activePaneId 正确；保存重启后位置、局部激活、焦点和比例等价。

### P3：统一操作目标与关闭焦点（F3、F5）

- [ ] 搜索、导出、清空及快捷键统一解析焦点目标；保留串口控制组语义。
- [ ] 关闭非焦点标签保持焦点和其他格 active；关闭焦点标签只接受模型计算的合法回退，不再次强制切标签。
- [ ] 核对标签事件、延迟 fit、内容 click/focusin 和搜索刷新，删除竞争性激活。

退出条件：Shell 有焦点时搜索、选区、导出与清空均针对同一个 Shell；关闭另一格标签不会抢焦点，关闭当前标签后的回退可见且属于合法位置。

### P4：准入、恢复与集成收口（M1 及全量回归）

- [ ] 统一业务 owner 准入。拒绝新产生的根级串口叶；旧异常状态在导入/恢复时按 owner 收回，保留合法相对顺序。
- [ ] 补单→多→单、根 Shell 混排、异常/缺失 ID、未知快照版本和序列化往返测试。
- [ ] 如修复无需改变持久化格式，保持 v16/v1；若确需格式变化，先补迁移、备份及回退方案再变更版本。
- [ ] 更新维护快照与本计划验收记录，区分自动化通过、实际 UI 通过和硬件待验。

## 5. 必须覆盖的回归矩阵

| 场景 | 核心断言 |
| --- | --- |
| 关闭控制组/后台组；相邻组与模型回退不同 | 控制组、焦点、侧栏及连接 payload 各自合法且一致，无旧参数回写 |
| 带过滤页/已配置图表的组反复开关 | dispose/close 各一次；无 parser listener、Worker、frame、document listener 残留 |
| pending 图表回调、Shell、日志待刷、opening 时关闭 | 无复活、无错组写入；保留 Shell；失败有可观察结果 |
| 两格/三格移动、拆格、同栏重排 | 焦点可见，组/列 active 正确，其他格内容和实例引用保持 |
| 三组共享列中向非当前组 add-leaf | 无需额外 activate 即显示焦点叶；activate:false 不改变焦点 |
| 根 Shell 搜索/选区/导出/清空 | 目标身份一致，串口发送仍使用控制组 |
| 关闭非活动及活动 filter/chart/Shell | 前者不抢焦点，后者仅执行一次合法回退 |
| 单多组转换及异常根串口叶恢复 | 不跨 owner，无重复/幽灵叶，规范化幂等 |
| 保存→正常关闭→重启 | 位置、顺序、每格 active、焦点、比例等价；无恢复期半成品保存 |

## 6. 验证与完成门槛

1. 使用 Node >=22.12.0 运行新增定向测试，再运行根 `npm test`；新增测试文件须匹配 `test/*.test.js`，不能留在默认入口外。根命令当前不包含 telemetry-server 测试。
2. 对变更 JS 执行 `node --check`，运行 `node scripts/check-renderer-module-load.js` 和 `git diff --check`。不仅断言源码字符串，还要执行真实模型、manager 与 renderer 生产函数。
3. 隔离 profile 验证真实面板 active、祖先可见、非零几何、xterm/parser/PTY 引用复用及正常重启恢复；遵循现有手动 UI 验收方式，不以截图替代交互测试。
4. 用户手动覆盖原生菜单、真实拖拽、侧栏目标、Shell 操作和多格关闭；实际双端口并发、日志归属、异常断开及长时运行单独记录，未执行不得标通过。
5. 正常关闭测试不代表崩溃/断电安全。完整报告列出命令、环境、结果及剩余风险，不以历史测试数量替代本轮证据。

## 7. 实施与验收记录

### 后续缺陷：关闭根 Shell 的控制组回退

用户复现：三组串口、两个 Shell，选中组 3 → Shell 2 → 关闭 Shell 2，内容回首组但组 3 仍高亮。根因是根叶关闭缺少控制组回退上下文，默认选首容器。修复要求：生产关闭入口将当前控制组活动叶传入统一关闭事务，当前根 Shell 关闭后回组 3；后台 Shell 关闭不抢焦点，格内 Shell 保留局部回退；无效回退安全降级。代码修复完成：关闭动作显式传入控制组活动叶，模型在单次事务内完成回退，兼容路径之外不再二次激活。新增 `test/shell-close-fallback.test.js` 15 项回归通过，主流程根全量 681/681 通过，模块加载/差异检查通过，独立审查无阻断。真实隔离桌面已验证共享列与分屏两种布局：组3活动叶选择、Shell2 关闭后焦点、可见面板、侧栏、组按钮 active/aria-selected 均回到组3，后台关闭保持焦点及其他格 active；对照诊断确认：退出时存活 1 个 PTY（A）或 3 个中先关闭 2 个（C）均退出 0；仅退出时同时存活 3 个 PTY（B，不执行任何 Shell 关闭）复现 Windows 0xE06D7363。故该异常与本次 Shell 关闭/回退链无关，指向 node-pty/ConPTY 多实例 native 退出路径，作为独立既有风险保留；未修改生产退出策略、未放宽断言。


- 修复前基线：`node scripts/run-tests.js`，Node v20.16.0，642/642 通过。该结果用于比较既有失败，不替代 Node >=22.12.0 门槛。
- 本轮保持配置 schema v16、布局快照 v1；未提交、打 tag 或发布。
- 稳定实现的主流程验证：`node scripts/run-tests.js` 为 666/666、0 失败；模型相邻 105/105；生命周期/终端目标专属 14/14。`node --check main.js`、`node --check renderer.js`、`node scripts/check-renderer-module-load.js`、`git diff --check` 通过。所有命令使用现有 Node v20.16.0，尚未满足 Node >=22.12.0 验证门槛。
- 新增 24 项行为回归经历先红后绿，包含配置回声替换业务对象、关闭后同 ID 重建、断开先于连接返回、失败日志原路径保留及隐藏焦点边界。最终独立源码审查未发现新阻断。
- 可复用的隔离桌面验证入口：`node scripts/verify-multi-serial-tab-fixes.js --run`，临时 userData/documents/logs，禁用遥测/日志，不读取真实配置；实际运行退出 0（Node 20.16.0 / Electron 28.3.3）：关闭组后侧栏/registry/别名/连接参数一致；过滤终端、parser、stream、view 各销毁一次；Shell 焦点与搜索/选区/导出/清空一致；分屏实例复用，正常关闭重启后顺序、逐格 active、焦点及 37%/63% 比例等价。两次 Electron 正常退出 0，所属进程与临时目录已清理。首轮包装器资源路径夹具问题已修正，未降低断言。

| 阶段 | 代码/测试范围 | 自动化结果 | UI/硬件结果 | 剩余问题 |
| --- | --- | --- | --- | --- |
| P1 | F1/F2：关闭组控制同步、共用销毁、连接请求/会话身份及失败日志保留 | 生命周期与终端目标专属 14/14，根全量 666/666；语法/加载/差异检查通过（Node 20.16） | 隔离桌面通过（生产函数及真实 DOM） | 实际双端口、长时和 Node >=22.12 待验 |
| P2 | F4/M2 激活统一、activate:false 焦点移动、M1 owner 规范化；新增 10 项模型回归 | 相邻模型测试 105/105、根全量 666/666，主流程均已独立运行通过（Node 20.16） | 分屏活动格、实例复用及重启布局等价通过 | Node >=22.12、原生交互待验 |
| P3 | F3/F5：共用焦点目标、后台关闭保留焦点、统一焦点事件及取消延迟布局写入 | 专属行为回归及根全量通过；主流程独立核对搜索/导出/清空与控制组发送路径 | 隔离桌面通过（生产函数及真实 DOM） | 原生菜单/真实拖拽人工回归待验 |
| P4 | M1 准入及异常 owner 恢复、单多组转换/快照幂等；配置继续 v16/v1 | 根全量 666/666、最终只读差异审查无新阻断；模型 105/105 | 隔离 profile 正常关闭/重启精确等价通过 | Node >=22.12、原生交互、双端口和长时验收待完成 |
