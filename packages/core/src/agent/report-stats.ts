import type { ExecutionTask, IExecutionDump } from '@/types';

export interface ExecutionReportStats {
  totalTasks: number;
  locateTasks: number;
  cacheHit: number;
  structuredHit: number;
  aiFallback: number;
  planHit: number;
  xpathHit: number;
  recovery: number;
  failedTasks: number;
}

const emptyStats = (): ExecutionReportStats => ({
  totalTasks: 0,
  locateTasks: 0,
  cacheHit: 0,
  structuredHit: 0,
  aiFallback: 0,
  planHit: 0,
  xpathHit: 0,
  recovery: 0,
  failedTasks: 0,
});

export function collectExecutionReportStats(
  executions: Array<IExecutionDump | undefined | null>,
): ExecutionReportStats {
  const stats = emptyStats();

  for (const execution of executions) {
    if (!execution?.tasks?.length) {
      continue;
    }

    let failedBeforeSuccess = 0;
    for (const task of execution.tasks) {
      stats.totalTasks++;
      if (task.type === 'Planning' && task.subType === 'Locate') {
        stats.locateTasks++;
      }
      if (task.status === 'failed') {
        stats.failedTasks++;
        failedBeforeSuccess++;
      } else if (failedBeforeSuccess > 0 && task.status === 'finished') {
        stats.recovery += failedBeforeSuccess;
        failedBeforeSuccess = 0;
      }

      collectHitSource(stats, task);
    }
  }

  return stats;
}

function collectHitSource(
  stats: ExecutionReportStats,
  task: ExecutionTask,
): void {
  const source = task.hitBy?.from;
  if (source === 'Cache') {
    stats.cacheHit++;
    return;
  }
  if (source === 'Structure') {
    stats.structuredHit++;
    return;
  }
  if (source === 'AI') {
    stats.aiFallback++;
    return;
  }
  if (source === 'Plan') {
    stats.planHit++;
    return;
  }
  if (source === 'User expected path') {
    stats.xpathHit++;
    return;
  }

  if (
    task.type === 'Planning' &&
    task.subType === 'Locate' &&
    task.status === 'finished' &&
    task.timing?.callAiStart !== undefined
  ) {
    stats.aiFallback++;
  }
}
