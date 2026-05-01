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
