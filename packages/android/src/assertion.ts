import type { ElementInfo, ElementNode } from '@midscene/shared/extractor';
import { treeToList } from '@midscene/shared/extractor';
import type {
  AndroidNotificationRequest,
  AndroidNotificationResult,
  AndroidNotificationSnapshot,
  AndroidPermissionQuery,
  AndroidPermissionResult,
  AndroidSettingsNamespace,
  AndroidSystemState,
  AndroidSystemStateRequest,
} from './system-state';

export type AndroidDeterministicSource =
  | 'ui-tree'
  | 'system-state'
  | 'permissions'
  | 'notifications'
  | 'logcat'
  | 'shell';

export type AndroidValueExpectation =
  | string
  | {
      equals?: string;
      contains?: string;
      matches?: string;
      exists?: boolean;
      notEquals?: string;
      notContains?: string;
    };

export interface AndroidUiNodeQuery {
  text?: AndroidValueExpectation;
  textContains?: string;
  contentDesc?: AndroidValueExpectation;
  resourceId?: AndroidValueExpectation;
  className?: AndroidValueExpectation;
  packageName?: AndroidValueExpectation;
  visibleOnly?: boolean;
  enabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  clickable?: boolean;
  minMatches?: number;
  limit?: number;
  includeBounds?: boolean;
}

export interface AndroidUiAssertionPredicate {
  anyText?: string[];
  allText?: string[];
  noneText?: string[];
  nodes?: AndroidUiNodeQuery[];
  visibleOnly?: boolean;
}

export interface AndroidForegroundAssertionPredicate {
  packageName?: AndroidValueExpectation;
  activity?: AndroidValueExpectation;
  pageFingerprint?: AndroidValueExpectation;
}

export interface AndroidSettingsAssertionPredicate {
  namespace: AndroidSettingsNamespace;
  key: string;
  value?: AndroidValueExpectation;
  exists?: boolean;
}

export interface AndroidPropertyAssertionPredicate {
  key: string;
  value?: AndroidValueExpectation;
  exists?: boolean;
}

export interface AndroidPermissionAssertionPredicate {
  packageName: string;
  permission: string;
  granted?: boolean;
}

export interface AndroidNotificationAssertionPredicate {
  packageName?: AndroidValueExpectation;
  title?: AndroidValueExpectation;
  text?: AndroidValueExpectation;
  anyText?: string[];
}

export interface AndroidLogcatAssertionPredicate {
  command?: string;
  lines?: number;
  contains?: string[];
  matches?: string[];
  excludes?: string[];
}

export interface AndroidShellAssertionPredicate {
  command: string;
  value?: AndroidValueExpectation;
  contains?: string[];
  matches?: string[];
  excludes?: string[];
}

export interface AndroidAssertionPredicate {
  ui?: AndroidUiAssertionPredicate;
  foreground?: AndroidForegroundAssertionPredicate;
  settings?: AndroidSettingsAssertionPredicate[];
  properties?: AndroidPropertyAssertionPredicate[];
  permissions?: AndroidPermissionAssertionPredicate[];
  notifications?: AndroidNotificationAssertionPredicate[];
  logcat?: AndroidLogcatAssertionPredicate;
  shell?: AndroidShellAssertionPredicate[];
}

export interface AndroidAssertionCheck {
  source: AndroidDeterministicSource;
  name: string;
  pass: boolean;
  expected?: unknown;
  actual?: unknown;
  reason?: string;
}

export interface AndroidAssertionResult {
  pass: boolean;
  source: AndroidDeterministicSource[];
  checks: AndroidAssertionCheck[];
  predicate: AndroidAssertionPredicate;
  timestamp: number;
}

export interface AndroidUiExtractionQuery extends AndroidUiNodeQuery {
  textContains?: string;
  includeAttributes?: boolean;
}

export interface AndroidUiExtractionNode {
  id?: string;
  indexId?: number;
  text?: string;
  contentDesc?: string;
  content?: string;
  resourceId?: string;
  className?: string;
  packageName?: string;
  enabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  clickable?: boolean;
  visible?: boolean;
  rect?: ElementInfo['rect'];
  center?: ElementInfo['center'];
  attributes?: ElementInfo['attributes'];
}

export interface AndroidUiExtractionResult {
  source: 'ui-tree';
  count: number;
  texts: string[];
  nodes: AndroidUiExtractionNode[];
}

export interface AndroidLogcatRequest {
  command?: string;
  lines?: number;
  filter?: string;
}

export interface AndroidShellExtractionRequest {
  command: string;
}

export interface AndroidExtractionRequest {
  source?:
    | 'uiTree'
    | 'system'
    | 'permissions'
    | 'notifications'
    | 'logcat'
    | 'shell';
  ui?: AndroidUiExtractionQuery;
  system?: AndroidSystemStateRequest;
  permissions?: AndroidPermissionQuery;
  notifications?: AndroidNotificationRequest;
  logcat?: AndroidLogcatRequest;
  shell?: AndroidShellExtractionRequest;
}

export interface AndroidExtractionResult {
  source: AndroidDeterministicSource;
  data: unknown;
  request: AndroidExtractionRequest;
  timestamp: number;
}

export interface AndroidAssertionProviders {
  getUiTree(): Promise<ElementNode>;
  getSystemState(
    request?: AndroidSystemStateRequest,
  ): Promise<AndroidSystemState>;
  getPermissions(
    query: AndroidPermissionQuery,
  ): Promise<AndroidPermissionResult>;
  getNotifications(
    request?: AndroidNotificationRequest,
  ): Promise<AndroidNotificationResult>;
  runShell(command: string): Promise<string>;
}

export async function evaluateAndroidAssertion(
  predicate: AndroidAssertionPredicate,
  providers: AndroidAssertionProviders,
): Promise<AndroidAssertionResult> {
  const checks: AndroidAssertionCheck[] = [];

  if (predicate.ui) {
    const tree = await providers.getUiTree();
    checks.push(...evaluateUiAssertion(predicate.ui, tree));
  }

  if (
    predicate.foreground ||
    predicate.settings?.length ||
    predicate.properties?.length
  ) {
    const systemRequest = buildSystemStateRequest(predicate);
    const systemState = await providers.getSystemState(systemRequest);
    checks.push(...evaluateSystemAssertion(predicate, systemState));
  }

  if (predicate.permissions?.length) {
    for (const permission of predicate.permissions) {
      const result = await providers.getPermissions({
        packageName: permission.packageName,
        permissions: [permission.permission],
      });
      const entry = result.permissions?.find(
        (item) => item.permission === permission.permission,
      );
      checks.push({
        source: 'permissions',
        name: `permission:${permission.packageName}:${permission.permission}`,
        pass:
          permission.granted === undefined ||
          entry?.granted === permission.granted,
        expected: permission.granted,
        actual: entry?.granted,
        reason: entry
          ? undefined
          : `Permission ${permission.permission} was not present in package dump`,
      });
    }
  }

  if (predicate.notifications?.length) {
    const packageName = firstNotificationPackage(predicate.notifications);
    const result = await providers.getNotifications({ packageName });
    checks.push(
      ...evaluateNotificationAssertions(predicate.notifications, result),
    );
  }

  if (predicate.logcat) {
    const raw = await providers.runShell(logcatCommand(predicate.logcat));
    checks.push(
      ...evaluateTextBlock('logcat', 'logcat', raw, predicate.logcat),
    );
  }

  if (predicate.shell?.length) {
    for (const shell of predicate.shell) {
      const raw = await providers.runShell(shell.command);
      checks.push(...evaluateShellAssertion(shell, raw));
    }
  }

  if (checks.length === 0) {
    throw new Error(
      'Android deterministic assertion requires at least one predicate',
    );
  }

  return {
    pass: checks.every((check) => check.pass),
    source: unique(checks.map((check) => check.source)),
    checks,
    predicate,
    timestamp: Date.now(),
  };
}

export async function extractAndroidDeterministic(
  request: AndroidExtractionRequest,
  providers: AndroidAssertionProviders,
): Promise<AndroidExtractionResult> {
  const source = request.source ?? 'uiTree';
  let data: unknown;
  let resultSource: AndroidDeterministicSource;

  if (source === 'uiTree') {
    data = extractAndroidUiTree(await providers.getUiTree(), request.ui);
    resultSource = 'ui-tree';
  } else if (source === 'system') {
    data = await providers.getSystemState(request.system);
    resultSource = 'system-state';
  } else if (source === 'permissions') {
    if (!request.permissions) {
      throw new Error(
        'Android permissions extraction requires permissions query',
      );
    }
    data = await providers.getPermissions(request.permissions);
    resultSource = 'permissions';
  } else if (source === 'notifications') {
    data = await providers.getNotifications(request.notifications);
    resultSource = 'notifications';
  } else if (source === 'logcat') {
    const command = logcatCommand(request.logcat ?? {});
    const raw = await providers.runShell(command);
    data = filterText(raw, request.logcat?.filter);
    resultSource = 'logcat';
  } else if (source === 'shell') {
    if (!request.shell?.command) {
      throw new Error('Android shell extraction requires a command');
    }
    data = await providers.runShell(request.shell.command);
    resultSource = 'shell';
  } else {
    throw new Error(`Unsupported Android extraction source: ${source}`);
  }

  return {
    source: resultSource,
    data,
    request,
    timestamp: Date.now(),
  };
}

export function extractAndroidUiTree(
  tree: ElementNode,
  query: AndroidUiExtractionQuery = {},
): AndroidUiExtractionResult {
  const visibleOnly = query.visibleOnly ?? true;
  const limit = query.limit ?? 50;
  const nodes = treeToList(tree).filter((node) =>
    nodeMatchesQuery(node, { ...query, visibleOnly }),
  );
  const selected = nodes.slice(0, limit);
  const texts = unique(
    selected
      .flatMap((node) => nodeTextParts(node))
      .map((text) => text.trim())
      .filter(Boolean),
  );

  return {
    source: 'ui-tree',
    count: nodes.length,
    texts,
    nodes: selected.map((node) => serializeUiNode(node, query)),
  };
}

function evaluateUiAssertion(
  predicate: AndroidUiAssertionPredicate,
  tree: ElementNode,
): AndroidAssertionCheck[] {
  const checks: AndroidAssertionCheck[] = [];
  const visibleOnly = predicate.visibleOnly ?? true;
  const nodes = treeToList(tree).filter((node) =>
    visibleOnly ? node.isVisible : true,
  );
  const textCorpus = nodes.flatMap(nodeTextParts).filter(Boolean);

  if (predicate.anyText?.length) {
    checks.push({
      source: 'ui-tree',
      name: 'ui:anyText',
      pass: predicate.anyText.some((expected) =>
        textCorpus.some((text) => textMatches(text, expected)),
      ),
      expected: predicate.anyText,
      actual: textCorpus,
    });
  }

  for (const expected of predicate.allText ?? []) {
    checks.push({
      source: 'ui-tree',
      name: `ui:allText:${expected}`,
      pass: textCorpus.some((text) => textMatches(text, expected)),
      expected,
      actual: textCorpus,
    });
  }

  for (const expected of predicate.noneText ?? []) {
    checks.push({
      source: 'ui-tree',
      name: `ui:noneText:${expected}`,
      pass: !textCorpus.some((text) => textMatches(text, expected)),
      expected,
      actual: textCorpus,
    });
  }

  for (const query of predicate.nodes ?? []) {
    const queryWithVisibility = {
      ...query,
      visibleOnly: query.visibleOnly ?? visibleOnly,
    };
    const matched = treeToList(tree).filter((node) =>
      nodeMatchesQuery(node, queryWithVisibility),
    );
    const minMatches = query.minMatches ?? 1;
    checks.push({
      source: 'ui-tree',
      name: 'ui:nodes',
      pass: matched.length >= minMatches,
      expected: query,
      actual: {
        count: matched.length,
        nodes: matched
          .slice(0, query.limit ?? 5)
          .map((node) => serializeUiNode(node, query)),
      },
      reason:
        matched.length >= minMatches
          ? undefined
          : `Expected at least ${minMatches} matching UI node(s)`,
    });
  }

  return checks;
}

function buildSystemStateRequest(
  predicate: AndroidAssertionPredicate,
): AndroidSystemStateRequest {
  const include: AndroidSystemStateRequest['include'] = [];
  if (predicate.foreground) {
    include.push('foreground');
  }
  if (predicate.settings?.length) {
    include.push('settings');
  }
  if (predicate.properties?.length) {
    include.push('properties');
  }
  return {
    include,
    settings: predicate.settings?.map(({ namespace, key }) => ({
      namespace,
      key,
    })),
    properties: predicate.properties?.map(({ key }) => key),
  };
}

function evaluateSystemAssertion(
  predicate: AndroidAssertionPredicate,
  state: AndroidSystemState,
): AndroidAssertionCheck[] {
  const checks: AndroidAssertionCheck[] = [];

  if (predicate.foreground?.packageName !== undefined) {
    checks.push(
      valueCheck(
        'system-state',
        'foreground:packageName',
        state.foreground?.packageName,
        predicate.foreground.packageName,
      ),
    );
  }
  if (predicate.foreground?.activity !== undefined) {
    checks.push(
      valueCheck(
        'system-state',
        'foreground:activity',
        state.foreground?.activity,
        predicate.foreground.activity,
      ),
    );
  }
  if (predicate.foreground?.pageFingerprint !== undefined) {
    checks.push(
      valueCheck(
        'system-state',
        'foreground:pageFingerprint',
        state.foreground?.pageFingerprint,
        predicate.foreground.pageFingerprint,
      ),
    );
  }

  for (const expected of predicate.settings ?? []) {
    const actual = state.settings?.find(
      (item) =>
        item.namespace === expected.namespace && item.key === expected.key,
    );
    checks.push(
      valueCheck(
        'system-state',
        `settings:${expected.namespace}:${expected.key}`,
        actual?.value,
        expected.value ?? { exists: expected.exists ?? true },
      ),
    );
  }

  for (const expected of predicate.properties ?? []) {
    const actual = state.properties?.find((item) => item.key === expected.key);
    checks.push(
      valueCheck(
        'system-state',
        `property:${expected.key}`,
        actual?.value,
        expected.value ?? { exists: expected.exists ?? true },
      ),
    );
  }

  return checks;
}

function evaluateNotificationAssertions(
  predicates: AndroidNotificationAssertionPredicate[],
  result: AndroidNotificationResult,
): AndroidAssertionCheck[] {
  return predicates.map((predicate) => {
    const matched = result.notifications.filter((notification) =>
      notificationMatches(notification, predicate),
    );
    return {
      source: 'notifications',
      name: 'notification',
      pass: matched.length > 0,
      expected: predicate,
      actual: matched,
      reason: matched.length ? undefined : 'No matching notification found',
    };
  });
}

function notificationMatches(
  notification: AndroidNotificationSnapshot,
  predicate: AndroidNotificationAssertionPredicate,
): boolean {
  const checks: boolean[] = [];
  if (predicate.packageName !== undefined) {
    checks.push(
      valueExpectationPass(notification.packageName, predicate.packageName),
    );
  }
  if (predicate.title !== undefined) {
    checks.push(valueExpectationPass(notification.title, predicate.title));
  }
  if (predicate.text !== undefined) {
    checks.push(valueExpectationPass(notification.text, predicate.text));
  }
  if (predicate.anyText?.length) {
    checks.push(
      predicate.anyText.some((expected) =>
        [notification.title, notification.text, notification.raw]
          .filter(Boolean)
          .some((text) => textMatches(text ?? '', expected)),
      ),
    );
  }
  return checks.length > 0 && checks.every(Boolean);
}

function evaluateTextBlock(
  source: AndroidDeterministicSource,
  name: string,
  raw: string,
  predicate: {
    contains?: string[];
    matches?: string[];
    excludes?: string[];
  },
): AndroidAssertionCheck[] {
  const checks: AndroidAssertionCheck[] = [];
  for (const expected of predicate.contains ?? []) {
    checks.push({
      source,
      name: `${name}:contains:${expected}`,
      pass: raw.includes(expected),
      expected,
      actual: raw,
    });
  }
  for (const expected of predicate.matches ?? []) {
    checks.push({
      source,
      name: `${name}:matches:${expected}`,
      pass: safeRegex(expected).test(raw),
      expected,
      actual: raw,
    });
  }
  for (const expected of predicate.excludes ?? []) {
    checks.push({
      source,
      name: `${name}:excludes:${expected}`,
      pass: !raw.includes(expected),
      expected,
      actual: raw,
    });
  }
  return checks;
}

function evaluateShellAssertion(
  predicate: AndroidShellAssertionPredicate,
  raw: string,
): AndroidAssertionCheck[] {
  const checks: AndroidAssertionCheck[] = [];
  if (predicate.value !== undefined) {
    checks.push(
      valueCheck(
        'shell',
        `shell:${predicate.command}`,
        raw.trim(),
        predicate.value,
      ),
    );
  }
  checks.push(
    ...evaluateTextBlock('shell', `shell:${predicate.command}`, raw, predicate),
  );
  return checks;
}

function valueCheck(
  source: AndroidDeterministicSource,
  name: string,
  actual: string | undefined,
  expected: AndroidValueExpectation,
): AndroidAssertionCheck {
  const pass = valueExpectationPass(actual, expected);
  return {
    source,
    name,
    pass,
    expected,
    actual,
    reason: pass ? undefined : `Expected ${name} to match predicate`,
  };
}

function valueExpectationPass(
  actual: string | undefined,
  expected: AndroidValueExpectation,
): boolean {
  if (typeof expected === 'string') {
    return actual === expected;
  }
  if (expected.exists !== undefined) {
    const exists = actual !== undefined && actual !== null && actual !== '';
    if (exists !== expected.exists) {
      return false;
    }
  }
  if (expected.equals !== undefined && actual !== expected.equals) {
    return false;
  }
  if (expected.notEquals !== undefined && actual === expected.notEquals) {
    return false;
  }
  if (
    expected.contains !== undefined &&
    !(actual ?? '').includes(expected.contains)
  ) {
    return false;
  }
  if (
    expected.notContains !== undefined &&
    (actual ?? '').includes(expected.notContains)
  ) {
    return false;
  }
  if (
    expected.matches !== undefined &&
    !safeRegex(expected.matches).test(actual ?? '')
  ) {
    return false;
  }
  return true;
}

function nodeMatchesQuery(
  node: ElementInfo,
  query: AndroidUiNodeQuery,
): boolean {
  if (query.visibleOnly !== false && !node.isVisible) {
    return false;
  }
  if (
    query.text !== undefined &&
    !valueExpectationPass(node.attributes.text, query.text)
  ) {
    return false;
  }
  if (
    typeof query.textContains === 'string' &&
    !nodeTextParts(node).some((text) => textMatches(text, query.textContains!))
  ) {
    return false;
  }
  if (
    query.contentDesc !== undefined &&
    !valueExpectationPass(node.attributes.contentDescription, query.contentDesc)
  ) {
    return false;
  }
  if (
    query.resourceId !== undefined &&
    !valueExpectationPass(node.attributes.resourceId, query.resourceId)
  ) {
    return false;
  }
  if (
    query.className !== undefined &&
    !valueExpectationPass(node.attributes.className, query.className)
  ) {
    return false;
  }
  if (
    query.packageName !== undefined &&
    !valueExpectationPass(node.attributes.packageName, query.packageName)
  ) {
    return false;
  }
  if (
    query.enabled !== undefined &&
    boolAttr(node.attributes.enabled) !== query.enabled
  ) {
    return false;
  }
  if (
    query.checked !== undefined &&
    boolAttr(node.attributes.checked) !== query.checked
  ) {
    return false;
  }
  if (
    query.selected !== undefined &&
    boolAttr(node.attributes.selected) !== query.selected
  ) {
    return false;
  }
  if (
    query.clickable !== undefined &&
    boolAttr(node.attributes.clickable) !== query.clickable
  ) {
    return false;
  }
  return true;
}

function serializeUiNode(
  node: ElementInfo,
  query: Pick<AndroidUiNodeQuery, 'includeBounds'> & {
    includeAttributes?: boolean;
  } = {},
): AndroidUiExtractionNode {
  return {
    id: node.id,
    indexId: node.indexId,
    text: emptyToUndefined(node.attributes.text),
    contentDesc: emptyToUndefined(node.attributes.contentDescription),
    content: emptyToUndefined(node.content),
    resourceId: emptyToUndefined(node.attributes.resourceId),
    className: emptyToUndefined(node.attributes.className),
    packageName: emptyToUndefined(node.attributes.packageName),
    enabled: boolAttr(node.attributes.enabled),
    checked: boolAttr(node.attributes.checked),
    selected: boolAttr(node.attributes.selected),
    clickable: boolAttr(node.attributes.clickable),
    visible: node.isVisible,
    rect: query.includeBounds ? node.rect : undefined,
    center: query.includeBounds ? node.center : undefined,
    attributes: query.includeAttributes ? node.attributes : undefined,
  };
}

function nodeTextParts(node: ElementInfo): string[] {
  const atomicParts = [
    node.attributes.text,
    node.attributes.contentDescription,
  ].filter((item): item is string => Boolean(item?.trim()));
  const content = node.content?.trim();
  if (
    content &&
    (!atomicParts.length ||
      !atomicParts.every((item) => content.includes(item)))
  ) {
    return unique([content, ...atomicParts]);
  }
  return unique(atomicParts);
}

function textMatches(actual: string, expected: string): boolean {
  return normalizeText(actual).includes(normalizeText(expected));
}

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function boolAttr(value: unknown): boolean | undefined {
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  return undefined;
}

function firstNotificationPackage(
  predicates: AndroidNotificationAssertionPredicate[],
): string | undefined {
  const packageNames = predicates
    .map((predicate) =>
      typeof predicate.packageName === 'string'
        ? predicate.packageName
        : predicate.packageName?.equals,
    )
    .filter((value): value is string => Boolean(value));
  return unique(packageNames).length === 1 ? packageNames[0] : undefined;
}

function logcatCommand(
  request: AndroidLogcatRequest | AndroidLogcatAssertionPredicate,
): string {
  if (request.command?.trim()) {
    return request.command;
  }
  const lines = Math.max(1, Math.min(request.lines ?? 200, 5000));
  return `logcat -d -t ${lines}`;
}

function filterText(raw: string, filter?: string): string {
  if (!filter) {
    return raw;
  }
  return raw
    .split(/\r?\n/)
    .filter((line) => line.includes(filter))
    .join('\n');
}

function safeRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'i');
  } catch (error) {
    throw new Error(`Invalid Android assertion regex: ${pattern}`, {
      cause: error,
    });
  }
}

function unique<T>(items: T[]): T[] {
  return items.filter((item, index, values) => values.indexOf(item) === index);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}
