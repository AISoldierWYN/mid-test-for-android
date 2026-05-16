import type { AndroidForegroundState } from './diagnostics';
import { parseForegroundState } from './diagnostics';

export type AndroidSystemStateSource = 'helper' | 'adb' | 'mixed';

export type AndroidSystemStatePart =
  | 'foreground'
  | 'settings'
  | 'properties'
  | 'windows'
  | 'notifications';

export type AndroidSettingsNamespace = 'system' | 'secure' | 'global';

export interface AndroidSettingsQuery {
  namespace: AndroidSettingsNamespace;
  key: string;
}

export interface AndroidSystemStateRequest {
  include?: AndroidSystemStatePart[];
  settings?: AndroidSettingsQuery[];
  properties?: string[];
  notificationPackage?: string;
  notificationLimit?: number;
}

export interface AndroidSettingsValue extends AndroidSettingsQuery {
  value?: string;
  raw?: string;
  source?: AndroidSystemStateSource;
}

export interface AndroidPropertyValue {
  key: string;
  value?: string;
  raw?: string;
  source?: AndroidSystemStateSource;
}

export interface AndroidWindowSnapshot {
  currentFocus?: string;
  focusedApp?: string;
  raw?: string;
  source?: AndroidSystemStateSource;
}

export interface AndroidNotificationSnapshot {
  key?: string;
  id?: string;
  packageName?: string;
  title?: string;
  text?: string;
  postTime?: string;
  raw?: string;
  source?: AndroidSystemStateSource;
}

export interface AndroidSystemState {
  timestamp?: number;
  source?: AndroidSystemStateSource;
  foreground?: AndroidForegroundState;
  settings?: AndroidSettingsValue[];
  properties?: AndroidPropertyValue[];
  window?: AndroidWindowSnapshot;
  notifications?: AndroidNotificationSnapshot[];
  raw?: unknown;
}

export type AndroidPermissionMode = 'grant' | 'revoke';

export interface AndroidPermissionQuery {
  packageName: string;
  permissions?: string[];
  appOps?: string[];
}

export interface AndroidPermissionMutation {
  packageName: string;
  permission: string;
  mode: AndroidPermissionMode;
  appOp?: string;
  appOpMode?: string;
}

export type AndroidPermissionRequest =
  | ({ action?: 'get' } & AndroidPermissionQuery)
  | ({ action: AndroidPermissionMode } & AndroidPermissionMutation);

export interface AndroidPermissionEntry {
  permission: string;
  granted?: boolean;
  raw?: string;
  source?: AndroidSystemStateSource;
}

export interface AndroidAppOpEntry {
  op: string;
  mode?: string;
  raw?: string;
  source?: AndroidSystemStateSource;
}

export interface AndroidPermissionResult {
  handled?: boolean;
  packageName: string;
  permissions?: AndroidPermissionEntry[];
  appOps?: AndroidAppOpEntry[];
  raw?: unknown;
  source?: AndroidSystemStateSource;
}

export interface AndroidNotificationRequest {
  packageName?: string;
  limit?: number;
  includeActions?: boolean;
}

export interface AndroidNotificationResult {
  handled?: boolean;
  notifications: AndroidNotificationSnapshot[];
  raw?: unknown;
  source?: AndroidSystemStateSource;
}

type AdbShell = (command: string) => Promise<string>;

const DEFAULT_SYSTEM_INCLUDE: AndroidSystemStatePart[] = [
  'foreground',
  'windows',
];

export function normalizeAndroidSystemStateRequest(
  request: AndroidSystemStateRequest = {},
): Required<Pick<AndroidSystemStateRequest, 'include'>> &
  AndroidSystemStateRequest {
  const include = request.include?.length
    ? [...new Set(request.include)]
    : DEFAULT_SYSTEM_INCLUDE;
  return { ...request, include };
}

export async function collectAndroidSystemStateWithAdb(
  shell: AdbShell,
  request: AndroidSystemStateRequest = {},
): Promise<AndroidSystemState> {
  const normalized = normalizeAndroidSystemStateRequest(request);
  const state: AndroidSystemState = {
    timestamp: Date.now(),
    source: 'adb',
  };

  let windowRaw: string | undefined;
  if (
    normalized.include.includes('foreground') ||
    normalized.include.includes('windows')
  ) {
    windowRaw = await shell('dumpsys window windows');
  }

  if (normalized.include.includes('foreground') && windowRaw) {
    state.foreground = parseForegroundState(windowRaw);
  }

  if (normalized.include.includes('windows') && windowRaw) {
    state.window = parseAndroidWindowSnapshot(windowRaw);
  }

  if (normalized.include.includes('settings') && normalized.settings?.length) {
    state.settings = await Promise.all(
      normalized.settings.map(async (query) => ({
        ...query,
        value: cleanShellValue(
          await shell(
            `settings get ${query.namespace} ${shellQuote(query.key)}`,
          ),
        ),
        source: 'adb' as const,
      })),
    );
  }

  if (
    normalized.include.includes('properties') &&
    normalized.properties?.length
  ) {
    state.properties = await Promise.all(
      normalized.properties.map(async (key) => ({
        key,
        value: cleanShellValue(await shell(`getprop ${shellQuote(key)}`)),
        source: 'adb' as const,
      })),
    );
  }

  if (normalized.include.includes('notifications')) {
    const notificationRaw = await readNotificationDump(shell);
    state.notifications = parseAndroidNotifications(notificationRaw, {
      packageName: normalized.notificationPackage,
      limit: normalized.notificationLimit,
    });
  }

  return state;
}

export async function queryAndroidPermissionsWithAdb(
  shell: AdbShell,
  query: AndroidPermissionQuery,
): Promise<AndroidPermissionResult> {
  assertPackageName(query.packageName);
  const raw = await shell(`dumpsys package ${shellQuote(query.packageName)}`);
  return {
    handled: true,
    packageName: query.packageName,
    permissions: parseAndroidPermissions(raw, query.permissions),
    appOps: query.appOps?.map((op) => ({ op, source: 'adb' })),
    raw,
    source: 'adb',
  };
}

export async function mutateAndroidPermissionWithAdb(
  shell: AdbShell,
  mutation: AndroidPermissionMutation,
): Promise<AndroidPermissionResult> {
  assertPackageName(mutation.packageName);
  if (!mutation.permission?.trim()) {
    throw new Error('Android permission mutation requires a permission');
  }

  const command =
    mutation.mode === 'grant'
      ? `pm grant ${shellQuote(mutation.packageName)} ${shellQuote(
          mutation.permission,
        )}`
      : `pm revoke ${shellQuote(mutation.packageName)} ${shellQuote(
          mutation.permission,
        )}`;
  const raw: string[] = [await shell(command)];

  if (mutation.appOp) {
    const appOpMode =
      mutation.appOpMode ?? (mutation.mode === 'grant' ? 'allow' : 'ignore');
    raw.push(
      await shell(
        `appops set ${shellQuote(mutation.packageName)} ${shellQuote(
          mutation.appOp,
        )} ${shellQuote(appOpMode)}`,
      ),
    );
  }

  return {
    handled: true,
    packageName: mutation.packageName,
    permissions: [
      {
        permission: mutation.permission,
        granted: mutation.mode === 'grant',
        source: 'adb',
      },
    ],
    appOps: mutation.appOp
      ? [
          {
            op: mutation.appOp,
            mode:
              mutation.appOpMode ??
              (mutation.mode === 'grant' ? 'allow' : 'ignore'),
            source: 'adb',
          },
        ]
      : undefined,
    raw: raw.join('\n').trim(),
    source: 'adb',
  };
}

export async function queryAndroidNotificationsWithAdb(
  shell: AdbShell,
  request: AndroidNotificationRequest = {},
): Promise<AndroidNotificationResult> {
  const raw = await readNotificationDump(shell);
  return {
    handled: true,
    notifications: parseAndroidNotifications(raw, {
      packageName: request.packageName,
      limit: request.limit,
    }),
    raw,
    source: 'adb',
  };
}

export function parseAndroidWindowSnapshot(raw: string): AndroidWindowSnapshot {
  const compactRaw = raw.trim().replace(/\s+/g, ' ');
  return {
    currentFocus: firstMatch(compactRaw, /mCurrentFocus=([^ ]+)/),
    focusedApp: firstMatch(compactRaw, /mFocusedApp=([^ ]+)/),
    raw: compactRaw,
    source: 'adb',
  };
}

export function parseAndroidPermissions(
  raw: string,
  requested?: string[],
): AndroidPermissionEntry[] {
  const entries: AndroidPermissionEntry[] = [];
  const permissions =
    requested?.length && requested.length > 0
      ? requested
      : [...raw.matchAll(/([a-zA-Z0-9_.]+\.permission\.[A-Z0-9_]+)[^\n]*/g)]
          .map((match) => match[1])
          .filter((value, index, values) => values.indexOf(value) === index);

  for (const permission of permissions) {
    const line = raw
      .split(/\r?\n/)
      .find((item) => item.includes(permission) && item.includes('granted='));
    const granted = line?.match(/granted=(true|false)/)?.[1];
    entries.push({
      permission,
      granted: granted === undefined ? undefined : granted === 'true',
      raw: line?.trim(),
      source: 'adb',
    });
  }
  return entries;
}

export function parseAndroidNotifications(
  raw: string,
  options: { packageName?: string; limit?: number } = {},
): AndroidNotificationSnapshot[] {
  const records = raw
    .split(/\r?\n/)
    .filter((line) =>
      /NotificationRecord|pkg=|key=|android\.title|android\.text|postTime/.test(
        line,
      ),
    );
  const notifications: AndroidNotificationSnapshot[] = [];

  let current: AndroidNotificationSnapshot | null = null;
  for (const line of records) {
    const trimmed = line.trim();
    const packageName = firstMatch(trimmed, /\bpkg=([^\s]+)/);
    const key = firstMatch(trimmed, /\bkey=([^\s]+)/);
    const id = firstMatch(trimmed, /\bid=([^\s]+)/);
    if (/NotificationRecord/.test(trimmed) || packageName || key) {
      if (current) {
        notifications.push(current);
      }
      current = {
        key,
        id,
        packageName,
        raw: trimmed,
        source: 'adb',
      };
      continue;
    }

    if (!current) {
      continue;
    }
    current.raw = `${current.raw ?? ''}\n${trimmed}`.trim();
    current.title ??= firstMatch(trimmed, /android\.title=([^,}]+)/);
    current.text ??= firstMatch(trimmed, /android\.text=([^,}]+)/);
    current.postTime ??= firstMatch(trimmed, /\bpostTime=([^ ]+)/);
  }

  if (current) {
    notifications.push(current);
  }

  const filtered = options.packageName
    ? notifications.filter((item) => item.packageName === options.packageName)
    : notifications;
  return filtered.slice(0, options.limit ?? filtered.length);
}

async function readNotificationDump(shell: AdbShell): Promise<string> {
  try {
    return await shell('dumpsys notification --noredact');
  } catch {
    return await shell('dumpsys notification');
  }
}

function assertPackageName(packageName: string): void {
  if (!packageName?.trim()) {
    throw new Error('Android package name is required');
  }
}

function cleanShellValue(value: string): string | undefined {
  const cleaned = value.trim();
  if (!cleaned || cleaned === 'null') {
    return undefined;
  }
  return cleaned;
}

function firstMatch(value: string, pattern: RegExp): string | undefined {
  return value.match(pattern)?.[1];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
