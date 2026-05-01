import { z } from 'zod';
import Service from './service/index';
import { TaskRunner } from './task-runner';
import { getVersion } from './utils';

export {
  plan,
  AiLocateElement,
  runConnectivityTest,
  getMidsceneLocationSchema,
  PointSchema,
  SizeSchema,
  RectSchema,
  TMultimodalPromptSchema,
  TUserPromptSchema,
  type TMultimodalPrompt,
  type TUserPrompt,
  type ConnectivityCheckResultItem,
  type ConnectivityTestConfig,
  type ConnectivityTestResult,
} from './ai-model/index';

export {
  MIDSCENE_MODEL_NAME,
  type CreateOpenAIClientFn,
} from '@midscene/shared/env';

export type * from './types';
export {
  ServiceError,
  ExecutionDump,
  ReportActionDump,
  GroupedActionDump,
  type IExecutionDump,
  type IReportActionDump,
  type IGroupedActionDump,
  type ReportMeta,
  type GroupMeta,
} from './types';

export { z };

export default Service;
export { TaskRunner, Service, getVersion };

export type {
  MidsceneYamlScript,
  MidsceneYamlTask,
  MidsceneYamlFlowItem,
  MidsceneYamlConfigResult,
  MidsceneYamlConfig,
  MidsceneYamlScriptWebEnv,
  MidsceneYamlScriptAndroidEnv,
  MidsceneYamlScriptIOSEnv,
  MidsceneYamlScriptEnv,
  LocateOption,
  DetailedLocateParam,
} from './yaml';

export { Agent, type AgentOpt, type AiActOptions, createAgent } from './agent';
export {
  PageExperienceGraph,
  STANDARD_FLOW_MACRO_NAMES,
  TestModuleRegistry,
  DEFAULT_CANDIDATE_ADJUDICATION_CONFIG,
  buildCompactRecoveryEvidence,
  collectExecutionReportStats,
  compactLocateCandidates,
  createFlowMacro,
  formatCompactRecoveryEvidenceForAI,
  formatExperienceGraphForPlanning,
  formatLocateCandidatesForPrompt,
  normalizeCandidateAdjudicationConfig,
  promptFromLocateParam,
  type CompactLocateCandidate,
  type CompactRecoveryEvidence,
  type ExecutionReportStats,
  type FlowMacro,
  type FlowMacroName,
  type PageExperienceGraphSnapshot,
  type PageGraphNode,
  type PageGraphNodeInput,
  type PathExperienceDemotionOptions,
  type PathExperienceEdge,
  type PathExperienceInput,
  type PathExperienceStatus,
  type RegisteredFlowMacro,
  type TestModule,
  type TestModuleContext,
  type TestModuleLoadRule,
} from './agent';

// Dump utilities
export {
  restoreImageReferences,
  escapeContent,
  unescapeContent,
  parseImageScripts,
  parseDumpScript,
  parseDumpScriptAttributes,
  generateImageScriptTag,
  generateDumpScriptTag,
} from './dump';

// Report generator
export type { IReportGenerator } from './report-generator';
export { ReportGenerator, nullReportGenerator } from './report-generator';
export {
  collectDedupedExecutions,
  ReportMergingTool,
  dedupeExecutionsKeepLatest,
  splitReportHtmlByExecution,
} from './report';
export {
  createReportCliCommands,
  reportFileToMarkdown,
  splitReportFile,
  type ConsumeReportFileAction,
  type ReportFileToMarkdownOptions,
  type ReportCliCommandDefinition,
  type ReportCliCommandEntry,
  type SplitReportFileOptions,
} from './report-cli';

// ScreenshotItem
export { ScreenshotItem } from './screenshot-item';
export { ScreenshotStore, type ScreenshotRef } from './dump/screenshot-store';

export {
  executionToMarkdown,
  reportToMarkdown,
  type ExecutionMarkdownOptions,
  type ExecutionMarkdownResult,
  type ReportMarkdownResult,
  type MarkdownAttachment,
} from './report-markdown';
