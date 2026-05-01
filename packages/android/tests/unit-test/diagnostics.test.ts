import { describe, expect, it, vi } from 'vitest';
import { AndroidDevice } from '../../src/device';
import {
  AndroidDiagnosticsRecorder,
  parseForegroundState,
  summarizeAndroidDiagnostics,
} from '../../src/diagnostics';

describe('Android diagnostics', () => {
  it('parses package, activity, and page fingerprint from dumpsys output', () => {
    const state = parseForegroundState(
      'mCurrentFocus=Window{a1b2 u0 com.example.app/.MainActivity}',
      { width: 1080, height: 2400 },
    );

    expect(state.packageName).toBe('com.example.app');
    expect(state.activity).toBe('.MainActivity');
    expect(state.pageFingerprint).toHaveLength(16);
  });

  it('records timing failures without swallowing the original error', async () => {
    const recorder = new AndroidDiagnosticsRecorder(true);
    await expect(
      recorder.time('screenshot', 'capture', undefined, async () => {
        throw new Error('capture failed');
      }),
    ).rejects.toThrow('capture failed');

    const snapshot = recorder.snapshot();
    expect(snapshot.timings).toHaveLength(1);
    expect(snapshot.timings[0]).toMatchObject({
      category: 'screenshot',
      name: 'capture',
      status: 'failed',
      errorMessage: 'capture failed',
    });
  });

  it('wraps Android actions with state and duration diagnostics when enabled', async () => {
    const actionCall = vi.fn().mockResolvedValue('ok');
    const device = new AndroidDevice('test-device', {
      diagnostics: true,
      customActions: [
        {
          name: 'CustomNoop',
          description: 'test action',
          call: actionCall,
        },
      ],
    });
    const mockAdb = {
      shell: vi
        .fn()
        .mockResolvedValue(
          'mCurrentFocus=Window{a1b2 u0 com.example.app/.MainActivity}',
        ),
    };

    vi.spyOn(device, 'getAdb').mockResolvedValue(mockAdb as any);
    vi.spyOn(device, 'size').mockResolvedValue({ width: 1080, height: 2400 });

    const action = device
      .actionSpace()
      .find((item) => item.name === 'CustomNoop');
    expect(action).toBeDefined();

    await expect(action!.call({ value: 1 } as any, {} as any)).resolves.toBe(
      'ok',
    );

    const snapshot = device.getDiagnosticsSnapshot();
    expect(snapshot.steps).toHaveLength(1);
    expect(snapshot.steps[0]).toMatchObject({
      actionName: 'CustomNoop',
      status: 'success',
      resultSummary: 'ok',
    });
    expect(snapshot.steps[0].beforeState?.packageName).toBe('com.example.app');
    expect(snapshot.timings.some((event) => event.category === 'action')).toBe(
      true,
    );
    expect(snapshot.timings.some((event) => event.category === 'state')).toBe(
      true,
    );
  });

  it('summarizes core task timing together with Android runtime diagnostics', () => {
    const summary = summarizeAndroidDiagnostics(
      {
        enabled: true,
        startedAt: 1,
        timings: [
          {
            id: 'screenshot-1',
            category: 'screenshot',
            name: 'screenshotBase64',
            status: 'success',
            startedAt: 1,
            endedAt: 11,
            durationMs: 10,
          },
          {
            id: 'input-2',
            category: 'input',
            name: 'Tap',
            status: 'success',
            startedAt: 11,
            endedAt: 16,
            durationMs: 5,
          },
        ],
        steps: [
          {
            id: 'action-1',
            actionName: 'Tap',
            status: 'success',
            startedAt: 11,
            endedAt: 16,
            durationMs: 5,
          },
        ],
      },
      {
        tasks: [
          {
            taskId: 'task-1',
            type: 'Planning',
            subType: 'Locate',
            status: 'finished',
            timing: {
              start: 1,
              getUiContextStart: 2,
              getUiContextEnd: 12,
              callAiStart: 12,
              callAiEnd: 42,
              end: 50,
              cost: 49,
            },
          } as any,
        ],
      },
    );

    expect(summary).toMatchObject({
      taskCount: 1,
      snapshotMs: 10,
      aiLocateMs: 30,
      screenshotMs: 10,
      inputMs: 5,
      actionSteps: 1,
      failedActionSteps: 0,
    });
  });
});
