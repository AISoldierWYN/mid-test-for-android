import { createHash } from 'node:crypto';
import type { ExecutionTask, IExecutionDump } from '@midscene/core';

export type AndroidTimingCategory =
  | 'snapshot'
  | 'screenshot'
  | 'uiTree'
  | 'aiLocate'
  | 'input'
  | 'wait'
  | 'replan'
  | 'action'
  | 'adbShell'
  | 'app'
  | 'state';

export interface AndroidForegroundState {
  packageName?: string;
  activity?: string;
  pageFingerprint?: string;
  raw?: string;
}

export interface AndroidDiagnosticsOptions {
  enabled?: boolean;
  collectForegroundState?: boolean;
  maxEvents?: number;
}

export interface AndroidTimingEvent {
  id: string;
  category: AndroidTimingCategory;
  name: string;
  status: 'running' | 'success' | 'failed';
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
  errorMessage?: string;
}

export interface AndroidActionStep {
  id: string;
  actionName: string;
  status: 'running' | 'success' | 'failed';
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  beforeState?: AndroidForegroundState;
  afterState?: AndroidForegroundState;
  paramSummary?: string;
  resultSummary?: string;
  errorMessage?: string;
}

export interface AndroidDiagnosticsSnapshot {
  enabled: boolean;
  startedAt: number;
  timings: AndroidTimingEvent[];
  steps: AndroidActionStep[];
}

export interface AndroidExecutionTimingSummary {
  taskCount: number;
  totalTaskMs: number;
  snapshotMs: number;
  aiLocateMs: number;
  actionMs: number;
  waitMs: number;
  captureAfterActionMs: number;
  byTask: Array<{
    taskId: string;
    type: string;
    subType?: string;
    status: string;
    costMs: number;
    snapshotMs: number;
    aiMs: number;
    actionMs: number;
    waitMs: number;
  }>;
}

export interface AndroidDiagnosticsSummary
  extends AndroidExecutionTimingSummary {
  screenshotMs: number;
  uiTreeMs: number;
  inputMs: number;
  adbShellMs: number;
  appMs: number;
  stateMs: number;
  actionSteps: number;
  failedActionSteps: number;
}

const DEFAULT_MAX_EVENTS = 500;
const FINGERPRINT_LENGTH = 16;

export function normalizeDiagnosticsOptions(
  options?: boolean | AndroidDiagnosticsOptions,
): Required<AndroidDiagnosticsOptions> {
  if (options === true) {
    return {
      enabled: true,
      collectForegroundState: true,
      maxEvents: DEFAULT_MAX_EVENTS,
    };
  }

  if (!options) {
    return {
      enabled: false,
      collectForegroundState: true,
      maxEvents: DEFAULT_MAX_EVENTS,
    };
  }

  return {
    enabled: options.enabled ?? true,
    collectForegroundState: options.collectForegroundState ?? true,
    maxEvents: options.maxEvents ?? DEFAULT_MAX_EVENTS,
  };
}

export function createPageFingerprint(input: {
  packageName?: string;
  activity?: string;
  width?: number;
  height?: number;
}): string {
  const source = [
    input.packageName || '',
    input.activity || '',
    input.width ?? '',
    input.height ?? '',
  ].join('|');
  return createHash('sha1').update(source).digest('hex').slice(0, 16);
}

export function parseForegroundState(
  raw: string,
  screenSize?: { width?: number; height?: number },
): AndroidForegroundState {
  const compactRaw = raw.trim().replace(/\s+/g, ' ');
  const candidates = [
    /mCurrentFocus=.*?\s([a-zA-Z0-9_.]+)\/([^\s}]+)/,
    /mFocusedApp=.*?\s([a-zA-Z0-9_.]+)\/([^\s}]+)/,
    /mResumedActivity:.*?\s([a-zA-Z0-9_.]+)\/([^\s}]+)/,
    /topResumedActivity=.*?\s([a-zA-Z0-9_.]+)\/([^\s}]+)/,
  ];

  for (const pattern of candidates) {
    const match = compactRaw.match(pattern);
    if (!match) {
      continue;
    }

    const packageName = match[1];
    const activity = match[2];
    return {
      packageName,
      activity,
      pageFingerprint: createPageFingerprint({
        packageName,
        activity,
        width: screenSize?.width,
        height: screenSize?.height,
      }),
      raw: compactRaw,
    };
  }

  return {
    pageFingerprint: createHash('sha1')
      .update(compactRaw)
      .digest('hex')
      .slice(0, FINGERPRINT_LENGTH),
    raw: compactRaw,
  };
}

export function summarizeValue(value: unknown, maxLength = 300): string {
  if (value === undefined) {
    return 'undefined';
  }

  try {
    const serialized =
      typeof value === 'string' ? value : JSON.stringify(value, safeReplacer);
    if (!serialized) {
      return String(value);
    }
    return serialized.length > maxLength
      ? `${serialized.slice(0, maxLength)}...`
      : serialized;
  } catch {
    return String(value);
  }
}

export class AndroidDiagnosticsRecorder {
  readonly enabled: boolean;
  readonly collectForegroundState: boolean;

  private readonly maxEvents: number;
  private readonly startedAt = Date.now();
  private readonly timings: AndroidTimingEvent[] = [];
  private readonly steps: AndroidActionStep[] = [];
  private nextId = 1;

  constructor(options?: boolean | AndroidDiagnosticsOptions) {
    const normalized = normalizeDiagnosticsOptions(options);
    this.enabled = normalized.enabled;
    this.collectForegroundState = normalized.collectForegroundState;
    this.maxEvents = Math.max(1, normalized.maxEvents);
  }

  reset(): void {
    this.timings.length = 0;
    this.steps.length = 0;
    this.nextId = 1;
  }

  snapshot(): AndroidDiagnosticsSnapshot {
    return {
      enabled: this.enabled,
      startedAt: this.startedAt,
      timings: this.timings.map((event) => ({ ...event })),
      steps: this.steps.map((step) => ({ ...step })),
    };
  }

  async time<T>(
    category: AndroidTimingCategory,
    name: string,
    metadata: Record<string, unknown> | undefined,
    callback: () => Promise<T> | T,
  ): Promise<T> {
    if (!this.enabled) {
      return await callback();
    }

    const event = this.startTiming(category, name, metadata);
    try {
      const result = await callback();
      this.finishTiming(event.id, 'success');
      return result;
    } catch (error) {
      this.finishTiming(event.id, 'failed', error);
      throw error;
    }
  }

  startAction(
    actionName: string,
    param: unknown,
    beforeState?: AndroidForegroundState,
  ): AndroidActionStep | undefined {
    if (!this.enabled) {
      return undefined;
    }

    const step: AndroidActionStep = {
      id: this.createId('action'),
      actionName,
      status: 'running',
      startedAt: Date.now(),
      beforeState,
      paramSummary: summarizeValue(param),
    };
    this.steps.push(step);
    this.trim(this.steps);
    return step;
  }

  finishAction(
    id: string | undefined,
    status: 'success' | 'failed',
    details?: {
      afterState?: AndroidForegroundState;
      result?: unknown;
      error?: unknown;
    },
  ): void {
    if (!id || !this.enabled) {
      return;
    }

    const step = this.steps.find((item) => item.id === id);
    if (!step) {
      return;
    }

    step.status = status;
    step.endedAt = Date.now();
    step.durationMs = step.endedAt - step.startedAt;
    step.afterState = details?.afterState;
    if ('result' in (details || {})) {
      step.resultSummary = summarizeValue(details?.result);
    }
    if (details?.error) {
      step.errorMessage = errorMessage(details.error);
    }
  }

  private startTiming(
    category: AndroidTimingCategory,
    name: string,
    metadata?: Record<string, unknown>,
  ): AndroidTimingEvent {
    const event: AndroidTimingEvent = {
      id: this.createId(category),
      category,
      name,
      status: 'running',
      startedAt: Date.now(),
      metadata,
    };
    this.timings.push(event);
    this.trim(this.timings);
    return event;
  }

  private finishTiming(
    id: string,
    status: 'success' | 'failed',
    error?: unknown,
  ): void {
    const event = this.timings.find((item) => item.id === id);
    if (!event) {
      return;
    }
    event.status = status;
    event.endedAt = Date.now();
    event.durationMs = event.endedAt - event.startedAt;
    if (error) {
      event.errorMessage = errorMessage(error);
    }
  }

  private createId(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }

  private trim<T>(items: T[]): void {
    if (items.length <= this.maxEvents) {
      return;
    }
    items.splice(0, items.length - this.maxEvents);
  }
}

export function summarizeAndroidExecutionTimings(
  execution?: Pick<IExecutionDump, 'tasks'> | null,
): AndroidExecutionTimingSummary {
  const tasks = execution?.tasks || [];
  const byTask = tasks.map((task) => summarizeTaskTiming(task));

  return {
    taskCount: tasks.length,
    totalTaskMs: sum(byTask, 'costMs'),
    snapshotMs: sum(byTask, 'snapshotMs'),
    aiLocateMs: sum(byTask, 'aiMs'),
    actionMs: sum(byTask, 'actionMs'),
    waitMs: sum(byTask, 'waitMs'),
    captureAfterActionMs: tasks.reduce((total, task) => {
      const timing = task.timing;
      if (
        !timing?.captureAfterCallingSnapshotStart ||
        !timing.captureAfterCallingSnapshotEnd
      ) {
        return total;
      }
      return (
        total +
        (timing.captureAfterCallingSnapshotEnd -
          timing.captureAfterCallingSnapshotStart)
      );
    }, 0),
    byTask,
  };
}

export function summarizeAndroidDiagnostics(
  diagnostics?: AndroidDiagnosticsSnapshot | null,
  execution?: Pick<IExecutionDump, 'tasks'> | null,
): AndroidDiagnosticsSummary {
  const executionSummary = summarizeAndroidExecutionTimings(execution);
  const timings = diagnostics?.timings || [];
  const steps = diagnostics?.steps || [];

  return {
    ...executionSummary,
    screenshotMs: sumTimings(timings, 'screenshot'),
    uiTreeMs: sumTimings(timings, 'uiTree'),
    inputMs: sumTimings(timings, 'input'),
    adbShellMs: sumTimings(timings, 'adbShell'),
    appMs: sumTimings(timings, 'app'),
    stateMs: sumTimings(timings, 'state'),
    actionSteps: steps.length,
    failedActionSteps: steps.filter((step) => step.status === 'failed').length,
  };
}

function summarizeTaskTiming(task: ExecutionTask) {
  const timing = task.timing;
  const snapshotMs =
    diff(timing?.getUiContextStart, timing?.getUiContextEnd) || 0;
  const aiMs = diff(timing?.callAiStart, timing?.callAiEnd) || 0;
  const actionMs = diff(timing?.callActionStart, timing?.callActionEnd) || 0;
  const waitMs =
    diff(timing?.callActionEnd, timing?.afterInvokeActionHookEnd) || 0;

  return {
    taskId: task.taskId,
    type: task.type,
    subType: task.subType,
    status: task.status,
    costMs: timing?.cost || 0,
    snapshotMs,
    aiMs,
    actionMs,
    waitMs,
  };
}

function diff(start?: number, end?: number): number | undefined {
  if (typeof start !== 'number' || typeof end !== 'number') {
    return undefined;
  }
  return Math.max(0, end - start);
}

function sum<T extends Record<string, unknown>>(
  items: T[],
  key: keyof T,
): number {
  return items.reduce((total, item) => {
    const value = item[key];
    return total + (typeof value === 'number' ? value : 0);
  }, 0);
}

function sumTimings(
  timings: AndroidTimingEvent[],
  category: AndroidTimingCategory,
): number {
  return timings.reduce((total, event) => {
    if (event.category !== category) {
      return total;
    }
    return total + (event.durationMs || 0);
  }, 0);
}

function safeReplacer(_key: string, value: unknown) {
  if (typeof value === 'function') {
    const fn = value as { name?: string };
    return `[Function ${fn.name || 'anonymous'}]`;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
