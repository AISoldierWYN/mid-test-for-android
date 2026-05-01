# Mid Test for Android

[简体中文](./README.zh.md)

This repository is an Android-focused fork of Midscene. The goal is to build a faster and more reliable Android automation test system on top of Midscene's natural-language and visual-model capabilities.

The planned direction is hybrid automation:

- Generate test cases from natural-language descriptions.
- Execute on Android devices through ADB, scrcpy, root capabilities, and a future system-signed helper APK.
- Prefer fast structured execution and verified experience cache before falling back to visual model localization.
- Load reusable test modules on demand, such as launch, login, permission handling, home navigation, and recovery flows.
- Detect and recover from popups, ads, crashes, ANRs, UI drift, and uncertain navigation with AI-assisted correction.

## Current Status

Phase 0-5 foundations are now implemented in this fork. The Android runtime can measure execution cost, use native UI structure before visual locate, talk to an optional helper APK, reuse modules and path experience, and provide compact recovery evidence when a step fails.

Implemented capabilities:

- Phase 0: Android diagnostics for screenshot, UI tree, ADB/helper/input/action timing, foreground package/activity, page fingerprint, and core task timing.
- Phase 1: Android UI tree extraction plus `cacheFeatureForPoint` and `rectMatchesCacheFeature` hooks so locate cache can work on native Android.
- Phase 2: pre-AI structured locate from the Android UI tree, with confidence thresholds and normal AI fallback.
- Phase 3: Node-side helper protocol/client for fast `snapshot`, `input`, `app`, `guard`, `logs`, and `events`; ADB fallback remains available when the helper is missing.
- Phase 4: reusable test modules, flow macros, cache read/write modes, and page/path experience graph.
- Phase 5: candidate adjudication, compact recovery evidence, helper guard abnormal-state hints, and experience graph hints injected into planning.

The helper APK side is intentionally pluggable. A system-signed/root helper can later fill in richer `guard`, crash, ANR, overlay, permission-dialog, and low-level device data without changing the core agent API.

## Usage

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
    // Optional. Use this when your system-signed/root helper APK is running.
    adbForward: true,
    timeoutMs: 1000,
    failOnUnavailable: false,
  },
});

await agent.launch('com.android.settings');
await agent.aiTap('Network & internet');
await agent.aiAssert('the Network settings page is open');

const diagnostics = agent.getDiagnosticsSnapshot();
const summary = summarizeAndroidDiagnostics(diagnostics);
console.log(summary);

console.log(agent.getReportStats());
await agent.flushCache();
```

Reusable flows can be registered once and run from natural-language tests or setup code:

```ts
agent.registerFlowMacro('permissions', [
  { aiTap: 'Allow button in permission dialog' },
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

When a locate step is uncertain, Android can return UI-tree candidates and the AI only chooses among that compact list. When a step fails, the next planning turn receives compact evidence containing the failed task, candidate list, current foreground state, helper guard issues, and relevant experience graph hints.

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

1. Phase 0: timing baseline and action/state observability. Done.
2. Phase 1: Android UI tree extraction and cache feature hooks. Done.
3. Phase 2: structured locate before AI locate. Done.
4. Phase 3: Node-side root/system-signed helper integration for fast snapshots, input, and guards. Node side done; APK implementation remains pluggable.
5. Phase 4: reusable modules and an experience graph. Done.
6. Phase 5: stronger AI recovery for uncertain paths and abnormal states. Done.

## License

This fork keeps the upstream Midscene MIT license.
