import { afterEach, describe, expect, it, vi } from 'vitest';
import { AndroidDevice } from '../../src/device';

const sampleXml = String.raw`
<hierarchy rotation="0">
  <node index="0" text="Sign in" resource-id="com.example:id/login" class="android.widget.Button" package="com.example" content-desc="Login button" clickable="true" enabled="true" bounds="[20,40][180,100]" />
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
});
