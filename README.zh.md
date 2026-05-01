# Mid Test for Android

[English](./README.md)

这个仓库是基于 Midscene 的 Android 自动化测试增强分支。目标是在保留自然语言驱动和视觉模型纠偏能力的基础上，构建更快、更准、更适合 Android 设备深度测试的混合自动化系统。

整体方向是混合自动化：

- 通过自然语言描述生成测试用例。
- 在 Android 设备上通过 ADB、scrcpy、root 能力，以及后续的系统签名辅助 APK 执行测试。
- 优先走结构化快路径和可验证的经验缓存，无法确认时再回退到视觉模型定位。
- 按需加载可复用测试模块，例如启动、登录、权限处理、回首页、异常恢复等流程。
- 通过 AI 辅助纠偏，处理弹窗、广告、crash、ANR、UI 变更和路径不确定性。

## 当前状态

这个分支已经完成 Phase 0-5 的基础能力。Android 运行时可以记录耗时、在视觉定位前使用原生 UI 结构、连接可选 helper APK、复用模块和路径经验，并在步骤失败后把压缩后的纠偏证据交给下一轮 AI。

已实现能力：

- Phase 0：Android 诊断能力，覆盖截图、UI 树、ADB/helper/input/action 耗时、前台 package/activity、页面指纹和 core 任务耗时。
- Phase 1：Android UI 树提取，以及 `cacheFeatureForPoint` / `rectMatchesCacheFeature` hooks，让原生 Android 也能使用 locate cache。
- Phase 2：基于 Android UI 树的 pre-AI 结构化定位，支持置信度阈值和正常 AI fallback。
- Phase 3：Node 侧 helper 协议和客户端，支持高速 `snapshot`、`input`、`app`、`guard`、`logs`、`events`；helper 不可用时自动回退 ADB。
- Phase 4：可复用测试模块、flow macro、cache 读写模式和页面/路径经验图。
- Phase 5：候选裁决、compact recovery evidence、helper guard 异常态提示，以及 planning 注入经验图提示。

helper APK 侧保持可插拔。后续系统签名/root helper 可以继续补充更丰富的 `guard`、crash、ANR、overlay、权限弹窗和底层设备信息，而不需要改 core agent API。

## 使用方式

```ts
import {
  agentFromAdbDevice,
  summarizeAndroidDiagnostics,
} from '@midscene/android';

const agent = await agentFromAdbDevice(undefined, {
  cache: {
    id: 'settings-smoke',
    strategy: 'read-write',
  },
  diagnostics: true,
  scrcpyConfig: { enabled: true },
  structuredLocate: {
    enabled: true,
    minScore: 0.72,
    minCandidateScore: 0.45,
    maxCandidates: 5,
  },
  candidateAdjudication: {
    enabled: true,
    maxCandidates: 5,
    minConfidence: 0.45,
  },
  helper: {
    // 可选：当你的系统签名/root helper APK 已运行时开启。
    adbForward: true,
    timeoutMs: 1000,
    failOnUnavailable: false,
  },
});

await agent.launch('com.android.settings');
await agent.aiTap('网络和互联网');
await agent.aiAssert('网络设置页面已经打开');

const diagnostics = agent.getDiagnosticsSnapshot();
const summary = summarizeAndroidDiagnostics(diagnostics);
console.log(summary);

console.log(agent.getReportStats());
await agent.flushCache();
```

可复用流程可以注册一次，然后在自然语言用例或 setup 代码里复用：

```ts
agent.registerFlowMacro('permissions', [
  { aiTap: '权限弹窗里的允许按钮' },
]);

await agent.runFlowMacro('permissions');

agent.recordPathExperience({
  from: { fingerprint: 'settings-home', packageName: 'com.android.settings' },
  to: { fingerprint: 'network-page' },
  action: 'Tap',
  intent: 'open network settings',
  success: true,
  durationMs: 320,
});
```

当 locate 路径不确定时，Android 会先返回 UI 树候选，AI 只在候选中裁决。步骤失败后，下一轮 planning 会收到压缩证据，包括失败任务、候选列表、当前前台状态、helper guard 异常和相关经验图提示。

## 开发

通过 corepack 使用 pnpm：

```sh
corepack pnpm install
corepack pnpm run lint
corepack pnpm exec nx test @midscene/android
corepack pnpm exec nx build @midscene/android
```

AI 测试依赖本地模型凭据。只有在相关环境变量配置完成后才运行 AI 测试。

`.env`、`.env.*`、本地模型配置、生成报告、dump 文件和本地架构草稿不进入提交。

## 路线图

1. Phase 0：耗时基线和动作/状态观测。已完成。
2. Phase 1：Android UI 树提取和 cache feature hooks。已完成。
3. Phase 2：在 AI locate 前增加结构化定位。已完成。
4. Phase 3：Node 侧 root/系统签名 helper 集成，用于高速 snapshot、输入和异常守护。Node 侧已完成，APK 实现继续保持可插拔。
5. Phase 4：可复用模块和经验图。已完成。
6. Phase 5：增强 AI 对不确定路径和异常状态的纠偏能力。已完成。

## License

本分支保留上游 Midscene 的 MIT License。
