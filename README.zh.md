# Mid Test for Android

[English](./README.md)

这个仓库是基于 Midscene 的 Android 自动化测试增强分支。目标是在保留自然语言驱动和视觉模型纠偏能力的基础上，构建更快、更准、更适合 Android 设备深度测试的混合自动化系统。

整体方向是混合自动化：

- 通过自然语言描述生成测试用例。
- 在 Android 设备上通过 ADB、scrcpy、root 能力，以及后续的系统签名辅助 APK 执行测试。
- 优先走结构化快路径和可验证的经验缓存，无法确认时再回退到视觉模型定位。
- 按需加载可复用测试模块，例如启动、登录、权限处理、回首页、异常恢复等流程。
- 通过 AI 辅助纠偏，处理弹窗、广告、crash、ANR、UI 变更和路径不确定性。

## 当前阶段

Phase 0 是基线与观测阶段。此阶段先补齐 Android 运行时诊断能力，在优化执行策略前明确每一步耗时在哪里。

第一版基线会记录：

- 截图和 snapshot 成本；
- Android 动作成本，包括输入、应用启动/结束、ADB shell 动作；
- 每个动作前后的前台 package/activity 和页面指纹；
- core 任务耗时，包括 UI context 获取、AI locate、动作执行、等待时间和动作后截图。

诊断默认关闭，仅在显式开启后记录到内存中，因此不会影响已有 Android 用法。

```ts
import { agentFromAdbDevice, summarizeAndroidDiagnostics } from '@midscene/android';

const agent = await agentFromAdbDevice(undefined, {
  diagnostics: true,
  scrcpyConfig: { enabled: true },
});

await agent.launch('com.android.settings');
await agent.aiTap('网络和互联网');

const diagnostics = agent.getDiagnosticsSnapshot();
const summary = summarizeAndroidDiagnostics(diagnostics);
console.log(summary);
```

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

1. Phase 0：增加耗时基线和动作/状态观测。
2. Phase 1：增加 Android UI 树提取和 cache feature hooks。
3. Phase 2：在 AI locate 前增加结构化定位。
4. Phase 3：增加 root/系统签名 Android helper APK，用于高速 snapshot、输入和异常守护。
5. Phase 4：增加可复用模块和经验图。
6. Phase 5：增强 AI 对不确定路径和异常状态的纠偏能力。

## License

本分支保留上游 Midscene 的 MIT License。
