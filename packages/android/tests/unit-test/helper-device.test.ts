import { afterEach, describe, expect, it, vi } from 'vitest';
import { AndroidDevice } from '../../src/device';
import { parseUiautomatorXml } from '../../src/ui-tree';

const sampleXml = String.raw`
<hierarchy rotation="0">
  <node index="0" text="Sign in" resource-id="com.example:id/login" class="android.widget.Button" package="com.example" content-desc="Login button" clickable="true" enabled="true" bounds="[20,40][180,100]" />
</hierarchy>
`;

const permissionDialogXml = String.raw`
<hierarchy rotation="0">
  <node index="0" text="" resource-id="com.android.permissioncontroller:id/grant_dialog" class="android.app.Dialog" package="com.android.permissioncontroller" content-desc="" clickable="false" enabled="true" bounds="[0,0][400,600]">
    <node index="0" text="Allow" resource-id="com.android.permissioncontroller:id/permission_allow_button" class="android.widget.Button" package="com.android.permissioncontroller" content-desc="" clickable="true" enabled="true" bounds="[240,500][380,560]" />
  </node>
</hierarchy>
`;

const jsonResponse = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  statusText: ok ? 'OK' : 'Service Unavailable',
  text: vi.fn().mockResolvedValue(JSON.stringify(body)),
});

describe('AndroidDevice helper integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses helper snapshots for screenshots', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          screenshotBase64: 'abc',
          screenshotFormat: 'png',
        },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const device = new AndroidDevice('test-device', {
      helper: { endpoint: 'http://helper.local', timeoutMs: 100 },
      scrcpyConfig: { enabled: false },
    });

    await expect(device.screenshotBase64()).resolves.toBe(
      'data:image/png;base64,abc',
    );
    expect(fetch).toHaveBeenCalledWith(
      'http://helper.local/snapshot',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ include: ['screenshot'] }),
      }),
    );
  });

  it('uses helper snapshots for UI trees', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          uiXml: sampleXml,
          screen: {
            logicalSize: { width: 100, height: 200 },
            physicalSize: { width: 200, height: 400 },
          },
        },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const device = new AndroidDevice('test-device', {
      helper: { endpoint: 'http://helper.local', timeoutMs: 100 },
      scrcpyConfig: { enabled: false },
    });

    const tree = await device.getElementsNodeTree();
    expect(tree.children[0].node).toMatchObject({
      content: 'Sign in Login button',
      center: [50, 35],
      rect: { left: 10, top: 20, width: 80, height: 30 },
    });
  });

  it('uses helper input injection when available', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          handled: true,
        },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const device = new AndroidDevice('test-device', {
      helper: { endpoint: 'http://helper.local', timeoutMs: 100 },
      scrcpyConfig: { enabled: false },
    });

    await device.keyboardType('hello', { autoDismissKeyboard: false });

    expect(fetch).toHaveBeenCalledWith(
      'http://helper.local/input',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          actions: [
            {
              type: 'text',
              text: 'hello',
              autoDismissKeyboard: false,
            },
          ],
        }),
      }),
    );
  });

  it('sets up adb localabstract forward for helper requests', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          screenshotBase64: 'abc',
          screenshotFormat: 'png',
        },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const device = new AndroidDevice('test-device', {
      helper: {
        adbForward: {
          localPort: 19191,
          localAbstractName: 'custom_helper',
        },
        timeoutMs: 100,
      },
      scrcpyConfig: { enabled: false },
    });
    const mockAdb = {
      forwardAbstractPort: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(device, 'getAdb').mockResolvedValue(mockAdb as any);

    await expect(device.screenshotBase64()).resolves.toBe(
      'data:image/png;base64,abc',
    );
    expect(mockAdb.forwardAbstractPort).toHaveBeenCalledWith(
      19191,
      'custom_helper',
    );
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:19191/snapshot',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('falls back to ADB UI tree when helper is unavailable', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'offline' }, false, 503));
    vi.stubGlobal('fetch', fetch);
    const device = new AndroidDevice('test-device', {
      helper: { endpoint: 'http://helper.local', timeoutMs: 100 },
      scrcpyConfig: { enabled: false },
    });
    const mockAdb = {
      shell: vi.fn().mockResolvedValue(sampleXml),
    };
    vi.spyOn(device, 'getAdb').mockResolvedValue(mockAdb as any);
    vi.spyOn(device as any, 'getOrientedPhysicalSize').mockResolvedValue({
      width: 200,
      height: 400,
    });
    vi.spyOn(device, 'size').mockResolvedValue({ width: 100, height: 200 });

    await expect(device.getElementsNodeTree()).resolves.toBeTruthy();
    expect(mockAdb.shell).toHaveBeenCalledWith(
      expect.stringContaining('uiautomator dump --compressed'),
    );
  });

  it('exposes helper guard state as recovery evidence', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          timestamp: 123,
          foreground: {
            packageName: 'com.example',
            activity: '.MainActivity',
            pageFingerprint: 'home',
          },
          keyboard: {
            shown: true,
            inputMethod: 'demo.ime',
          },
          guard: {
            permissionDialog: true,
            crash: {
              detected: true,
              packageName: 'com.example',
              message: 'Process crashed',
            },
            overlays: [
              {
                packageName: 'com.ads',
                title: 'Advertisement',
                bounds: { left: 0, top: 0, width: 100, height: 50 },
              },
            ],
          },
        },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const device = new AndroidDevice('test-device', {
      helper: { endpoint: 'http://helper.local', timeoutMs: 100 },
      scrcpyConfig: { enabled: false },
    });

    const state = await device.recoveryState();

    expect(state).toMatchObject({
      timestamp: 123,
      foreground: {
        packageName: 'com.example',
        activity: '.MainActivity',
        pageFingerprint: 'home',
      },
      keyboard: {
        shown: true,
        inputMethod: 'demo.ime',
      },
    });
    expect(state.summary).toContain('permission-dialog');
    expect(state.issues?.map((issue) => issue.kind)).toEqual([
      'permission-dialog',
      'crash',
      'ad',
    ]);
    expect(fetch).toHaveBeenCalledWith(
      'http://helper.local/snapshot',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          include: [
            'foreground',
            'keyboard',
            'overlays',
            'crash',
            'anr',
            'guard',
          ],
        }),
      }),
    );
  });

  it('runs runtime guard before action-space actions', async () => {
    const device = new AndroidDevice('test-device', {
      runtimeGuard: { settleMs: 0 },
      scrcpyConfig: { enabled: false },
    });
    const permissionState = {
      foreground: { packageName: 'com.example', activity: '.MainActivity' },
      issues: [
        {
          kind: 'permission-dialog',
          severity: 'warning',
          message: 'Permission dialog is visible',
        },
      ],
    } as const;
    const cleanState = {
      foreground: { packageName: 'com.example', activity: '.MainActivity' },
      issues: [],
    } as const;
    vi.spyOn(device, 'recoveryState')
      .mockResolvedValueOnce(permissionState)
      .mockResolvedValueOnce(cleanState);
    vi.spyOn(device, 'getElementsNodeTree').mockResolvedValue(
      parseUiautomatorXml(permissionDialogXml),
    );
    const click = vi.spyOn(device, 'mouseClick').mockResolvedValue(undefined);
    const tapAction = device
      .actionSpace()
      .find((action) => action.name === 'Tap');

    await tapAction?.call(
      {
        locate: {
          rect: { left: 40, top: 50, width: 20, height: 20 },
          center: [50, 60],
          description: 'target button',
        },
      } as any,
      {} as any,
    );

    expect(click).toHaveBeenNthCalledWith(1, 310, 530);
    expect(click).toHaveBeenNthCalledWith(2, 50, 60);
    expect(device.getRuntimeGuardLastResult()).toMatchObject({
      status: 'recovered',
    });
    expect(device.getRuntimeGuardRecipeCache()).toHaveLength(1);
  });

  it('uses deep helper system endpoint for deterministic state reads', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          source: 'helper',
          properties: [
            {
              key: 'ro.build.version.sdk',
              value: '35',
            },
          ],
        },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const device = new AndroidDevice('test-device', {
      helper: { endpoint: 'http://helper.local', timeoutMs: 100 },
      scrcpyConfig: { enabled: false },
    });

    const state = await device.getAndroidSystemState({
      include: ['properties'],
      properties: ['ro.build.version.sdk'],
    });

    expect(state).toMatchObject({
      source: 'helper',
      properties: [{ key: 'ro.build.version.sdk', value: '35' }],
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://helper.local/system',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          include: ['properties'],
          properties: ['ro.build.version.sdk'],
        }),
      }),
    );
  });

  it('falls back to ADB system state APIs without UI navigation', async () => {
    const device = new AndroidDevice('test-device', {
      scrcpyConfig: { enabled: false },
    });
    const mockAdb = {
      shell: vi.fn(async (command: string) => {
        if (command === 'dumpsys window windows') {
          return 'mCurrentFocus=Window{123 u0 com.example/.MainActivity}';
        }
        if (command === "settings get global 'wifi_on'") {
          return '1\n';
        }
        if (command === "getprop 'ro.build.version.sdk'") {
          return '35\n';
        }
        return '';
      }),
    };
    vi.spyOn(device, 'getAdb').mockResolvedValue(mockAdb as any);

    const state = await device.getAndroidSystemState({
      include: ['foreground', 'settings', 'properties'],
      settings: [{ namespace: 'global', key: 'wifi_on' }],
      properties: ['ro.build.version.sdk'],
    });

    expect(state).toMatchObject({
      source: 'adb',
      foreground: {
        packageName: 'com.example',
        activity: '.MainActivity',
      },
      settings: [{ namespace: 'global', key: 'wifi_on', value: '1' }],
      properties: [{ key: 'ro.build.version.sdk', value: '35' }],
    });
    expect(mockAdb.shell).not.toHaveBeenCalledWith(
      expect.stringContaining('uiautomator dump'),
    );
  });

  it('exposes deterministic system state as an action-space command', async () => {
    const device = new AndroidDevice('test-device', {
      scrcpyConfig: { enabled: false },
    });
    const mockAdb = {
      shell: vi.fn(async (command: string) => {
        if (command === "getprop 'ro.build.version.sdk'") {
          return '35\n';
        }
        return '';
      }),
    };
    vi.spyOn(device, 'getAdb').mockResolvedValue(mockAdb as any);
    const action = device
      .actionSpace()
      .find((item) => item.name === 'AndroidGetSystemState');

    const result = await action?.call(
      {
        include: ['properties'],
        properties: ['ro.build.version.sdk'],
      } as any,
      {} as any,
    );

    expect(JSON.parse(result as string)).toMatchObject({
      source: 'adb',
      properties: [{ key: 'ro.build.version.sdk', value: '35' }],
    });
    expect(mockAdb.shell).not.toHaveBeenCalledWith(
      expect.stringContaining('uiautomator dump'),
    );
  });

  it('exposes deterministic permission mutation as an action-space command', async () => {
    const device = new AndroidDevice('test-device', {
      scrcpyConfig: { enabled: false },
    });
    const mockAdb = {
      shell: vi.fn().mockResolvedValue(''),
    };
    vi.spyOn(device, 'getAdb').mockResolvedValue(mockAdb as any);
    const action = device
      .actionSpace()
      .find((item) => item.name === 'AndroidSetPermission');

    const result = await action?.call(
      {
        packageName: 'com.example',
        permission: 'android.permission.CAMERA',
        mode: 'grant',
      } as any,
      {} as any,
    );

    expect(JSON.parse(result as string)).toMatchObject({
      source: 'adb',
      packageName: 'com.example',
      permissions: [{ permission: 'android.permission.CAMERA', granted: true }],
    });
    expect(mockAdb.shell).toHaveBeenCalledWith(
      "pm grant 'com.example' 'android.permission.CAMERA'",
    );
  });

  it('exposes deterministic assertions as an action-space command', async () => {
    const device = new AndroidDevice('test-device', {
      scrcpyConfig: { enabled: false },
    });
    vi.spyOn(device, 'getElementsNodeTree').mockResolvedValue(
      parseUiautomatorXml(sampleXml),
    );
    vi.spyOn(device, 'getAndroidSystemState').mockResolvedValue({
      source: 'adb',
      foreground: {
        packageName: 'com.example',
        activity: '.MainActivity',
      },
    });
    const action = device
      .actionSpace()
      .find((item) => item.name === 'AndroidAssert');

    const result = await action?.call(
      {
        predicate: {
          ui: { allText: ['Sign in'] },
          foreground: { packageName: 'com.example' },
        },
      } as any,
      {} as any,
    );

    expect(JSON.parse(result as string)).toMatchObject({
      pass: true,
      source: ['ui-tree', 'system-state'],
    });
  });

  it('fails deterministic assertion actions when requested predicate is false', async () => {
    const device = new AndroidDevice('test-device', {
      scrcpyConfig: { enabled: false },
    });
    vi.spyOn(device, 'getElementsNodeTree').mockResolvedValue(
      parseUiautomatorXml(sampleXml),
    );
    const action = device
      .actionSpace()
      .find((item) => item.name === 'AndroidAssert');

    await expect(
      action?.call(
        {
          predicate: {
            ui: { allText: ['Bluetooth'] },
          },
        } as any,
        {} as any,
      ),
    ).rejects.toThrow('Android deterministic assertion failed');
  });

  it('exposes deterministic extraction as an action-space command', async () => {
    const device = new AndroidDevice('test-device', {
      scrcpyConfig: { enabled: false },
    });
    vi.spyOn(device, 'getElementsNodeTree').mockResolvedValue(
      parseUiautomatorXml(sampleXml),
    );
    const action = device
      .actionSpace()
      .find((item) => item.name === 'AndroidExtract');

    const result = await action?.call(
      {
        source: 'uiTree',
        ui: {
          textContains: 'sign',
          includeBounds: true,
        },
      } as any,
      {} as any,
    );

    expect(JSON.parse(result as string)).toMatchObject({
      source: 'ui-tree',
      data: {
        count: 1,
        nodes: [
          {
            text: 'Sign in',
            resourceId: 'com.example:id/login',
            rect: { left: 20, top: 40, width: 160, height: 60 },
          },
        ],
      },
    });
  });

  it('sets permissions through helper and falls back to package manager commands', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          handled: true,
          packageName: 'com.example',
          permissions: [
            { permission: 'android.permission.CAMERA', granted: true },
          ],
        },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const helperDevice = new AndroidDevice('test-device', {
      helper: { endpoint: 'http://helper.local', timeoutMs: 100 },
      scrcpyConfig: { enabled: false },
    });

    await expect(
      helperDevice.setAndroidPermission({
        packageName: 'com.example',
        permission: 'android.permission.CAMERA',
        mode: 'grant',
      }),
    ).resolves.toMatchObject({ source: 'helper', handled: true });
    expect(fetch).toHaveBeenCalledWith(
      'http://helper.local/permissions',
      expect.objectContaining({ method: 'POST' }),
    );

    const adbDevice = new AndroidDevice('test-device', {
      scrcpyConfig: { enabled: false },
    });
    const mockAdb = {
      shell: vi.fn().mockResolvedValue(''),
    };
    vi.spyOn(adbDevice, 'getAdb').mockResolvedValue(mockAdb as any);

    await adbDevice.setAndroidPermission({
      packageName: 'com.example',
      permission: 'android.permission.CAMERA',
      mode: 'grant',
    });

    expect(mockAdb.shell).toHaveBeenCalledWith(
      "pm grant 'com.example' 'android.permission.CAMERA'",
    );
  });

  it('uses configured helper capabilities when endpoint discovery is unavailable', async () => {
    const device = new AndroidDevice('test-device', {
      helper: {
        enabled: true,
        capabilities: ['system.settings', 'system.properties'],
      },
      scrcpyConfig: { enabled: false },
    });

    await expect(device.getAndroidHelperCapabilities()).resolves.toMatchObject({
      protocolVersion: 'configured',
      capabilities: ['system.settings', 'system.properties'],
    });
  });
});
