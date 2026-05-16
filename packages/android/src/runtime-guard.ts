import type {
  Rect,
  RuntimeRecoveryIssue,
  RuntimeRecoveryIssueKind,
  RuntimeRecoveryState,
} from '@midscene/core';
import type { ElementInfo, ElementNode } from '@midscene/shared/extractor';
import { treeToList } from '@midscene/shared/extractor';

export type AndroidRuntimeGuardStatus =
  | 'skipped'
  | 'clean'
  | 'recovered'
  | 'unresolved'
  | 'blocked';

export type AndroidRecoveryAction =
  | {
      type: 'tap';
      x: number;
      y: number;
      description?: string;
    }
  | {
      type: 'pressBack';
    }
  | {
      type: 'hideKeyboard';
    };

export interface AndroidRecoveryRecipe {
  id: string;
  signature: string;
  issueKind: RuntimeRecoveryIssueKind;
  action: AndroidRecoveryAction;
  source: 'builtin' | 'cache';
  reason: string;
  successCount?: number;
  failureCount?: number;
  updatedAt?: string;
}

export interface AndroidRuntimeGuardResult {
  status: AndroidRuntimeGuardStatus;
  actionName?: string;
  state?: RuntimeRecoveryState;
  issues?: RuntimeRecoveryIssue[];
  recovered?: AndroidRecoveryRecipe[];
  unresolved?: RuntimeRecoveryIssue[];
  reason?: string;
}

export interface AndroidRuntimeGuardOptions {
  enabled?: boolean;
  recoverKeyboard?: boolean;
  recoverPermissionDialogs?: boolean;
  recoverSystemDialogs?: boolean;
  recoverPopups?: boolean;
  failOnCritical?: boolean;
  failOnUnresolved?: boolean;
  inspectUiTree?: boolean;
  cacheRecipes?: boolean;
  maxRecoveryAttempts?: number;
  settleMs?: number;
  skipActions?: string[];
}

export type AndroidRuntimeGuardOption = boolean | AndroidRuntimeGuardOptions;

export interface AndroidRuntimeGuardAdapters {
  recoveryState(): Promise<RuntimeRecoveryState>;
  getUiTree(): Promise<ElementNode>;
  tap(x: number, y: number): Promise<void>;
  pressBack(): Promise<void>;
  hideKeyboard(): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

interface NormalizedGuardOptions extends Required<AndroidRuntimeGuardOptions> {}

const DEFAULT_OPTIONS: NormalizedGuardOptions = {
  enabled: true,
  recoverKeyboard: true,
  recoverPermissionDialogs: true,
  recoverSystemDialogs: true,
  recoverPopups: true,
  failOnCritical: true,
  failOnUnresolved: false,
  inspectUiTree: true,
  cacheRecipes: true,
  maxRecoveryAttempts: 2,
  settleMs: 250,
  skipActions: [],
};

const RECOVERY_ACTIONS = new Set([
  'RunAdbShell',
  'Launch',
  'Terminate',
  'KeyboardPress',
  'AndroidBackButton',
  'AndroidHomeButton',
  'AndroidRecentAppsButton',
]);

const KEYBOARD_SAFE_ACTIONS = new Set(['Input', 'KeyboardPress', 'ClearInput']);

const CRITICAL_ISSUES = new Set<RuntimeRecoveryIssueKind>(['crash', 'anr']);

const RECOVERABLE_ISSUES = new Set<RuntimeRecoveryIssueKind>([
  'permission-dialog',
  'system-dialog',
  'popup',
  'overlay',
  'ad',
  'keyboard',
]);

const PERMISSION_ACCEPT_PATTERNS = [
  /\ballow\b/i,
  /while using/i,
  /only this time/i,
  /\u5141\u8bb8/u,
  /\u540c\u610f/u,
  /\u59cb\u7ec8\u5141\u8bb8/u,
  /\u4ec5\u6b64\u4e00\u6b21/u,
  /\u4f7f\u7528\u671f\u95f4/u,
];

const DISMISS_PATTERNS = [
  /^(ok|got it|close|dismiss|cancel|not now|skip|later|no thanks)$/i,
  /\u786e\u5b9a/u,
  /\u77e5\u9053\u4e86/u,
  /\u5173\u95ed/u,
  /\u53d6\u6d88/u,
  /\u7a0d\u540e/u,
  /\u4ee5\u540e\u518d\u8bf4/u,
  /\u8df3\u8fc7/u,
  /\u6682\u4e0d/u,
];

const PERMISSION_PACKAGE_PATTERN =
  /permissioncontroller|packageinstaller|permission/i;
const SYSTEM_PACKAGE_PATTERN = /systemui|android/i;
const DIALOG_CLASS_PATTERN = /Dialog|PopupWindow|AlertDialog/i;
const BUTTON_CLASS_PATTERN = /Button|TextView/i;

export class AndroidRuntimeGuardError extends Error {
  readonly result: AndroidRuntimeGuardResult;

  constructor(message: string, result: AndroidRuntimeGuardResult) {
    super(message);
    this.name = 'AndroidRuntimeGuardError';
    this.result = result;
  }
}

export class AndroidRecoveryRecipeCache {
  private readonly recipes = new Map<string, AndroidRecoveryRecipe>();

  get(issue: RuntimeRecoveryIssue, state?: RuntimeRecoveryState) {
    const signature = issueSignature(issue, state);
    const cached = this.recipes.get(signature);
    if (!cached) {
      return undefined;
    }
    if ((cached.failureCount ?? 0) > (cached.successCount ?? 0) + 1) {
      return undefined;
    }
    return {
      ...cached,
      source: 'cache' as const,
    };
  }

  record(recipe: AndroidRecoveryRecipe, status: 'success' | 'failure') {
    const cached = this.recipes.get(recipe.signature);
    const next: AndroidRecoveryRecipe = {
      ...recipe,
      source: 'cache',
      successCount:
        (cached?.successCount ?? recipe.successCount ?? 0) +
        (status === 'success' ? 1 : 0),
      failureCount:
        (cached?.failureCount ?? recipe.failureCount ?? 0) +
        (status === 'failure' ? 1 : 0),
      updatedAt: new Date().toISOString(),
    };
    this.recipes.set(recipe.signature, next);
  }

  snapshot(): AndroidRecoveryRecipe[] {
    return [...this.recipes.values()].map((recipe) => ({ ...recipe }));
  }
}

export class AndroidRuntimeGuard {
  private readonly adapters: AndroidRuntimeGuardAdapters;
  private readonly recipeCache = new AndroidRecoveryRecipeCache();

  constructor(adapters: AndroidRuntimeGuardAdapters) {
    this.adapters = adapters;
  }

  async runBeforeAction(
    actionName: string,
    option?: AndroidRuntimeGuardOption,
  ): Promise<AndroidRuntimeGuardResult> {
    const options = normalizeGuardOptions(option);
    if (!shouldRunGuard(actionName, options)) {
      return { status: 'skipped', actionName, reason: 'guard-disabled' };
    }

    const state = await this.adapters.recoveryState();
    const issues = await this.collectIssues(state, actionName, options);
    if (!issues.length) {
      return { status: 'clean', actionName, state, issues };
    }

    const critical = issues.find((issue) => CRITICAL_ISSUES.has(issue.kind));
    if (critical) {
      const result: AndroidRuntimeGuardResult = {
        status: 'blocked',
        actionName,
        state,
        issues,
        unresolved: [critical],
        reason: critical.message ?? `${critical.kind} detected`,
      };
      if (options.failOnCritical) {
        throw new AndroidRuntimeGuardError(
          `Android runtime guard blocked ${actionName}: ${result.reason}`,
          result,
        );
      }
      return result;
    }

    const recovered: AndroidRecoveryRecipe[] = [];
    let latestState = state;
    let latestIssues = issues;

    for (let attempt = 0; attempt < options.maxRecoveryAttempts; attempt++) {
      const issue = latestIssues.find((item) =>
        RECOVERABLE_ISSUES.has(item.kind),
      );
      if (!issue) {
        break;
      }

      const recipe =
        options.cacheRecipes && this.recipeCache.get(issue, latestState);
      const recoveryRecipe =
        recipe ?? (await this.buildRecipe(issue, latestState, options));

      const nextRecipe =
        recoveryRecipe ??
        (await this.buildRecipeWithTree(issue, latestState, options));
      if (!nextRecipe) {
        break;
      }

      const verifyWithUiTree =
        options.inspectUiTree && !hasStateIssue(latestState, actionName, issue);
      await this.executeRecipe(nextRecipe);
      if (options.settleMs > 0) {
        await this.adapters.sleep(options.settleMs);
      }

      latestState = await this.adapters.recoveryState();
      latestIssues = await this.collectIssues(latestState, actionName, {
        ...options,
        inspectUiTree: verifyWithUiTree,
      });
      const resolved = !latestIssues.some(
        (item) => issueSignature(item, latestState) === nextRecipe.signature,
      );
      if (options.cacheRecipes) {
        this.recipeCache.record(nextRecipe, resolved ? 'success' : 'failure');
      }
      recovered.push(nextRecipe);

      if (!latestIssues.length) {
        return {
          status: 'recovered',
          actionName,
          state: latestState,
          issues: [],
          recovered,
        };
      }
    }

    const result: AndroidRuntimeGuardResult = {
      status: 'unresolved',
      actionName,
      state: latestState,
      issues: latestIssues,
      recovered,
      unresolved: latestIssues,
      reason: latestIssues.map((issue) => issue.kind).join(', '),
    };
    if (latestIssues.length && options.failOnUnresolved) {
      throw new AndroidRuntimeGuardError(
        `Android runtime guard could not recover before ${actionName}: ${result.reason}`,
        result,
      );
    }
    return latestIssues.length
      ? result
      : { ...result, status: recovered.length ? 'recovered' : 'clean' };
  }

  getRecipeCacheSnapshot(): AndroidRecoveryRecipe[] {
    return this.recipeCache.snapshot();
  }

  private async collectIssues(
    state: RuntimeRecoveryState,
    actionName: string,
    options: NormalizedGuardOptions,
  ): Promise<RuntimeRecoveryIssue[]> {
    const issues = normalizeAndroidRuntimeIssues(state, { actionName });
    if (!options.inspectUiTree) {
      return issues;
    }

    if (issues.some((issue) => CRITICAL_ISSUES.has(issue.kind))) {
      return issues;
    }

    if (issues.length || state.issues?.length) {
      return issues;
    }

    try {
      const tree = await this.adapters.getUiTree();
      return mergeIssues(
        issues,
        detectAndroidRuntimeIssuesFromTree(tree, state),
      );
    } catch {
      return issues;
    }
  }

  private async buildRecipe(
    issue: RuntimeRecoveryIssue,
    state: RuntimeRecoveryState,
    options: NormalizedGuardOptions,
  ): Promise<AndroidRecoveryRecipe | undefined> {
    if (issue.kind === 'keyboard' && options.recoverKeyboard) {
      return createRecipe(issue, state, { type: 'hideKeyboard' }, 'keyboard');
    }

    if (
      (issue.kind === 'system-dialog' && options.recoverSystemDialogs) ||
      ((issue.kind === 'overlay' || issue.kind === 'ad') &&
        options.recoverPopups)
    ) {
      return createRecipe(issue, state, { type: 'pressBack' }, 'back');
    }

    return undefined;
  }

  private async buildRecipeWithTree(
    issue: RuntimeRecoveryIssue,
    state: RuntimeRecoveryState,
    options: NormalizedGuardOptions,
  ): Promise<AndroidRecoveryRecipe | undefined> {
    if (
      issue.kind === 'permission-dialog' &&
      !options.recoverPermissionDialogs
    ) {
      return undefined;
    }
    if (
      ['system-dialog', 'popup', 'overlay', 'ad'].includes(issue.kind) &&
      !options.recoverPopups &&
      issue.kind !== 'system-dialog'
    ) {
      return undefined;
    }

    let tree: ElementNode;
    try {
      tree = await this.adapters.getUiTree();
    } catch {
      return undefined;
    }

    const target =
      issue.kind === 'permission-dialog'
        ? findBestTarget(tree, PERMISSION_ACCEPT_PATTERNS)
        : findBestTarget(tree, DISMISS_PATTERNS);

    if (target) {
      return createRecipe(
        issue,
        state,
        {
          type: 'tap',
          x: target.center[0],
          y: target.center[1],
          description: target.content,
        },
        'tap-ui-tree',
      );
    }

    if (issue.kind !== 'permission-dialog') {
      return createRecipe(issue, state, { type: 'pressBack' }, 'back');
    }

    return undefined;
  }

  private async executeRecipe(recipe: AndroidRecoveryRecipe): Promise<void> {
    if (recipe.action.type === 'tap') {
      await this.adapters.tap(recipe.action.x, recipe.action.y);
      return;
    }
    if (recipe.action.type === 'hideKeyboard') {
      await this.adapters.hideKeyboard();
      return;
    }
    await this.adapters.pressBack();
  }
}

export function normalizeGuardOptions(
  option?: AndroidRuntimeGuardOption,
): NormalizedGuardOptions {
  if (option === false) {
    return { ...DEFAULT_OPTIONS, enabled: false };
  }
  if (option === true || option === undefined) {
    return { ...DEFAULT_OPTIONS };
  }
  return {
    ...DEFAULT_OPTIONS,
    ...option,
    skipActions: [
      ...DEFAULT_OPTIONS.skipActions,
      ...(option.skipActions ?? []),
    ],
  };
}

export function normalizeAndroidRuntimeIssues(
  state: RuntimeRecoveryState,
  options: { actionName?: string } = {},
): RuntimeRecoveryIssue[] {
  const issues = mergeIssues([], state.issues ?? []);
  const actionName = options.actionName;
  if (
    state.keyboard?.shown &&
    (!actionName || !KEYBOARD_SAFE_ACTIONS.has(actionName))
  ) {
    issues.push({
      kind: 'keyboard',
      severity: 'info',
      message: 'Soft keyboard is visible',
      raw: state.keyboard.raw,
    });
  }
  return sortIssues(issues);
}

export function detectAndroidRuntimeIssuesFromTree(
  tree: ElementNode,
  state?: RuntimeRecoveryState,
): RuntimeRecoveryIssue[] {
  const nodes = treeToList(tree).filter((node) => node.isVisible);
  const packageNames = new Set(
    nodes
      .map((node) => node.attributes.packageName)
      .filter((value): value is string => Boolean(value)),
  );
  const foregroundPackage = state?.foreground?.packageName;
  const hasPermissionPackage = [...packageNames].some((packageName) =>
    PERMISSION_PACKAGE_PATTERN.test(packageName),
  );
  const hasSystemPackage = [...packageNames].some(
    (packageName) =>
      packageName !== foregroundPackage &&
      SYSTEM_PACKAGE_PATTERN.test(packageName),
  );
  const dialogNode = nodes.find((node) =>
    DIALOG_CLASS_PATTERN.test(node.attributes.className ?? ''),
  );

  const issues: RuntimeRecoveryIssue[] = [];
  const permissionTarget = findBestTargetFromNodes(
    nodes,
    PERMISSION_ACCEPT_PATTERNS,
  );
  if (hasPermissionPackage && permissionTarget) {
    issues.push({
      kind: 'permission-dialog',
      severity: 'warning',
      message: 'Permission dialog is visible',
      packageName: permissionTarget.attributes.packageName,
      bounds: permissionTarget.rect,
    });
  }

  const dismissTarget = findBestTargetFromNodes(nodes, DISMISS_PATTERNS);
  if (!issues.length && dismissTarget && (hasSystemPackage || dialogNode)) {
    issues.push({
      kind: hasSystemPackage ? 'system-dialog' : 'popup',
      severity: 'warning',
      message: dismissTarget.content || 'Dialog is visible',
      packageName: dismissTarget.attributes.packageName,
      bounds: dismissTarget.rect,
    });
  }

  return issues;
}

export function issueSignature(
  issue: RuntimeRecoveryIssue,
  state?: RuntimeRecoveryState,
): string {
  return [
    issue.kind,
    issue.packageName ?? state?.foreground?.packageName,
    issue.activity ?? state?.foreground?.activity,
    issue.message ? normalizeText(issue.message).slice(0, 80) : undefined,
    issue.bounds ? rectSignature(issue.bounds) : undefined,
  ]
    .filter(Boolean)
    .join('|');
}

function shouldRunGuard(
  actionName: string,
  options: NormalizedGuardOptions,
): boolean {
  if (!options.enabled) {
    return false;
  }
  if (RECOVERY_ACTIONS.has(actionName)) {
    return false;
  }
  return !options.skipActions.includes(actionName);
}

function hasStateIssue(
  state: RuntimeRecoveryState,
  actionName: string,
  issue: RuntimeRecoveryIssue,
): boolean {
  const signature = issueSignature(issue, state);
  return normalizeAndroidRuntimeIssues(state, { actionName }).some(
    (stateIssue) => issueSignature(stateIssue, state) === signature,
  );
}

function mergeIssues(
  base: RuntimeRecoveryIssue[],
  incoming: RuntimeRecoveryIssue[],
): RuntimeRecoveryIssue[] {
  const merged = [...base];
  const seen = new Set(merged.map((issue) => issueSignature(issue)));
  for (const issue of incoming) {
    const signature = issueSignature(issue);
    if (!seen.has(signature)) {
      merged.push(issue);
      seen.add(signature);
    }
  }
  return sortIssues(merged);
}

function sortIssues(issues: RuntimeRecoveryIssue[]): RuntimeRecoveryIssue[] {
  return [...issues].sort((first, second) => {
    return issuePriority(second) - issuePriority(first);
  });
}

function issuePriority(issue: RuntimeRecoveryIssue): number {
  if (issue.severity === 'critical' || CRITICAL_ISSUES.has(issue.kind)) {
    return 100;
  }
  if (issue.kind === 'permission-dialog') {
    return 80;
  }
  if (issue.kind === 'system-dialog') {
    return 70;
  }
  if (
    issue.kind === 'popup' ||
    issue.kind === 'overlay' ||
    issue.kind === 'ad'
  ) {
    return 60;
  }
  if (issue.kind === 'keyboard') {
    return 40;
  }
  return 10;
}

function createRecipe(
  issue: RuntimeRecoveryIssue,
  state: RuntimeRecoveryState,
  action: AndroidRecoveryAction,
  reason: string,
): AndroidRecoveryRecipe {
  const signature = issueSignature(issue, state);
  return {
    id: `${signature}|${action.type}`,
    signature,
    issueKind: issue.kind,
    action,
    source: 'builtin',
    reason,
  };
}

function findBestTarget(
  tree: ElementNode,
  patterns: RegExp[],
): ElementInfo | undefined {
  return findBestTargetFromNodes(
    treeToList(tree).filter((node) => node.isVisible),
    patterns,
  );
}

function findBestTargetFromNodes(
  nodes: ElementInfo[],
  patterns: RegExp[],
): ElementInfo | undefined {
  const candidates = nodes
    .filter((node) => isTapTarget(node))
    .map((node) => ({ node, score: scoreTarget(node, patterns) }))
    .filter((candidate) => candidate.score > 0)
    .sort((first, second) => second.score - first.score);
  return candidates[0]?.node;
}

function isTapTarget(node: ElementInfo): boolean {
  const attrs = node.attributes;
  return (
    node.rect.width > 0 &&
    node.rect.height > 0 &&
    (attrs.clickable === 'true' ||
      BUTTON_CLASS_PATTERN.test(attrs.className ?? '') ||
      Boolean(node.content))
  );
}

function scoreTarget(node: ElementInfo, patterns: RegExp[]): number {
  const text = normalizeText(
    [
      node.content,
      node.attributes.text,
      node.attributes.contentDesc,
      node.attributes.resourceId,
    ]
      .filter(Boolean)
      .join(' '),
  );
  if (!text) {
    return 0;
  }
  let score = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      score += 10;
    }
  }
  if (node.attributes.clickable === 'true') {
    score += 3;
  }
  if (/Button/i.test(node.attributes.className ?? '')) {
    score += 2;
  }
  return score;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function rectSignature(rect: Rect): string {
  return `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(
    rect.width,
  )},${Math.round(rect.height)}`;
}
