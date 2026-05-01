import { collectExecutionReportStats } from '@/agent';
import type { ExecutionTask, IExecutionDump } from '@/types';
import { describe, expect, it } from 'vitest';

const task = (
  partial: Partial<ExecutionTask> & Pick<ExecutionTask, 'type'>,
): ExecutionTask =>
  ({
    taskId: Math.random().toString(36),
    status: 'finished',
    executor: async () => {},
    ...partial,
  }) as ExecutionTask;

describe('collectExecutionReportStats', () => {
  it('counts cache, structured, AI fallback, and recovery sources', () => {
    const execution: IExecutionDump = {
      logTime: Date.now(),
      name: 'stats',
      tasks: [
        task({
          type: 'Planning',
          subType: 'Locate',
          hitBy: { from: 'Cache', context: {} },
        }),
        task({
          type: 'Planning',
          subType: 'Locate',
          hitBy: { from: 'Structure', context: {} },
        }),
        task({
          type: 'Planning',
          subType: 'Locate',
          hitBy: { from: 'AI', context: { fallback: true } },
        }),
        task({
          type: 'Planning',
          subType: 'Locate',
          timing: { start: 1, callAiStart: 1 },
        }),
        task({
          type: 'Action Space',
          subType: 'Tap',
          status: 'failed',
        }),
        task({
          type: 'Planning',
          subType: 'Plan',
          status: 'finished',
        }),
      ],
    };

    expect(collectExecutionReportStats([execution])).toMatchObject({
      totalTasks: 6,
      locateTasks: 4,
      cacheHit: 1,
      structuredHit: 1,
      aiFallback: 2,
      recovery: 1,
      failedTasks: 1,
    });
  });
});
