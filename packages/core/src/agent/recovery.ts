import type {
  CandidateAdjudication,
  CandidateAdjudicationConfig,
  ExecutionTask,
  LocateCandidate,
  PlanningLocateParam,
  RuntimeRecoveryState,
} from '@/types';
import type { PageExperienceGraph, PathExperienceEdge } from './experience';

export const DEFAULT_CANDIDATE_ADJUDICATION_CONFIG: Required<CandidateAdjudicationConfig> =
  {
    enabled: true,
    maxCandidates: 5,
    minConfidence: 0.45,
    autoAcceptConfidence: 0.92,
    aiEnabled: true,
  };

export interface CompactLocateCandidate {
  index: number;
  description?: string;
  confidence?: number;
  source?: string;
  reason?: string;
  center?: [number, number];
  rect?: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  metadata?: Record<string, unknown>;
}

export interface CompactRecoveryEvidence {
  time?: string;
  userInstruction?: string;
  errorMessage: string;
  failedTask?: {
    type?: string;
    subType?: string;
    thought?: string;
    param?: unknown;
    hitBy?: {
      from?: string;
      context?: unknown;
    };
  };
  runtimeState?: RuntimeRecoveryState;
  candidates?: CompactLocateCandidate[];
}

export function normalizeCandidateAdjudicationConfig(
  option?: CandidateAdjudication,
): Required<CandidateAdjudicationConfig> {
  if (option === false) {
    return {
      ...DEFAULT_CANDIDATE_ADJUDICATION_CONFIG,
      enabled: false,
    };
  }
  if (option === true || option === undefined) {
    return { ...DEFAULT_CANDIDATE_ADJUDICATION_CONFIG };
  }
  return {
    ...DEFAULT_CANDIDATE_ADJUDICATION_CONFIG,
    ...option,
  };
}

export function compactLocateCandidates(
  candidates: LocateCandidate[] | undefined,
  maxCandidates = DEFAULT_CANDIDATE_ADJUDICATION_CONFIG.maxCandidates,
): CompactLocateCandidate[] | undefined {
  if (!candidates?.length) {
    return undefined;
  }

  const compacted = candidates.slice(0, maxCandidates).map((candidate, idx) => {
    const element = candidate.element;
    return {
      index: idx + 1,
      description: element.description,
      confidence: roundConfidence(candidate.confidence),
      source: candidate.source,
      reason: candidate.reason,
      center: element.center,
      rect: element.rect,
      metadata: compactMetadata(candidate.metadata),
    };
  });
  return compacted.length ? compacted : undefined;
}

export function formatLocateCandidatesForPrompt(
  candidates: LocateCandidate[],
  maxCandidates = DEFAULT_CANDIDATE_ADJUDICATION_CONFIG.maxCandidates,
): string {
  const compacted = compactLocateCandidates(candidates, maxCandidates) ?? [];
  return compacted
    .map((candidate) => {
      const rect = candidate.rect
        ? `rect=${JSON.stringify(candidate.rect)}`
        : '';
      const center = candidate.center
        ? `center=${JSON.stringify(candidate.center)}`
        : '';
      const confidence =
        candidate.confidence === undefined
          ? ''
          : `confidence=${candidate.confidence}`;
      const reason = candidate.reason ? `reason=${candidate.reason}` : '';
      const metadata = candidate.metadata
        ? `metadata=${compactJson(candidate.metadata, 220)}`
        : '';
      return [
        `${candidate.index}. "${candidate.description || 'unnamed candidate'}"`,
        confidence,
        reason,
        center,
        rect,
        metadata,
      ]
        .filter(Boolean)
        .join(', ');
    })
    .join('\n');
}

export function buildCompactRecoveryEvidence(input: {
  error: unknown;
  time?: string;
  userInstruction?: string;
  failedTask?: ExecutionTask | null;
  runtimeState?: RuntimeRecoveryState | null;
  candidates?: LocateCandidate[];
  maxCandidates?: number;
}): CompactRecoveryEvidence {
  const failedTask = input.failedTask;
  return {
    time: input.time,
    userInstruction: input.userInstruction,
    errorMessage: errorMessage(input.error),
    failedTask: failedTask
      ? {
          type: failedTask.type,
          subType: failedTask.subType,
          thought: failedTask.thought,
          param: compactTaskParam(failedTask.param),
          hitBy: failedTask.hitBy
            ? {
                from: failedTask.hitBy.from,
                context: compactValue(failedTask.hitBy.context, 400),
              }
            : undefined,
        }
      : undefined,
    runtimeState: compactRuntimeState(input.runtimeState),
    candidates: compactLocateCandidates(input.candidates, input.maxCandidates),
  };
}

export function formatCompactRecoveryEvidenceForAI(
  evidence: CompactRecoveryEvidence,
): string {
  return [
    'The previous execution step failed. Correct only the current failed point, do not restart the whole task unless the current state clearly requires it.',
    'Use runtime issues first: dismiss permission/system dialogs, handle crash/ANR, recover login/network/overlay states, then continue the original instruction.',
    '<recovery_evidence>',
    compactJson(evidence, 3000),
    '</recovery_evidence>',
  ].join('\n');
}

export function formatExperienceGraphForPlanning(
  graph: PageExperienceGraph | undefined,
  options: { maxEdges?: number } = {},
): string | undefined {
  if (!graph) {
    return undefined;
  }

  const edges = graph
    .listEdges({ includeInvalid: false })
    .filter((edge) => edge.status !== 'invalid')
    .slice(0, options.maxEdges ?? 8);

  if (!edges.length) {
    return undefined;
  }

  const lines = edges.map(formatExperienceEdge);
  return [
    '<experience_graph>',
    'Known page paths from previous successful runs. Treat them as hints, verify against the current screenshot/runtime state, and demote or recover if the state contradicts them.',
    ...lines,
    '</experience_graph>',
  ].join('\n');
}

export function promptFromLocateParam(
  param: PlanningLocateParam | undefined,
): string | undefined {
  const prompt = param?.prompt;
  if (typeof prompt === 'string') {
    return prompt;
  }
  return prompt?.prompt;
}

function formatExperienceEdge(edge: PathExperienceEdge): string {
  const parts = [
    `${edge.from} -> ${edge.to}`,
    `action=${edge.action}`,
    edge.intent ? `intent=${edge.intent}` : '',
    edge.moduleId ? `module=${edge.moduleId}` : '',
    `confidence=${roundConfidence(edge.confidence)}`,
    `successRate=${roundConfidence(edge.successRate)}`,
    edge.averageDurationMs === undefined
      ? ''
      : `avgMs=${edge.averageDurationMs}`,
    `status=${edge.status}`,
  ].filter(Boolean);
  return `- ${parts.join(', ')}`;
}

function compactTaskParam(param: unknown): unknown {
  return compactValue(param, 600);
}

function compactRuntimeState(
  state: RuntimeRecoveryState | null | undefined,
): RuntimeRecoveryState | undefined {
  if (!state) {
    return undefined;
  }
  return {
    timestamp: state.timestamp,
    summary: state.summary,
    foreground: state.foreground,
    keyboard: state.keyboard,
    issues: state.issues?.slice(0, 6).map((issue) => ({
      kind: issue.kind,
      severity: issue.severity,
      message: issue.message,
      packageName: issue.packageName,
      activity: issue.activity,
      bounds: issue.bounds,
    })),
  };
}

function compactMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  const entries = Object.entries(metadata)
    .filter(([, value]) => value !== undefined && value !== '')
    .slice(0, 8)
    .map(([key, value]) => [key, compactValue(value, 180)] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function compactValue(value: unknown, maxLength: number): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value === 'string') {
    return truncate(value, maxLength);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  const serialized = compactJson(value, maxLength);
  try {
    return JSON.parse(serialized);
  } catch {
    return serialized;
  }
}

function compactJson(value: unknown, maxLength: number): string {
  const serialized = JSON.stringify(value, recoveryReplacer, 2) ?? '';
  return truncate(serialized, maxLength);
}

function recoveryReplacer(key: string, value: unknown): unknown {
  if (
    key === 'screenshot' ||
    key === 'uiContext' ||
    key === 'executor' ||
    key === 'recorder' ||
    key === 'rawResponse' ||
    key === 'base64' ||
    key === 'dataUrl'
  ) {
    return '[omitted]';
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

function roundConfidence(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Number(value.toFixed(3));
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}
