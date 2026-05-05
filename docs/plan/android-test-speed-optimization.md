# Android 设备测试速度长期优化计划

## 目标

构建一套面向 Android 真机自动化测试的高速执行运行时：重复的、已知的、可验证的测试操作，应该优先通过非 AI 的确定性快路径完成；只有在缺少经验、路径不确定、候选有歧义、页面发生变化或验证失败时，才升级到 AI。

这里的目标不是移除 AI，而是重新分工：

- AI 负责自然语言理解、首次探索、歧义裁决、失败纠偏和经验归纳。
- Android runtime 负责状态采集、缓存匹配、确定性执行和结果验证。
- root、系统签名 helper APK、ADB、scrcpy、系统 API、UI tree 共同组成 AI 调用前的快路径。

长期目标：

- 大部分重复测试动作不再调用 CV locate。
- 保留自然语言编写测试用例的体验。
- 首次 AI 探索成功后，沉淀成可复用、可验证、可降级的操作经验。
- 缓存命中必须有页面作用域和结果验证，不能变成盲点坐标。
- 测试能力不局限于 UI 层，系统设置、权限、通知、日志、文件、数据库、系统状态也能纳入自动化。
- 速度指标按操作类型统计，而不是只看整条用例耗时。

## 当前基线

当前 Android locate 的执行顺序大致是：

```text
plan bbox
-> 用户显式 xpath
-> locate cache
-> Android structuredLocate
-> Android structuredLocateCandidates + AI candidate adjudication
-> CV AI locate fallback
```

CV AI locate 之前最关键的 hook 点在：

```text
packages/core/src/agent/task-builder.ts
```

也就是调用：

```ts
this.service.locate(...)
```

之前。

当前 `.cache.yaml` 里主要有：

- `plan` cache：自然语言任务 -> YAML flow。
- `locate` cache：元素描述 -> Android UI 节点特征。
- `flowMacros`：可复用流程片段。
- `experience`：页面跳转经验图。

这已经能证明方向，但还不够支撑大规模 Android 测试。现在的核心短板是：缓存仍偏向 `prompt` 级别，缺少强页面作用域、操作语义、列表上下文、滚动上下文和结果验证。

下一阶段应该从：

```text
prompt cache
```

升级到：

```text
state-scoped operation cache
```

也就是“当前状态下执行某个操作”的缓存，而不仅是“某个文字对应某个节点”的缓存。

## 核心原则

每个测试操作都应该走统一策略：

```text
1. 理解用户要做的操作。
2. 不依赖 AI 采集当前 Android 状态。
3. 基于页面作用域、缓存、UI tree、系统状态解析快路径。
4. 用最快且安全的 provider 执行。
5. 验证 UI 或系统状态是否符合预期。
6. 验证失败则降级缓存，并升级：
   structured candidates -> text AI adjudication -> CV locate -> replan。
```

缓存不是事实，只是一个“可验证的假设”。

## 需要优化的 Android 测试操作全集

### 1. App 生命周期与入口

真实测试动作：

- 安装、卸载、升级、降级、清数据。
- 通过 package、launcher 名称、activity、deep link、URL scheme、intent 启动。
- force-stop、切后台、拉前台、冷启动、热启动。
- 在被测 app、系统设置、浏览器、文件选择器、相机、相册之间切换。
- 重置权限、appops、通知权限、电池策略。
- 准备或清理文件、数据库、SharedPreferences、账号状态。

优化策略：

- 优先用 ADB/root/helper，而不是 UI 导航。
- 缓存 app 名称到 package/activity/deep link 的映射。
- 缓存稳定入口路径和启动后的前台状态。
- 用 `dumpsys activity`、package/activity、进程状态、首页 fingerprint 验证。

缓存示例：

```yaml
type: app-entry
intent: open app settings page
scope:
  packageName: com.demo.app
  appVersion: 10023
entry:
  command: am start ...
expected:
  foregroundPackage: com.demo.app
  pageFingerprint: demo-home
```

### 2. 系统导航

真实测试动作：

- Back、Home、Recent Apps。
- 打开通知栏、快捷设置、系统设置页。
- 进入权限页、应用详情页、Wi-Fi、蓝牙、定位、开发者选项。
- 处理手势导航和三键导航差异。
- 唤醒、解锁、锁屏、dismiss keyguard。
- 横竖屏切换、多窗口、画中画、多 display。

优化策略：

- 优先用系统命令和 helper input injection。
- 按 SDK、OEM、locale 缓存系统设置页面路径。
- 用前台 package/activity、window、page fingerprint 验证。
- 对常见系统页建立 route library，避免每次视觉探索。

风险：

- OEM 设置页差异很大。缓存必须包含 manufacturer、SDK、locale、系统版本作用域。

### 3. 元素激活类操作

真实测试动作：

- 点击按钮、文本行、tab、菜单项、toolbar 图标、switch、checkbox。
- 长按、双击、右键/上下文菜单。
- 点击列表项：按文本、按序号、按行上下文、按兄弟文本。
- 点击某一行里的操作按钮，例如“点击 wxy 这一行的删除”。
- 打开 overflow menu 并选择菜单项。

优化策略：

- 优先用带页面作用域的 selector cache。
- 当前 UI tree 中验证候选后再执行。
- selector 不只存坐标，要存 resource-id、content-desc、text、class、ancestor、sibling、row context。
- 列表重复项要缓存“行 selector + 子操作 selector”，不能只缓存“删除按钮”。

缓存示例：

```yaml
type: operation
operation: tap
intent: tap WLAN option
scope:
  packageName: com.android.settings
  activity: .Settings
  pageFingerprint: settings-network-root
selector:
  resourceId: android:id/summary
  text: wxy
  className: android.widget.TextView
  ancestor:
    className: android.widget.LinearLayout
    siblingTexts: [WLAN, wxy]
  stablePath: /hierarchy/...
  oldBounds: { left: 128, top: 420, width: 191, height: 19 }
ambiguityPolicy:
  maxCandidates: 1
verify:
  pageFingerprintChanged: true
```

### 4. 文本输入与 IME

真实测试动作：

- 聚焦输入框、清空、替换、追加。
- 输入英文、中文、emoji、特殊字符、多行文本。
- IME action：search、done、next、send。
- 剪贴板粘贴。
- 密码框、验证码框、OTP、多输入框自动跳转。
- 收起键盘并验证键盘状态。

优化策略：

- 缓存输入框 selector 和页面作用域。
- 使用 helper/yadb/ADB text injection，避免模拟逐字符 UI 输入。
- 非 ASCII 优先走 yadb/helper IME。
- 尽可能通过 UI tree、focused node、app data 或 accessibility 读取值来验证。

安全策略：

- 不缓存密码、token、验证码等敏感值。
- 只缓存输入框 selector 和输入方式。

### 5. 手势与滚动

真实测试动作：

- 上下左右 swipe。
- fling 长列表、慢速滚动、拖动 slider。
- 下拉刷新。
- pinch zoom、地图缩放、图片预览缩放。
- 滚动直到某个文本出现。
- RecyclerView/ListView 中滚到某行，再点击行内按钮。

优化策略：

- 缓存 scroll container 身份。
- 缓存滚动前后的 anchor text/node。
- 缓存 row discovery recipe：
  `container selector + target text + direction + max scroll count`。
- helper 可用时优先用 accessibility 搜索和 scroll action。
- 用可见范围、目标候选、页面 fingerprint 变化验证。

缓存示例：

```yaml
type: scroll-recipe
intent: scroll to WLAN advanced options
scope:
  pageFingerprint: wifi-page
container:
  resourceId: com.demo:id/list
  className: androidx.recyclerview.widget.RecyclerView
anchors:
  before: [WLAN, Mobile network]
  after: [Advanced settings]
recipe:
  direction: down
  gesture: fling
  maxAttempts: 4
```

### 6. 等待与同步

真实测试动作：

- 等待页面加载完成。
- 等待元素出现/消失。
- 等待 loading/progress 消失。
- 等待 toast、snackbar、notification。
- 等待 package/activity/window 切换。
- 等待下载、安装、重启、网络结果。

优化策略：

- 将自然语言 wait 转成确定性 predicate。
- 缓存页面 ready signature。
- 优先轮询 UI tree、foreground state、logcat、dumpsys、helper event。
- 除非是纯视觉内容，否则不要用截图轮询。

示例：

```text
等待 Connected 出现
-> 轮询 UI tree text/resource-id

等待应用打开
-> 轮询 foreground package/activity

等待下载完成
-> 轮询 notification/file/logcat/app state
```

### 7. 断言与信息提取

真实测试动作：

- 断言文本存在、按钮可用、switch 已打开、输入框值正确。
- 断言当前页面、当前 app、权限状态、网络状态。
- 提取列表内容、表格、设置项、账号信息。
- 图像/视频/地图/canvas 的视觉断言。
- UI 操作后对比系统状态或本地数据状态。

优化策略：

- 优先使用 UI tree、helper accessibility、dumpsys、settings provider、app data、logcat、root 文件读取。
- 缓存 assertion predicate，而不是缓存断言结果。
- CV assertion 只作为纯视觉内容 fallback。

缓存示例：

```yaml
type: assertion-predicate
intent: current page is WLAN settings
scope:
  packageName: com.android.settings
predicate:
  anyText: [WLAN, Available networks]
  activityMatches: com.android.settings
  minConfidence: 0.9
```

### 8. 异常守护与恢复

真实测试动作：

- 权限弹窗：允许、拒绝、仅本次允许。
- 系统弹窗、电池优化、通知权限。
- crash dialog、ANR dialog。
- 用户协议、隐私弹窗、更新弹窗。
- 广告、浮层、新手引导。
- 登录墙、captcha、网络错误。
- 键盘遮挡目标。

优化策略：

- 每个操作前先跑 runtime guard。
- helper/root/system API 用来识别 foreground windows 和 overlay。
- 按 issue kind、app、OEM 缓存 recovery recipe。
- recovery 的验证标准是异常消失，而不是点击动作返回成功。

守护顺序：

```text
crash/ANR
-> permission/system dialog
-> keyboard
-> known app popup
-> ad/update/privacy overlay
-> normal action
```

### 9. 设备与系统状态操作

真实测试动作：

- 开关 Wi-Fi、蓝牙、定位、飞行模式、深色模式。
- 修改语言、字体大小、显示大小。
- grant/revoke permissions、appops。
- 修改 settings provider、system property、文件。
- 启停 service、broadcast、intent。
- 收集 CPU、内存、电量、网络、logcat。

优化策略：

- 优先 root/system/helper API，而不是 UI。
- 按 SDK/OEM/root/helper capability 缓存命令 recipe。
- 用 framework state 验证，而不是 UI 文案。

示例：

```text
打开 Wi-Fi
-> svc wifi enable
-> verify dumpsys wifi / settings global / UI state
```

### 10. 多应用、Intent、文件与 Chooser

真实测试动作：

- share sheet。
- 文件选择器、相册选择器、相机拍照。
- 浏览器跳转、OAuth 跳转、app link。
- 剪贴板操作。
- 下载/上传文件。
- 点击通知进入 app。

优化策略：

- 缓存 intent route 和 chooser selection。
- 优先直接 seed 文件、直接 start intent。
- 用 package transition 和结果文件/app state 验证。
- 只有当要测试用户可见 chooser 行为时才走 UI。

### 11. WebView 与 Hybrid App

真实测试动作：

- 原生页面中包含 WebView。
- 点击 WebView 内 DOM 元素。
- native -> web -> native 跳转。
- 登录、支付、活动页在 WebView 中渲染。

优化策略：

- 通过 package/devtools socket 识别 WebView。
- WebView debuggable 时优先 CDP/DOM selector。
- DOM 不可用时 fallback 到 Android UI tree 或 CV。
- 缓存 native page scope -> WebView socket -> DOM selector。

### 12. 媒体、相机、地图、Canvas、游戏

真实测试动作：

- 相机预览、扫码、图片预览。
- 地图拖动、缩放、选择 marker。
- canvas/chart/game 控件。
- 视频播放控制。

优化策略：

- 周边原生控件可以走 selector cache。
- 内容区域仍需要 CV 或领域 API。
- 缓存相机/媒体 setup 和稳定控制按钮。
- 可用时使用 mock camera、定位注入、media session、地图坐标等领域能力。

### 13. 测试数据与后端状态

真实测试动作：

- 准备账号状态。
- seed 本地数据库、SharedPreferences、文件。
- mock 网络或设备标识。
- UI 操作后检查日志、数据库、持久化状态。

优化策略：

- 这些应当是一等 test module，而不是通过 UI 绕很远。
- 使用 root/system/helper 能力和 app-specific adapter。
- 缓存 setup module 和 verification predicate。
- 当 UI 本身不是被测对象时，避免用 UI 做 setup。

## 需要建设的缓存类型

### 1. Plan Cache

自然语言任务 -> canonical workflow DSL。

适合：

- 重复自然语言测试指令。
- setup flow。
- 已知 app/system route。

风险：

- 当前页面不同但 prompt 相同，直接 replay YAML 可能错。

必须升级：

- 增加 expected start scope。
- 增加 expected end verification。

### 2. Operation Cache

canonical operation + scope -> deterministic executor。

示例：

```text
tap(settings-network-root, WLAN option)
input(login-page, username field)
wait(settings-page, WLAN text visible)
```

这是未来最重要的速度缓存，不应该只缓存模型输出。

### 3. Selector Cache

目标描述 + 页面作用域 -> 当前 UI 节点 selector。

selector 应包含：

- resource-id
- text/content-desc
- class
- package
- stable path
- ancestor chain
- sibling texts
- row/list container identity
- old bounds 作为弱提示
- node hash 作为快速 exact hint

### 4. State Transition Cache

before state + action -> expected after state。

示例：

```text
settings-home + tap WLAN -> wifi-page
```

用途：

- 更快验证。
- 经验图。
- stale cache 检测。

### 5. Scroll Recipe Cache

container + target + direction -> scroll recipe。

用途：

- RecyclerView/ListView。
- 长设置页面。
- 重复 setup 页面。

### 6. Recovery Cache

runtime issue + scope -> recovery operation。

示例：

- permission dialog -> tap Allow。
- crash dialog -> collect logcat + restart app。
- keyboard visible -> hide keyboard before tapping covered target。

### 7. Device Capability Cache

device/OEM/SDK/root/helper capability -> supported fast providers。

示例：

- helper 是否可用。
- root 是否可用。
- 当前 input backend。
- scrcpy 是否可用。
- WebView devtools socket 是否可用。

## 匹配与准确性模型

### 必须有 Scope

每个 operation-level cache 都需要 scope：

```yaml
scope:
  packageName: com.android.settings
  activity: com.android.settings.Settings
  windowTitle: Settings
  pageFingerprint: ...
  locale: zh-CN
  sdk: 35
  manufacturer: Xiaomi
  displayId: 0
  orientation: portrait
```

scope 匹配结果分级：

- exact：可以走确定性快路径。
- compatible：可以使用 selector，但验证要更严格。
- mismatch：跳过 cache。
- unknown：走 structured locate 或 AI candidate adjudication。

### 候选评分

selector match 应返回候选列表，而不是只返回一个 rect。

评分维度：

- page scope match。
- resource-id exactness。
- text/content-desc exactness。
- class exactness。
- ancestor/sibling match。
- row/container match。
- old bounds proximity。
- visible/enabled/clickable。
- previous success rate。
- recency 与 app version 兼容性。

决策规则：

```text
score >= 0.92 且无接近竞争者 -> execute
score >= 0.72 但存在歧义 -> AI candidate adjudication 或更严格上下文
score < 0.72 -> skip cache
scope mismatch -> skip cache
```

### 重复元素

重复元素必须建模成：

```text
row selector + child selector + intent
```

不能只建模成：

```text
button text
```

例如：

```text
点击 wxy 这一行的删除
```

应该缓存：

- row identity：文本 `wxy`、兄弟节点、容器。
- child identity：这一行里的删除按钮/图标。
- relationship：child 是 row 的 descendant 或 right-side action。

### 滚动页面

滚动页面不能假设旧坐标仍然可用。

推荐流程：

```text
1. 当前 UI tree 里目标是否可见？
2. 可见则 selector match。
3. 不可见则识别 scroll container。
4. 执行 cached scroll recipe。
5. 重新 snapshot UI tree。
6. 再 match selector。
```

old bounds 只作为弱提示，不能作为强定位依据。

### Stale Cache

每个 cache entry 应记录：

- hit count。
- success count。
- failure count。
- last success time。
- app version。
- page fingerprint version。
- last failure reason。

规则：

- 验证失败会降低 confidence。
- 多次失败会禁用 entry。
- app 升级或 page fingerprint 漂移会降低 confidence。
- AI/CV fallback 成功后可以刷新 selector。

## CV AI 调用前的非 AI 工作流

最终的 pre-CV pipeline 应该是：

```text
Natural-language command
  -> Operation Router
    -> plan cache / deterministic parser / AI planning fallback

Operation IR
  -> Runtime Guard
    -> crash/ANR/permission/keyboard/popup handling

Scoped State Snapshot
  -> package/activity/window/page fingerprint/UI tree/helper state

Fast Path Resolver
  -> operation cache
  -> selector cache
  -> scroll recipe cache
  -> system command recipe
  -> structured locator
  -> candidates

Executor
  -> helper API / root shell / ADB / scrcpy input / accessibility

Verifier
  -> UI tree predicate / foreground state / dumpsys / logcat / screenshot

Escalation
  -> AI candidate adjudication
  -> CV locate
  -> AI replan
```

## 代码 Hook 点

### Planning AI 之前

针对重复的完整自然语言任务：

```text
packages/core/src/agent/agent.ts
```

在 `aiAct(...)` 的 planning model 调用前插入：

- plan cache。
- flow macro。
- experience graph。
- 常见命令 deterministic parser。

### CV Locate AI 之前

针对重复元素操作：

```text
packages/core/src/agent/task-builder.ts
```

在 `this.service.locate(...)` 之前插入：

- scoped operation cache。
- locate cache。
- Android structured locate。
- candidate set。
- helper APK selector API。

### Android 确定性 Provider

Android 实现应主要落在：

```text
packages/android/src/device.ts
packages/android/src/ui-tree/**
packages/android/src/fast-locator.ts
future helper client/APK protocol files
```

## Helper APK 的角色

helper APK 应该让非 AI 快路径更强、更快，而不是只提供截图。

高价值 API：

- 快速 accessibility/window hierarchy snapshot。
- 稳定 node id 或 accessibility node reference。
- 直接 input injection，并返回执行状态。
- foreground package/activity/window stack。
- 权限弹窗、系统弹窗、crash、ANR 检测。
- notification snapshot 与 notification action。
- WebView context discovery。
- settings provider read/write。
- appops/permissions/package state。
- log/event streaming。
- scroll container search and action。

helper 返回的核心应该是结构化状态，而不是图片。

## 指标体系

每种操作都要统计：

- total operation latency。
- AI planning latency。
- CV locate latency。
- UI tree snapshot latency。
- helper latency。
- cache hit rate。
- cache stale rate。
- false-positive rate。
- fallback rate。
- recovery rate。
- verification failure rate。

核心速度指标：

```text
percentage of operations completed before CV locate
```

核心安全指标：

```text
wrong-action rate after cache hit
```

## Benchmark Suite

需要一套可重复 benchmark：

1. Settings smoke：
   - 打开 Settings。
   - 进入 WLAN。
   - 检查常见设置项。
2. Permission smoke：
   - 安装 app。
   - 启动。
   - 处理权限弹窗。
3. Login form：
   - 输入 username/password。
   - submit。
   - assert result。
4. RecyclerView/list：
   - 滚动到目标行。
   - 点击行内 action。
   - 验证详情页。
5. Popup recovery：
   - privacy/update/ad/keyboard/system dialog。
6. Cross-app：
   - share sheet 或 file picker。
7. WebView：
   - native -> WebView -> native。
8. System state：
   - Wi-Fi/Bluetooth/location/settings route。

每个 benchmark 都要跑：

- cold cache。
- warm cache。
- stale cache simulation。
- UI changed simulation。
- helper unavailable。
- helper available。

## 实施路线

### Phase A: Cache Correctness Foundation

状态：已完成第一版实现。`plan`/`locate` cache 已具备 page scope、验证结果统计、stale/degraded 状态；`locate` cache 已记录 operation type，并保留已有 dedupe 与 per-action cache match reset。

交付：

- 给 `plan` 和 `locate` cache 增加 page scope。
- locate cache 增加 operation type。
- cache hit 后记录 verification result。
- cache entry 增加 stale/degraded 状态。
- 保留当前 dedupe 和 per-action cache match reset。

验收：

- 同 prompt 在不同页面不会盲用 cache。
- 重复 cache 不再膨胀。
- cache 验证失败能安全 fallback，不误点。

### Phase B: Operation IR

交付：

- 引入 canonical operation model：
  `tap`、`input`、`scroll`、`wait`、`assert`、`launch`、`system`、`recover`。
- 自然语言命令转换成 Operation IR。
- Operation IR 独立于模型 YAML 缓存。
- 常见命令增加 deterministic parser。

验收：

- 常见 Playground 命令第二次可以跳过 planning AI。
- Operation cache 可读、可调试。

### Phase C: Scoped Selector Engine

交付：

- selector candidate scoring。
- 返回多个 candidates 和原因。
- ancestor/sibling/row/container signatures。
- ambiguity detection。
- app/OEM/locale/device scope matching。

验收：

- 相同文本按钮、重复列表行不会被当成唯一目标。
- cache 歧义时升级，而不是随机点击。

### Phase D: Scroll And List Fast Path

交付：

- 检测 scrollable container。
- 缓存 scroll recipe。
- 增加 `scrollUntilVisible` deterministic executor。
- 支持 row-scoped child action cache。

验收：

- 长列表和设置页重复路径基本不依赖 CV。
- RecyclerView 节点复用不会导致误点。

### Phase E: Runtime Guard Layer

交付：

- 每个操作前运行 guard。
- 标准化 permission/system/crash/ANR/keyboard/popup 状态。
- 缓存 recovery recipe。
- 验证 recovery action。

验收：

- 常见弹窗不再破坏缓存路径。
- crash/ANR 会先被识别，而不是继续点击。

### Phase F: Helper APK Deep Integration

交付：

- 实现 helper APK server。
- 快速 UI hierarchy snapshot。
- input injection with result。
- app/window/permission/notification/system state APIs。
- 可选 root/system-only adapters。

验收：

- UI tree 读取比 `uiautomator dump` 更快且更丰富。
- 系统状态测试不需要 UI 路线，除非测试目标就是 UI。

### Phase G: Deterministic Assertions And Extraction

交付：

- assertion predicate cache。
- UI tree extraction helpers。
- dumpsys/settings/logcat/root verification helpers。
- report 中展示 deterministic assertion source。

验收：

- 大部分断言不再调用视觉模型。
- 验证变成显式、可审计。

### Phase H: Cache Governance And Learning

交付：

- cache entry confidence score。
- success/failure counters。
- 自动 demotion 和 refresh。
- app version/page fingerprint invalidation。
- Playground/report cache inspector。

验收：

- cache 能随着测试越跑越准。
- 测试工程师能看到某条 cache 为什么被使用或跳过。

## 设计规则

- 永远不要在不验证当前状态的情况下使用 cache。
- 除非 scope exact 且目标已验证，否则不要依赖旧坐标。
- 多个候选分数接近时，不要静默选择。
- setup 和 assertion 优先系统/helper API。
- 只有 UI 行为本身是测试目标时，才优先走 UI 路线。
- 可复用知识应沉淀为 operation recipe，而不只是模型输出。
- CV AI fallback 必须保留，并在报告里可见。
- 每条快路径都要能解释：source、score、scope、verification。

## 开放问题

- Android page fingerprint 第一版应该怎么定义：text/resource-id hash、window hierarchy hash，还是 route graph node？
- cache 长期是否继续使用 YAML，还是切到小型 indexed store，并保留 YAML export？
- OEM-specific system route 知识应该写代码、写缓存，还是单独 route library？
- 哪些 helper API 必须系统签名，哪些 root 即可？
- 破坏性系统操作如何在共享 test module 中做安全门控？

## 推荐下一步

Phase A 和 Phase B 应该一起做：

1. 给 cache entry 增加 scope。
2. 引入 `tap`、`input`、`scroll`、`wait`、`assert`、`launch` 的 Operation IR。
3. Playground/report 展示每个操作的来源：
   `cache`、`structure`、`helper`、`AI candidate`、`CV`。
4. 做一个 Settings WLAN benchmark，对比 cold cache 和 warm cache。

这一步能最快让测试速度收益可见，也能为后续 Android-specific fast path 打地基。
