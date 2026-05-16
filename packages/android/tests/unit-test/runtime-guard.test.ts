import type { RuntimeRecoveryState } from '@midscene/core';
import { describe, expect, it, vi } from 'vitest';
import {
  AndroidRuntimeGuard,
  AndroidRuntimeGuardError,
  detectAndroidRuntimeIssuesFromTree,
  normalizeAndroidRuntimeIssues,
} from '../../src/runtime-guard';
import { parseUiautomatorXml } from '../../src/ui-tree';

const permissionDialogXml = String.raw`
<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="com.android.permissioncontroller:id/grant_dialog" class="android.app.Dialog" package="com.android.permissioncontroller" content-desc="" clickable="false" enabled="true" bounds="[0,0][400,600]">
    <node index="0" text="Allow" resource-id="com.android.permissioncontroller:id/permission_allow_button" class="android.widget.Button" package="com.android.permissioncontroller" content-desc="" clickable="true" enabled="true" bounds="[240,500][380,560]" />
    <node index="1" text="Deny" resource-id="com.android.permissioncontroller:id/permission_deny_button" class="android.widget.Button" package="com.android.permissioncontroller" content-desc="" clickable="true" enabled="true" bounds="[20,500][160,560]" />
  </node>
</hierarchy>
`;

describe('Android runtime guard', () => {
  it('normalizes keyboard state for non-input actions only', () => {
    const state: RuntimeRecoveryState = {
      keyboard: { shown: true, inputMethod: 'demo.ime' },
      issues: [],
    };

    expect(
      normalizeAndroidRuntimeIssues(state, { actionName: 'Tap' }).map(
        (issue) => issue.kind,
      ),
    ).toEqual(['keyboard']);
    expect(
      normalizeAndroidRuntimeIssues(state, { actionName: 'Input' }),
    ).toHaveLength(0);
  });

  it('detects permission dialogs from Android UI tree', () => {
    const tree = parseUiautomatorXml(permissionDialogXml);

    const issues = detectAndroidRuntimeIssuesFromTree(tree, {
      foreground: { packageName: 'com.example', activity: '.MainActivity' },
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: 'permission-dialog',
      packageName: 'com.android.permissioncontroller',
      bounds: { left: 240, top: 500, width: 140, height: 60 },
    });
  });

  it('recovers permission dialogs before running a regular action and caches the recipe', async () => {
    const tree = parseUiautomatorXml(permissionDialogXml);
    const permissionState: RuntimeRecoveryState = {
      foreground: { packageName: 'com.example', activity: '.MainActivity' },
      issues: [
        {
          kind: 'permission-dialog',
          severity: 'warning',
          message: 'Permission dialog is visible',
        },
      ],
    };
    const cleanState: RuntimeRecoveryState = {
      foreground: { packageName: 'com.example', activity: '.MainActivity' },
      issues: [],
    };
    const recoveryState = vi
      .fn()
      .mockResolvedValueOnce(permissionState)
      .mockResolvedValueOnce(cleanState)
      .mockResolvedValueOnce(permissionState)
      .mockResolvedValueOnce(cleanState);
    const getUiTree = vi.fn().mockResolvedValue(tree);
    const tap = vi.fn().mockResolvedValue(undefined);
    const guard = new AndroidRuntimeGuard({
      recoveryState,
      getUiTree,
      tap,
      pressBack: vi.fn().mockResolvedValue(undefined),
      hideKeyboard: vi.fn().mockResolvedValue(true),
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      guard.runBeforeAction('Tap', { settleMs: 0 }),
    ).resolves.toMatchObject({ status: 'recovered' });
    await expect(
      guard.runBeforeAction('Tap', { settleMs: 0 }),
    ).resolves.toMatchObject({ status: 'recovered' });

    expect(getUiTree).toHaveBeenCalledTimes(1);
    expect(tap).toHaveBeenNthCalledWith(1, 310, 530);
    expect(tap).toHaveBeenNthCalledWith(2, 310, 530);
    expect(guard.getRecipeCacheSnapshot()).toMatchObject([
      {
        issueKind: 'permission-dialog',
        successCount: 2,
        action: { type: 'tap', x: 310, y: 530 },
      },
    ]);
  });

  it('blocks crash states before action execution', async () => {
    const guard = new AndroidRuntimeGuard({
      recoveryState: vi.fn().mockResolvedValue({
        issues: [
          {
            kind: 'crash',
            severity: 'critical',
            message: 'Process crashed',
          },
        ],
      }),
      getUiTree: vi.fn(),
      tap: vi.fn(),
      pressBack: vi.fn(),
      hideKeyboard: vi.fn(),
      sleep: vi.fn(),
    });

    await expect(guard.runBeforeAction('Tap')).rejects.toBeInstanceOf(
      AndroidRuntimeGuardError,
    );
  });
});
