# Mid Test for Android

[简体中文](./README.zh.md)

This repository is an Android-focused fork of Midscene. The goal is to build a faster and more reliable Android automation test system on top of Midscene's natural-language and visual-model capabilities.

The planned direction is hybrid automation:

- Generate test cases from natural-language descriptions.
- Execute on Android devices through ADB, scrcpy, root capabilities, and a future system-signed helper APK.
- Prefer fast structured execution and verified experience cache before falling back to visual model localization.
- Load reusable test modules on demand, such as launch, login, permission handling, home navigation, and recovery flows.
- Detect and recover from popups, ads, crashes, ANRs, UI drift, and uncertain navigation with AI-assisted correction.

## Current Phase

Phase 0 is the baseline and observability phase. It adds Android runtime diagnostics so we can measure where time is spent before changing the execution strategy.

The first baseline tracks:

- screenshot and snapshot cost;
- Android action cost, including input, app launch/terminate, and ADB shell actions;
- foreground package/activity and page fingerprint around each action;
- core task timing such as UI context capture, AI locate, action execution, wait time, and after-action capture.

Diagnostics are opt-in and kept in memory, so existing Android runs are unchanged unless diagnostics are enabled.

```ts
import { agentFromAdbDevice, summarizeAndroidDiagnostics } from '@midscene/android';

const agent = await agentFromAdbDevice(undefined, {
  diagnostics: true,
  scrcpyConfig: { enabled: true },
});

await agent.launch('com.android.settings');
await agent.aiTap('Network & internet');

const diagnostics = agent.getDiagnosticsSnapshot();
const summary = summarizeAndroidDiagnostics(diagnostics);
console.log(summary);
```

## Development

Use pnpm through corepack:

```sh
corepack pnpm install
corepack pnpm run lint
corepack pnpm exec nx test @midscene/android
corepack pnpm exec nx build @midscene/android
```

AI tests require local model credentials and should not be run unless the required environment variables are configured.

Local files such as `.env`, `.env.*`, local model configuration, generated reports, dumps, and scratch architecture notes are not part of commits.

## Roadmap

1. Phase 0: add timing baseline and action/state observability.
2. Phase 1: add Android UI tree extraction and cache feature hooks.
3. Phase 2: add structured locate before AI locate.
4. Phase 3: add a root/system-signed Android helper APK for fast snapshots, input, and guards.
5. Phase 4: add reusable modules and an experience graph.
6. Phase 5: add stronger AI recovery for uncertain paths and abnormal states.

## License

This fork keeps the upstream Midscene MIT license.
