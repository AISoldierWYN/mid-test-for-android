# Contributing

This fork focuses on Android hybrid automation testing. Keep changes aligned with the roadmap in `README.md`: measure first, add structured Android signals, then add helper-APK acceleration and AI recovery.

## Environment

Use pnpm only.

```sh
corepack pnpm install
corepack pnpm run lint
```

The workspace requires Node.js `>=18.19.0` and pnpm `>=9.3.0`.

## Repository Map

- `packages/core`: shared agent execution, task timing, planning, cache, report, and device abstractions.
- `packages/android`: Android runtime, ADB/scrcpy actions, Android diagnostics, and future structured locator/helper integration.
- `packages/android-mcp`: Android MCP surface.
- `packages/android-playground` and `apps/android-playground`: Android playground/runtime UI.
- `packages/shared`: shared utilities.
- `apps/report` and `packages/visualizer`: report and replay UI.

## Android Roadmap

1. Phase 0: timing baseline and action/state observability.
2. Phase 1: UI tree extraction and Android cache feature hooks.
3. Phase 2: structured locate before AI locate.
4. Phase 3: system-signed helper APK for fast snapshot, input, and guards.
5. Phase 4: reusable modules and experience graph.
6. Phase 5: AI-assisted recovery for uncertain paths and abnormal states.

## Development Rules

- Keep diagnostics opt-in unless the feature is explicitly intended to change default behavior.
- Prefer small, composable Android runtime modules over growing `device.ts` with unrelated responsibilities.
- Add unit tests for behavior changes. Start with the nearest package test suite.
- For Android runtime changes, run:

```sh
corepack pnpm run lint
corepack pnpm exec nx test @midscene/android
```

- If exports, package wiring, or build output changes, also run:

```sh
corepack pnpm exec nx build @midscene/android
```

AI tests require local model credentials such as `MIDSCENE_MODEL_BASE_URL`, model name, and API key. Do not commit local AI configuration.

## Commit Rules

- Use Conventional Commits with a required scope, for example `feat(android): add diagnostics baseline`.
- Never force push unless explicitly requested.
- Do not commit local-only files such as `.env`, `.env.*`, local model configs, generated reports/dumps, or scratch planning notes.
- PR or handoff summaries should list the validation commands that were run.
