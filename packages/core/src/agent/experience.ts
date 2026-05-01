import type { InterfaceType, MidsceneYamlFlowItem } from '@/types';

export type FlowMacroName =
  | 'launch'
  | 'login'
  | 'permissions'
  | 'home'
  | 'resetState'
  | (string & {});

export const STANDARD_FLOW_MACRO_NAMES = [
  'launch',
  'login',
  'permissions',
  'home',
  'resetState',
] as const;

export interface FlowMacro {
  name: FlowMacroName;
  flow: MidsceneYamlFlowItem[];
  description?: string;
  moduleId?: string;
  tags?: string[];
}

export interface TestModuleContext {
  interfaceType?: InterfaceType;
  packageName?: string;
  activity?: string;
  pageFingerprint?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface TestModuleLoadRule {
  interfaceType?: InterfaceType | InterfaceType[];
  packageName?: string | RegExp;
  activity?: string | RegExp;
  pageFingerprint?: string | RegExp;
  tags?: string[];
}

export interface TestModule {
  id: string;
  name?: string;
  description?: string;
  priority?: number;
  load?:
    | TestModuleLoadRule
    | TestModuleLoadRule[]
    | ((context: TestModuleContext) => boolean);
  macros?: Record<string, FlowMacro | MidsceneYamlFlowItem[]>;
}

export interface RegisteredFlowMacro extends FlowMacro {
  moduleId: string;
}

export interface PathExperienceInput {
  from: string | PageGraphNodeInput;
  to: string | PageGraphNodeInput;
  action: string;
  intent?: string;
  moduleId?: string;
  success: boolean;
  durationMs?: number;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface PageGraphNodeInput {
  id?: string;
  fingerprint?: string;
  packageName?: string;
  activity?: string;
  title?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface PageGraphNode {
  id: string;
  fingerprint?: string;
  packageName?: string;
  activity?: string;
  title?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  seenCount: number;
  lastSeenAt?: number;
}

export type PathExperienceStatus = 'active' | 'degraded' | 'invalid';

export interface PathExperienceEdge {
  id: string;
  from: string;
  to: string;
  action: string;
  intent?: string;
  moduleId?: string;
  attempts: number;
  successes: number;
  failures: number;
  successRate: number;
  averageDurationMs?: number;
  lastDurationMs?: number;
  confidence: number;
  status: PathExperienceStatus;
  lastSeenAt?: number;
  invalidationReason?: string;
  metadata?: Record<string, unknown>;
}

export interface PageExperienceGraphSnapshot {
  nodes: PageGraphNode[];
  edges: PathExperienceEdge[];
}

export interface PathExperienceDemotionOptions {
  penalty?: number;
  reason?: string;
  invalidBelow?: number;
}

export class TestModuleRegistry {
  private readonly modules = new Map<string, TestModule>();

  register(module: TestModule): this {
    if (!module.id?.trim()) {
      throw new Error('TestModule id is required');
    }
    this.modules.set(module.id, {
      ...module,
      priority: module.priority ?? 0,
    });
    return this;
  }

  unregister(id: string): boolean {
    return this.modules.delete(id);
  }

  clear(): void {
    this.modules.clear();
  }

  get(id: string): TestModule | undefined {
    return this.modules.get(id);
  }

  list(): TestModule[] {
    return this.sortedModules(Array.from(this.modules.values()));
  }

  loadFor(context: TestModuleContext): TestModule[] {
    return this.sortedModules(
      Array.from(this.modules.values()).filter((module) =>
        testModuleMatches(module, context),
      ),
    );
  }

  resolveMacro(
    name: FlowMacroName,
    context: TestModuleContext = {},
  ): RegisteredFlowMacro | undefined {
    const [qualifiedModuleId, qualifiedName] = splitQualifiedMacroName(name);
    const modules = qualifiedModuleId
      ? [this.modules.get(qualifiedModuleId)].filter(Boolean)
      : this.loadFor(context);

    for (const module of modules) {
      const macro = normalizeModuleMacro(module!, qualifiedName);
      if (macro) {
        return macro;
      }
    }

    return undefined;
  }

  private sortedModules(modules: TestModule[]): TestModule[] {
    return [...modules].sort((a, b) => {
      const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      return a.id.localeCompare(b.id);
    });
  }
}

export class PageExperienceGraph {
  private readonly nodes = new Map<string, PageGraphNode>();
  private readonly edges = new Map<string, PathExperienceEdge>();

  constructor(snapshot?: PageExperienceGraphSnapshot) {
    snapshot?.nodes?.forEach((node) => this.nodes.set(node.id, { ...node }));
    snapshot?.edges?.forEach((edge) => this.edges.set(edge.id, { ...edge }));
  }

  upsertPage(input: string | PageGraphNodeInput): PageGraphNode {
    const nodeInput = typeof input === 'string' ? { id: input } : input;
    const id = normalizePageId(
      nodeInput.id ?? nodeInput.fingerprint ?? nodeInput.title,
    );
    const existing = this.nodes.get(id);
    const now = Date.now();
    const node: PageGraphNode = {
      ...existing,
      ...nodeInput,
      id,
      seenCount: (existing?.seenCount ?? 0) + 1,
      lastSeenAt: now,
      tags: mergeUnique(existing?.tags, nodeInput.tags),
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(nodeInput.metadata ?? {}),
      },
    };
    this.nodes.set(id, node);
    return node;
  }

  recordPath(input: PathExperienceInput): PathExperienceEdge {
    const from = this.upsertPage(input.from);
    const to = this.upsertPage(input.to);
    const id = edgeIdFor({
      from: from.id,
      to: to.id,
      action: input.action,
      intent: input.intent,
      moduleId: input.moduleId,
    });
    const existing = this.edges.get(id);
    const attempts = (existing?.attempts ?? 0) + 1;
    const successes = (existing?.successes ?? 0) + (input.success ? 1 : 0);
    const failures = (existing?.failures ?? 0) + (input.success ? 0 : 1);
    const successRate = successes / attempts;
    const averageDurationMs = updateAverageDuration(
      existing,
      input.durationMs,
      attempts,
    );
    const confidence = clampConfidence(
      existing
        ? existing.confidence + (input.success ? 0.1 : -0.25)
        : input.success
          ? 0.75
          : 0.35,
    );

    const edge: PathExperienceEdge = {
      ...existing,
      id,
      from: from.id,
      to: to.id,
      action: input.action,
      intent: input.intent,
      moduleId: input.moduleId,
      attempts,
      successes,
      failures,
      successRate,
      averageDurationMs,
      lastDurationMs: input.durationMs ?? existing?.lastDurationMs,
      confidence,
      status:
        confidence < 0.15
          ? 'invalid'
          : confidence < 0.5
            ? 'degraded'
            : 'active',
      lastSeenAt: input.timestamp ?? Date.now(),
      invalidationReason: input.success
        ? undefined
        : existing?.invalidationReason,
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
    };
    this.edges.set(id, edge);
    return edge;
  }

  degradePath(
    edgeId: string,
    options: PathExperienceDemotionOptions = {},
  ): PathExperienceEdge {
    const edge = this.edges.get(edgeId);
    if (!edge) {
      throw new Error(`Path experience edge not found: ${edgeId}`);
    }
    const confidence = clampConfidence(
      edge.confidence - (options.penalty ?? 0.3),
    );
    const invalidBelow = options.invalidBelow ?? 0.15;
    const degraded: PathExperienceEdge = {
      ...edge,
      confidence,
      status: confidence <= invalidBelow ? 'invalid' : 'degraded',
      invalidationReason: options.reason ?? edge.invalidationReason,
    };
    this.edges.set(edgeId, degraded);
    return degraded;
  }

  getNode(id: string): PageGraphNode | undefined {
    return this.nodes.get(normalizePageId(id));
  }

  getEdge(id: string): PathExperienceEdge | undefined {
    return this.edges.get(id);
  }

  listNodes(): PageGraphNode[] {
    return Array.from(this.nodes.values());
  }

  listEdges(options?: {
    from?: string;
    to?: string;
    status?: PathExperienceStatus;
    includeInvalid?: boolean;
  }): PathExperienceEdge[] {
    return Array.from(this.edges.values())
      .filter((edge) => {
        if (!options?.includeInvalid && edge.status === 'invalid') return false;
        if (options?.from && edge.from !== normalizePageId(options.from)) {
          return false;
        }
        if (options?.to && edge.to !== normalizePageId(options.to)) {
          return false;
        }
        if (options?.status && edge.status !== options.status) return false;
        return true;
      })
      .sort(compareEdges);
  }

  bestNextStep(from: string, intent?: string): PathExperienceEdge | undefined {
    return this.listEdges({ from }).find(
      (edge) => !intent || edge.intent === intent,
    );
  }

  toJSON(): PageExperienceGraphSnapshot {
    return {
      nodes: this.listNodes(),
      edges: this.listEdges({ includeInvalid: true }),
    };
  }
}

export function createFlowMacro(
  name: FlowMacroName,
  flow: MidsceneYamlFlowItem[],
  options: Omit<FlowMacro, 'name' | 'flow'> = {},
): FlowMacro {
  return {
    ...options,
    name,
    flow,
  };
}

function testModuleMatches(
  module: TestModule,
  context: TestModuleContext,
): boolean {
  if (!module.load) {
    return true;
  }
  if (typeof module.load === 'function') {
    return module.load(context);
  }
  const rules = Array.isArray(module.load) ? module.load : [module.load];
  return rules.some((rule) => testLoadRuleMatches(rule, context));
}

function testLoadRuleMatches(
  rule: TestModuleLoadRule,
  context: TestModuleContext,
): boolean {
  if (
    rule.interfaceType &&
    !asArray(rule.interfaceType).includes(
      context.interfaceType as InterfaceType,
    )
  ) {
    return false;
  }
  if (!patternMatches(rule.packageName, context.packageName)) return false;
  if (!patternMatches(rule.activity, context.activity)) return false;
  if (!patternMatches(rule.pageFingerprint, context.pageFingerprint)) {
    return false;
  }
  if (rule.tags?.length) {
    const contextTags = new Set(context.tags ?? []);
    if (!rule.tags.every((tag) => contextTags.has(tag))) return false;
  }
  return true;
}

function patternMatches(
  pattern: string | RegExp | undefined,
  value: string | undefined,
): boolean {
  if (!pattern) return true;
  if (!value) return false;
  if (pattern instanceof RegExp) return pattern.test(value);
  return pattern === value;
}

function normalizeModuleMacro(
  module: TestModule,
  name: FlowMacroName,
): RegisteredFlowMacro | undefined {
  const rawMacro = module.macros?.[name];
  if (!rawMacro) {
    return undefined;
  }
  const macro = Array.isArray(rawMacro)
    ? createFlowMacro(name, rawMacro)
    : { ...rawMacro, name: rawMacro.name ?? name };
  return {
    ...macro,
    moduleId: module.id,
  };
}

function splitQualifiedMacroName(
  name: FlowMacroName,
): [string | undefined, FlowMacroName] {
  const text = String(name);
  const dotIndex = text.indexOf('.');
  if (dotIndex <= 0) {
    return [undefined, name];
  }
  return [text.slice(0, dotIndex), text.slice(dotIndex + 1) as FlowMacroName];
}

function normalizePageId(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error('Page graph node id or fingerprint is required');
  }
  return value.trim();
}

function edgeIdFor(input: {
  from: string;
  to: string;
  action: string;
  intent?: string;
  moduleId?: string;
}): string {
  return [
    input.moduleId ?? '',
    input.from,
    input.to,
    input.action,
    input.intent ?? '',
  ]
    .map((part) => encodeURIComponent(part))
    .join('|');
}

function updateAverageDuration(
  existing: PathExperienceEdge | undefined,
  durationMs: number | undefined,
  attempts: number,
): number | undefined {
  if (durationMs === undefined) {
    return existing?.averageDurationMs;
  }
  if (existing?.averageDurationMs === undefined) {
    return durationMs;
  }
  return Math.round(
    (existing.averageDurationMs * (attempts - 1) + durationMs) / attempts,
  );
}

function compareEdges(a: PathExperienceEdge, b: PathExperienceEdge): number {
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  if (b.successRate !== a.successRate) return b.successRate - a.successRate;
  return (
    (a.averageDurationMs ?? Number.MAX_SAFE_INTEGER) -
    (b.averageDurationMs ?? Number.MAX_SAFE_INTEGER)
  );
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

function mergeUnique<T>(a?: T[], b?: T[]): T[] | undefined {
  const merged = [...(a ?? []), ...(b ?? [])];
  return merged.length ? Array.from(new Set(merged)) : undefined;
}

function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}
