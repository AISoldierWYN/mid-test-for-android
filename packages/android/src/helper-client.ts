import type { Rect, Size } from '@midscene/core';
import type { ElementNode } from '@midscene/shared/extractor';

export const DEFAULT_ANDROID_HELPER_ENDPOINT = 'http://127.0.0.1:17310';
export const DEFAULT_ANDROID_HELPER_TIMEOUT_MS = 1000;
export const DEFAULT_ANDROID_HELPER_LOCAL_PORT = 17310;
export const DEFAULT_ANDROID_HELPER_LOCAL_ABSTRACT = 'midscene_helper';

type FetchResponseLike = {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
};

type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

export interface AndroidHelperClientOptions {
  endpoint?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetch?: FetchLike;
}

export interface AndroidHelperEnvelope<T> {
  ok: boolean;
  data?: T;
  result?: T;
  error?: string | { message?: string; code?: string };
}

export type AndroidHelperSnapshotPart =
  | 'screenshot'
  | 'uiTree'
  | 'foreground'
  | 'window'
  | 'keyboard'
  | 'overlays'
  | 'crash'
  | 'anr'
  | 'guard';

export interface AndroidHelperSnapshotRequest {
  include?: AndroidHelperSnapshotPart[];
}

export interface AndroidHelperIssueState {
  detected: boolean;
  packageName?: string;
  processName?: string;
  message?: string;
  stack?: string;
  raw?: string;
  timestamp?: number;
}

export interface AndroidHelperForegroundState {
  packageName?: string;
  activity?: string;
  pageFingerprint?: string;
  raw?: string;
}

export interface AndroidHelperScreenshot {
  base64?: string;
  dataUrl?: string;
  format?: 'png' | 'jpeg' | 'webp';
  width?: number;
  height?: number;
}

export interface AndroidHelperOverlayState {
  packageName?: string;
  title?: string;
  type?: string;
  bounds?: Rect;
  raw?: string;
}

export interface AndroidHelperGuardState {
  permissionDialog?: boolean;
  systemDialog?: boolean;
  crash?: AndroidHelperIssueState;
  anr?: AndroidHelperIssueState;
  overlays?: AndroidHelperOverlayState[];
  raw?: string;
}

export interface AndroidHelperSnapshot {
  timestamp?: number;
  screenshot?: AndroidHelperScreenshot;
  screenshotBase64?: string;
  screenshotFormat?: 'png' | 'jpeg' | 'webp';
  uiXml?: string;
  uiTree?: ElementNode;
  screen?: {
    logicalSize?: Size;
    physicalSize?: Size;
    orientation?: number;
    displayId?: number;
  };
  foreground?: AndroidHelperForegroundState;
  window?: Record<string, unknown>;
  keyboard?: {
    shown?: boolean;
    inputMethod?: string;
    raw?: string;
  };
  overlays?: AndroidHelperOverlayState[];
  crash?: AndroidHelperIssueState;
  anr?: AndroidHelperIssueState;
  guard?: AndroidHelperGuardState;
  raw?: unknown;
}

export type AndroidHelperCoordinateSpace = 'logical' | 'physical';

export type AndroidHelperInputAction =
  | {
      type: 'tap';
      x: number;
      y: number;
      durationMs?: number;
      displayId?: number;
      coordinateSpace?: AndroidHelperCoordinateSpace;
    }
  | {
      type: 'swipe';
      from: { x: number; y: number };
      to: { x: number; y: number };
      durationMs?: number;
      displayId?: number;
      coordinateSpace?: AndroidHelperCoordinateSpace;
    }
  | {
      type: 'text';
      text: string;
      replace?: boolean;
      autoDismissKeyboard?: boolean;
    }
  | {
      type: 'key';
      key?: string;
      keyCode?: number;
    }
  | {
      type: 'clearText';
    };

export interface AndroidHelperInputRequest {
  actions: AndroidHelperInputAction[];
}

export interface AndroidHelperInputResult {
  handled: boolean;
  raw?: unknown;
}

export type AndroidHelperAppCommand =
  | { action: 'launch'; uri: string }
  | { action: 'terminate'; uri: string }
  | { action: 'clearData'; packageName: string }
  | { action: 'grantPermission'; packageName: string; permissions: string[] };

export interface AndroidHelperAppResult {
  handled: boolean;
  raw?: unknown;
}

export interface AndroidHelperLogRequest {
  sinceMs?: number;
  lines?: number;
  tags?: string[];
}

export interface AndroidHelperLogResult {
  entries: Array<{
    timestamp?: number;
    level?: string;
    tag?: string;
    message: string;
  }>;
}

export interface AndroidHelperEventRequest {
  sinceMs?: number;
  limit?: number;
}

export interface AndroidHelperEventResult {
  events: Array<{
    timestamp?: number;
    type: string;
    payload?: unknown;
  }>;
}

export class AndroidHelperClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly headers?: Record<string, string>;
  private readonly fetchImpl: FetchLike;

  constructor(options?: AndroidHelperClientOptions) {
    this.endpoint = normalizeEndpoint(
      options?.endpoint ?? DEFAULT_ANDROID_HELPER_ENDPOINT,
    );
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_ANDROID_HELPER_TIMEOUT_MS;
    this.headers = options?.headers;
    this.fetchImpl = options?.fetch ?? defaultFetch;
  }

  async ping(): Promise<{ ok: true; version?: string }> {
    return await this.request('/ping', { method: 'GET' });
  }

  async snapshot(
    request: AndroidHelperSnapshotRequest = {},
  ): Promise<AndroidHelperSnapshot> {
    return await this.request('/snapshot', {
      method: 'POST',
      body: request,
    });
  }

  async input(
    actions: AndroidHelperInputAction[] | AndroidHelperInputAction,
  ): Promise<AndroidHelperInputResult> {
    const normalizedActions = Array.isArray(actions) ? actions : [actions];
    return await this.request('/input', {
      method: 'POST',
      body: { actions: normalizedActions },
    });
  }

  async app(command: AndroidHelperAppCommand): Promise<AndroidHelperAppResult> {
    return await this.request('/app', {
      method: 'POST',
      body: command,
    });
  }

  async guard(): Promise<AndroidHelperGuardState> {
    return await this.request('/guard', { method: 'GET' });
  }

  async logs(
    request: AndroidHelperLogRequest = {},
  ): Promise<AndroidHelperLogResult> {
    return await this.request('/logs', { method: 'POST', body: request });
  }

  async events(
    request: AndroidHelperEventRequest = {},
  ): Promise<AndroidHelperEventResult> {
    return await this.request('/events', { method: 'POST', body: request });
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const method = init.method ?? 'GET';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.endpoint}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(init.body === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
          ...this.headers,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `Android helper ${method} ${path} failed: ${response.status} ${response.statusText || ''}${text ? ` - ${truncate(text)}` : ''}`.trim(),
        );
      }

      const parsed = text ? parseJson(text, path) : {};
      return unwrapEnvelope<T>(parsed);
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new Error(
          `Android helper ${method} ${path} timed out after ${this.timeoutMs}ms`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Android helper ${path} returned invalid JSON`, {
      cause: error,
    });
  }
}

function unwrapEnvelope<T>(value: unknown): T {
  if (value && typeof value === 'object' && 'ok' in value) {
    const envelope = value as AndroidHelperEnvelope<T>;
    if (!envelope.ok) {
      const error = envelope.error;
      const message =
        typeof error === 'string' ? error : error?.message || 'unknown error';
      throw new Error(`Android helper returned error: ${message}`);
    }
    return (envelope.data ?? envelope.result ?? {}) as T;
  }

  return value as T;
}

function truncate(value: string, maxLength = 500): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

async function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<FetchResponseLike> {
  if (!globalThis.fetch) {
    throw new Error('Android helper HTTP transport requires global fetch');
  }
  return await globalThis.fetch(url, init);
}
