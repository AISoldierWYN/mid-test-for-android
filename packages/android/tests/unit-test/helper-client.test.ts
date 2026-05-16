import { describe, expect, it, vi } from 'vitest';
import {
  AndroidHelperClient,
  DEFAULT_ANDROID_HELPER_ENDPOINT,
} from '../../src/helper-client';

const jsonResponse = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  statusText: ok ? 'OK' : 'Bad Request',
  text: vi.fn().mockResolvedValue(JSON.stringify(body)),
});

describe('AndroidHelperClient', () => {
  it('posts snapshot requests and unwraps helper envelopes', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          screenshotBase64: 'abc',
          uiXml: '<hierarchy><node bounds="[0,0][1,1]" /></hierarchy>',
        },
      }),
    );
    const client = new AndroidHelperClient({
      endpoint: 'http://127.0.0.1:17310/',
      fetch,
    });

    await expect(
      client.snapshot({ include: ['screenshot', 'uiTree'] }),
    ).resolves.toMatchObject({
      screenshotBase64: 'abc',
      uiXml: expect.stringContaining('<hierarchy>'),
    });

    expect(fetch).toHaveBeenCalledWith(
      `${DEFAULT_ANDROID_HELPER_ENDPOINT}/snapshot`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ include: ['screenshot', 'uiTree'] }),
      }),
    );
  });

  it('passes raw JSON responses through when no envelope is used', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        handled: true,
      }),
    );
    const client = new AndroidHelperClient({ fetch });

    await expect(
      client.input({ type: 'text', text: 'hello' }),
    ).resolves.toEqual({
      handled: true,
    });
  });

  it('calls deep helper endpoints for capabilities and system APIs', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: {
            capabilities: ['system.settings', 'app.permissions'],
            systemSigned: true,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: {
            source: 'helper',
            settings: [{ namespace: 'global', key: 'wifi_on', value: '1' }],
          },
        }),
      )
      .mockResolvedValueOnce(
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
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: {
            notifications: [{ packageName: 'com.example', title: 'Ready' }],
          },
        }),
      );
    const client = new AndroidHelperClient({
      endpoint: 'http://helper.local',
      fetch,
    });

    await expect(client.capabilities()).resolves.toMatchObject({
      capabilities: ['system.settings', 'app.permissions'],
      systemSigned: true,
    });
    await expect(
      client.system({
        include: ['settings'],
        settings: [{ namespace: 'global', key: 'wifi_on' }],
      }),
    ).resolves.toMatchObject({
      settings: [{ namespace: 'global', key: 'wifi_on', value: '1' }],
    });
    await expect(
      client.permissions({
        action: 'grant',
        packageName: 'com.example',
        permission: 'android.permission.CAMERA',
        mode: 'grant',
      }),
    ).resolves.toMatchObject({ handled: true, packageName: 'com.example' });
    await expect(
      client.notifications({ packageName: 'com.example' }),
    ).resolves.toMatchObject({
      notifications: [{ packageName: 'com.example', title: 'Ready' }],
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'http://helper.local/capabilities',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'http://helper.local/system',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          include: ['settings'],
          settings: [{ namespace: 'global', key: 'wifi_on' }],
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      'http://helper.local/permissions',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      'http://helper.local/notifications',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws clear errors for helper failures', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ ok: false, error: { message: 'permission denied' } }),
      );
    const client = new AndroidHelperClient({ fetch });

    await expect(client.guard()).rejects.toThrow('permission denied');
  });

  it('throws clear errors for HTTP failures', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'missing' }, false, 404));
    const client = new AndroidHelperClient({ fetch });

    await expect(client.ping()).rejects.toThrow(
      'Android helper GET /ping failed: 404',
    );
  });
});
