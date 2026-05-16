import assert from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { TUserPrompt } from '@/ai-model';
import type { ElementCacheFeature } from '@/types';
import { getMidsceneRunSubDir } from '@midscene/shared/common';
import {
  MIDSCENE_CACHE_MAX_FILENAME_LENGTH,
  globalConfigManager,
} from '@midscene/shared/env';
import { getDebug } from '@midscene/shared/logger';
import { ifInBrowser, ifInWorker } from '@midscene/shared/utils';
import { generateHashId } from '@midscene/shared/utils';
import { replaceIllegalPathCharsAndSpace } from '@midscene/shared/utils';
import yaml from 'js-yaml';
import semver from 'semver';
import {
  type FlowMacro,
  PageExperienceGraph,
  type PageExperienceGraphSnapshot,
  type PathExperienceDemotionOptions,
  type PathExperienceInput,
} from './experience';
import type { CanonicalOperation, OperationIR } from './operation-ir';
import { getMidsceneVersion } from './utils';

const DEFAULT_CACHE_MAX_FILENAME_LENGTH = 200;

export const debug = getDebug('cache');

export interface CacheScope {
  interfaceType?: string;
  url?: string;
  packageName?: string;
  activity?: string;
  pageFingerprint?: string;
  sdk?: string | number;
  manufacturer?: string;
  locale?: string;
  orientation?: string;
  displayId?: string | number;
  appVersion?: string;
}

export type CacheScopeMatch = 'exact' | 'compatible' | 'mismatch' | 'unknown';

export interface CacheEntryStats {
  hitCount?: number;
  successCount?: number;
  failureCount?: number;
  skipCount?: number;
  lastHitAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastSkipAt?: string;
}

export interface CacheEntryState {
  status?: 'active' | 'degraded' | 'stale' | 'disabled';
  confidence?: number;
  reason?: string;
  lastSkipReason?: string;
  lastScopeMatch?: CacheScopeMatch;
  refreshRecommended?: boolean;
  demotedAt?: string;
  updatedAt?: string;
}

export interface CacheScopeMatchDetail {
  result: CacheScopeMatch;
  comparedKeys: Array<keyof CacheScope>;
  missingCurrentKeys: Array<keyof CacheScope>;
  mismatchedKeys: Array<keyof CacheScope>;
  driftKeys: Array<keyof CacheScope>;
  reason?: string;
}

export interface CacheVerificationResult {
  status: 'success' | 'failure';
  source?: string;
  reason?: string;
}

export interface CacheVerificationRecord extends CacheVerificationResult {
  at: string;
}

interface CacheEntryMetadata {
  scope?: CacheScope;
  stats?: CacheEntryStats;
  state?: CacheEntryState;
  lastVerification?: CacheVerificationRecord;
}

export interface PlanningCache extends CacheEntryMetadata {
  type: 'plan';
  prompt: string;
  yamlWorkflow: string;
  operationKey?: string;
  operation?: OperationIR;
}

export interface LocateCache extends CacheEntryMetadata {
  type: 'locate';
  prompt: TUserPrompt;
  operation?: string;
  operationKey?: string;
  operationSignature?: CanonicalOperation;
  cache?: ElementCacheFeature;
  /** @deprecated kept for backward compatibility */
  xpaths?: string[];
}

export interface OperationCache extends CacheEntryMetadata {
  type: 'operation';
  prompt: string;
  operationKey: string;
  operation: OperationIR;
  yamlWorkflow: string;
}

export type CacheRecord = PlanningCache | OperationCache | LocateCache;

export type CacheGovernanceRecommendation =
  | 'use'
  | 'verify'
  | 'refresh'
  | 'skip'
  | 'disabled';

export interface CacheGovernanceRecordSnapshot {
  index: number;
  type: CacheRecord['type'];
  prompt?: TUserPrompt;
  operationKey?: string;
  scope?: CacheScope;
  state: CacheEntryState;
  stats: CacheEntryStats;
  lastVerification?: CacheVerificationRecord;
  scopeMatch?: CacheScopeMatchDetail;
  governance: {
    usable: boolean;
    recommendation: CacheGovernanceRecommendation;
    confidence: number;
    status: NonNullable<CacheEntryState['status']>;
    refreshRecommended: boolean;
    reason?: string;
  };
}

export interface CacheGovernanceSnapshot {
  cacheId: string;
  cacheFilePath?: string;
  total: number;
  byType: Record<CacheRecord['type'], number>;
  byStatus: Record<NonNullable<CacheEntryState['status']>, number>;
  records: CacheGovernanceRecordSnapshot[];
}

export interface MatchCacheResult<T extends CacheRecord> {
  cacheContent: T;
  cacheUsable: boolean;
  scopeMatch?: CacheScopeMatch;
  updateFn: (cb: (cache: T) => void) => void;
}

type AnyMatchCacheResult = MatchCacheResult<any>;

export type CacheFileContent = {
  midsceneVersion: string;
  cacheId: string;
  caches: CacheRecord[];
  flowMacros?: FlowMacro[];
  experience?: PageExperienceGraphSnapshot;
};

const lowestSupportedMidsceneVersion = '0.16.10';
export const cacheFileExt = '.cache.yaml';
const CACHE_FAILURES_BEFORE_STALE = 3;
const CACHE_MIN_CONFIDENCE_TO_MATCH = 0.2;
const CACHE_SCOPE_KEYS: Array<keyof CacheScope> = [
  'interfaceType',
  'url',
  'packageName',
  'activity',
  'pageFingerprint',
  'sdk',
  'manufacturer',
  'locale',
  'orientation',
  'displayId',
  'appVersion',
];
const CACHE_SCOPE_INVALIDATION_KEYS: Array<keyof CacheScope> = [
  'pageFingerprint',
  'appVersion',
];

export class TaskCache {
  cacheId: string;

  cacheFilePath?: string;

  cache: CacheFileContent;

  isCacheResultUsed: boolean; // a flag to indicate if the cache result should be used
  cacheOriginalLength: number;

  readOnlyMode: boolean; // a flag to indicate if the cache is in read-only mode

  writeOnlyMode: boolean; // a flag to indicate if the cache is in write-only mode

  private matchedCacheIndices: Set<string> = new Set(); // Track matched records

  private experienceGraph: PageExperienceGraph;

  constructor(
    cacheId: string,
    isCacheResultUsed: boolean,
    cacheFilePath?: string,
    options: { readOnly?: boolean; writeOnly?: boolean } = {},
  ) {
    assert(cacheId, 'cacheId is required');
    let safeCacheId = replaceIllegalPathCharsAndSpace(cacheId);
    const cacheMaxFilenameLength =
      globalConfigManager.getEnvConfigValueAsNumber(
        MIDSCENE_CACHE_MAX_FILENAME_LENGTH,
      ) ?? DEFAULT_CACHE_MAX_FILENAME_LENGTH;
    if (Buffer.byteLength(safeCacheId, 'utf8') > cacheMaxFilenameLength) {
      const prefix = safeCacheId.slice(0, 32);
      const hash = generateHashId(undefined, safeCacheId);
      safeCacheId = `${prefix}-${hash}`;
    }
    this.cacheId = safeCacheId;

    this.cacheFilePath =
      ifInBrowser || ifInWorker
        ? undefined
        : cacheFilePath ||
          join(getMidsceneRunSubDir('cache'), `${this.cacheId}${cacheFileExt}`);
    const readOnlyMode = Boolean(options?.readOnly);
    const writeOnlyMode = Boolean(options?.writeOnly);

    if (readOnlyMode && writeOnlyMode) {
      throw new Error('TaskCache cannot be both read-only and write-only');
    }

    this.isCacheResultUsed = writeOnlyMode ? false : isCacheResultUsed;
    this.readOnlyMode = readOnlyMode;
    this.writeOnlyMode = writeOnlyMode;

    let cacheContent;
    if (this.cacheFilePath && !this.writeOnlyMode) {
      cacheContent = this.loadCacheFromFile();
    }
    if (!cacheContent) {
      cacheContent = {
        midsceneVersion: getMidsceneVersion(),
        cacheId: this.cacheId,
        caches: [],
      };
    }
    this.cache = cacheContent;
    this.cacheOriginalLength = this.isCacheResultUsed
      ? this.cache.caches.length
      : 0;
    this.experienceGraph = new PageExperienceGraph(this.cache.experience);
  }

  resetMatchedCacheUsage(): void {
    this.matchedCacheIndices.clear();
    this.cacheOriginalLength = this.isCacheResultUsed
      ? this.cache.caches.length
      : 0;
    debug(
      'cache match cycle reset, record length: %d',
      this.cacheOriginalLength,
    );
  }

  matchCache(
    prompt: TUserPrompt,
    type: 'plan' | 'locate',
    scope?: CacheScope,
    operationKey?: string,
  ): MatchCacheResult<PlanningCache | LocateCache> | undefined {
    if (!this.isCacheResultUsed) {
      return undefined;
    }
    // Find the first unused matching cache
    const promptStr =
      typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
    for (let i = 0; i < this.cacheOriginalLength; i++) {
      const item = this.cache.caches[i];
      const key = `${type}:${promptStr}:${i}`;
      if (
        item.type === type &&
        cacheIdentityMatches(item, prompt, operationKey) &&
        !this.matchedCacheIndices.has(key)
      ) {
        const governance = this.evaluateCacheGovernance(item, scope);
        if (!governance.usable) {
          debug(
            'cache skipped, type: %s, prompt: %s, index: %d, reason: %s',
            type,
            prompt,
            i,
            governance.skipReason,
          );
          continue;
        }
        if (item.type === 'locate') {
          const locateItem = item as LocateCache;
          if (!locateItem.cache && Array.isArray(locateItem.xpaths)) {
            locateItem.cache = { xpaths: locateItem.xpaths };
          }
          if ('xpaths' in locateItem) {
            locateItem.xpaths = undefined;
          }
        }
        this.matchedCacheIndices.add(key);
        this.recordCacheHitInMemory(item, governance.scopeMatchDetail);
        debug(
          'cache found and marked as used, type: %s, prompt: %s, index: %d, scopeMatch: %s',
          type,
          prompt,
          i,
          governance.scopeMatch,
        );
        return {
          cacheContent: item,
          cacheUsable: true,
          scopeMatch: governance.scopeMatch,
          updateFn: (cb: (cache: PlanningCache | LocateCache) => void) => {
            debug(
              'will call updateFn to update cache, type: %s, prompt: %s, index: %d',
              type,
              prompt,
              i,
            );
            cb(item);

            if (this.readOnlyMode) {
              debug(
                'read-only mode, cache updated in memory but not flushed to file',
              );
              return;
            }

            debug(
              'cache updated, will flush to file, type: %s, prompt: %s, index: %d',
              type,
              prompt,
              i,
            );
            this.flushCacheToFile();
          },
        };
      }
    }
    debug('no unused cache found, type: %s, prompt: %s', type, prompt);
    return undefined;
  }

  matchPlanCache(
    prompt: string,
    scope?: CacheScope,
    operationKey?: string,
  ): MatchCacheResult<PlanningCache> | undefined {
    const result = this.matchCache(prompt, 'plan', scope, operationKey) as
      | MatchCacheResult<PlanningCache>
      | undefined;
    if (!result) return undefined;
    // Guard against stale cache files written before the write-side fix
    const yamlWorkflow = result.cacheContent.yamlWorkflow;
    if (!yamlWorkflow?.trim()) {
      debug(
        'plan cache matched but yamlWorkflow is empty, treat as cache miss',
      );
      return {
        ...result,
        cacheUsable: false,
      };
    }
    try {
      const parsed = yaml.load(yamlWorkflow) as any;
      const hasNonEmptyFlow = parsed?.tasks?.some(
        (task: any) => Array.isArray(task.flow) && task.flow.length > 0,
      );
      if (!hasNonEmptyFlow) {
        debug('plan cache matched but flow is empty, treat as cache miss');
        return {
          ...result,
          cacheUsable: false,
        };
      }
    } catch {
      debug(
        'plan cache matched but yamlWorkflow is invalid, treat as cache miss',
      );
      return {
        ...result,
        cacheUsable: false,
      };
    }
    return result;
  }

  matchLocateCache(
    prompt: TUserPrompt,
    scope?: CacheScope,
    operationKey?: string,
  ): MatchCacheResult<LocateCache> | undefined {
    return this.matchCache(prompt, 'locate', scope, operationKey) as
      | MatchCacheResult<LocateCache>
      | undefined;
  }

  matchOperationCache(
    operationKey: string | undefined,
    scope?: CacheScope,
  ): MatchCacheResult<OperationCache> | undefined {
    if (!operationKey || !this.isCacheResultUsed) {
      return undefined;
    }

    for (let i = 0; i < this.cacheOriginalLength; i++) {
      const item = this.cache.caches[i];
      if (item.type !== 'operation') {
        continue;
      }
      const key = `operation:${operationKey}:${i}`;
      if (
        item.operationKey === operationKey &&
        item.yamlWorkflow?.trim() &&
        !this.matchedCacheIndices.has(key)
      ) {
        const governance = this.evaluateCacheGovernance(item, scope);
        if (!governance.usable) {
          debug(
            'operation cache skipped, key: %s, index: %d, reason: %s',
            operationKey,
            i,
            governance.skipReason,
          );
          continue;
        }
        this.matchedCacheIndices.add(key);
        this.recordCacheHitInMemory(item, governance.scopeMatchDetail);
        debug(
          'operation cache found and marked as used, key: %s, index: %d, scopeMatch: %s',
          operationKey,
          i,
          governance.scopeMatch,
        );
        return {
          cacheContent: item,
          cacheUsable: true,
          scopeMatch: governance.scopeMatch,
          updateFn: (cb: (cache: OperationCache) => void) => {
            cb(item);

            if (this.readOnlyMode) {
              debug(
                'read-only mode, operation cache updated in memory but not flushed to file',
              );
              return;
            }

            this.flushCacheToFile();
          },
        };
      }
    }
    return undefined;
  }

  recordCacheVerification(
    record: CacheRecord | undefined,
    verification: CacheVerificationResult,
  ): void {
    if (!record) {
      return;
    }
    updateCacheVerificationState(record, verification);
    if (this.readOnlyMode) {
      debug('read-only mode, cache verification updated in memory only');
      return;
    }
    this.flushCacheToFile();
  }

  getGovernanceSnapshot(currentScope?: CacheScope): CacheGovernanceSnapshot {
    const records = this.cache.caches.map((record, index) =>
      createCacheGovernanceRecordSnapshot(record, index, currentScope),
    );
    const byType: CacheGovernanceSnapshot['byType'] = {
      plan: 0,
      operation: 0,
      locate: 0,
    };
    const byStatus: CacheGovernanceSnapshot['byStatus'] = {
      active: 0,
      degraded: 0,
      stale: 0,
      disabled: 0,
    };

    for (const record of records) {
      byType[record.type] += 1;
      byStatus[record.governance.status] += 1;
    }

    return {
      cacheId: this.cacheId,
      cacheFilePath: this.cacheFilePath,
      total: records.length,
      byType,
      byStatus,
      records,
    };
  }

  appendCache(cache: CacheRecord) {
    ensureWritableCacheMetadata(cache);
    debug('will append cache', cache);
    this.cache.caches.push(cache);
    this.cacheOriginalLength = this.isCacheResultUsed
      ? this.cache.caches.length
      : 0;

    if (this.readOnlyMode) {
      debug('read-only mode, cache appended to memory but not flushed to file');
      return;
    }

    this.flushCacheToFile();
  }

  getFlowMacro(name: string): FlowMacro | undefined {
    if (!this.isCacheResultUsed) {
      return undefined;
    }
    return this.cache.flowMacros?.find((macro) => macro.name === name);
  }

  upsertFlowMacro(macro: FlowMacro): void {
    if (!macro.name?.trim()) {
      throw new Error('Flow macro name is required');
    }
    if (!Array.isArray(macro.flow) || macro.flow.length === 0) {
      throw new Error(`Flow macro "${macro.name}" requires a non-empty flow`);
    }

    const flowMacros = this.cache.flowMacros ?? [];
    const index = flowMacros.findIndex((item) => item.name === macro.name);
    if (index >= 0) {
      flowMacros[index] = macro;
    } else {
      flowMacros.push(macro);
    }
    this.cache.flowMacros = flowMacros;
    this.flushCacheForExperienceWrite();
  }

  getExperienceGraph(): PageExperienceGraph {
    return this.experienceGraph;
  }

  recordPathExperience(input: PathExperienceInput) {
    const edge = this.experienceGraph.recordPath(input);
    this.cache.experience = this.experienceGraph.toJSON();
    this.flushCacheForExperienceWrite();
    return edge;
  }

  degradePathExperience(
    edgeId: string,
    options?: PathExperienceDemotionOptions,
  ) {
    const edge = this.experienceGraph.degradePath(edgeId, options);
    this.cache.experience = this.experienceGraph.toJSON();
    this.flushCacheForExperienceWrite();
    return edge;
  }

  loadCacheFromFile() {
    const cacheFile = this.cacheFilePath;
    assert(cacheFile, 'cache file path is required');

    if (!existsSync(cacheFile)) {
      debug('no cache file found, path: %s', cacheFile);
      return undefined;
    }

    // detect old cache file
    const jsonTypeCacheFile = cacheFile.replace(cacheFileExt, '.json');
    if (existsSync(jsonTypeCacheFile) && this.isCacheResultUsed) {
      console.warn(
        `An outdated cache file from an earlier version of Midscene has been detected. Since version 0.17, we have implemented an improved caching strategy. Please delete the old file located at: ${jsonTypeCacheFile}.`,
      );
      return undefined;
    }

    try {
      const data = readFileSync(cacheFile, 'utf8');
      const jsonData = yaml.load(data) as CacheFileContent;

      const version = getMidsceneVersion();
      if (!version) {
        debug('no midscene version info, will not read cache from file');
        return undefined;
      }

      if (
        semver.lt(jsonData.midsceneVersion, lowestSupportedMidsceneVersion) &&
        !jsonData.midsceneVersion.includes('beta') // for internal test
      ) {
        console.warn(
          `You are using an old version of Midscene cache file, and we cannot match any info from it. Starting from Midscene v0.17, we changed our strategy to use xpath for cache info, providing better performance.\nPlease delete the existing cache and rebuild it. Sorry for the inconvenience.\ncache file: ${cacheFile}`,
        );
        return undefined;
      }

      debug(
        'cache loaded from file, path: %s, cache version: %s, record length: %s',
        cacheFile,
        jsonData.midsceneVersion,
        jsonData.caches.length,
      );
      jsonData.midsceneVersion = getMidsceneVersion(); // update the version
      return jsonData;
    } catch (err) {
      debug(
        'cache file exists but load failed, path: %s, error: %s',
        cacheFile,
        err,
      );
      return undefined;
    }
  }

  flushCacheToFile(options?: { cleanUnused?: boolean }) {
    const version = getMidsceneVersion();
    if (!version) {
      debug('no midscene version info, will not write cache to file');
      return;
    }

    if (!this.cacheFilePath) {
      debug('no cache file path, will not write cache to file');
      return;
    }

    // Clean unused caches if requested
    if (options?.cleanUnused) {
      // Skip cleaning in write-only mode or when cache is not used
      if (this.isCacheResultUsed) {
        const originalLength = this.cache.caches.length;

        // Collect indices of used caches
        const usedIndices = new Set<number>();
        for (const key of this.matchedCacheIndices) {
          // key format: "type:prompt:index"
          const parts = key.split(':');
          const index = Number.parseInt(parts[parts.length - 1], 10);
          if (!Number.isNaN(index)) {
            usedIndices.add(index);
          }
        }

        // Filter: keep used caches and newly added caches
        this.cache.caches = this.cache.caches.filter((_, index) => {
          const isUsed = usedIndices.has(index);
          const isNew = index >= this.cacheOriginalLength;
          return isUsed || isNew;
        });

        const removedCount = originalLength - this.cache.caches.length;
        if (removedCount > 0) {
          debug('cleaned %d unused cache record(s)', removedCount);
        } else {
          debug('no unused cache to clean');
        }
      } else {
        debug('skip cleaning: cache is not used for reading');
      }
    }

    try {
      const dir = dirname(this.cacheFilePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        debug('created cache directory: %s', dir);
      }

      const dedupedCaches = dedupeEquivalentLocateCaches(this.cache.caches);
      const dedupedCount = this.cache.caches.length - dedupedCaches.length;
      if (dedupedCount > 0) {
        debug('deduped %d equivalent locate cache record(s)', dedupedCount);
        this.cache.caches = dedupedCaches;
        this.cacheOriginalLength = this.isCacheResultUsed
          ? this.cache.caches.length
          : 0;
      }

      // Sort caches to ensure plan entries come before locate entries for better readability
      // Create a sorted copy for writing to disk while keeping in-memory order unchanged
      const sortedCaches = [...this.cache.caches].sort((a, b) => {
        return cacheRecordSortOrder(a.type) - cacheRecordSortOrder(b.type);
      });

      const cacheToWrite = {
        ...this.cache,
        experience: this.experienceGraph.toJSON(),
        caches: sortedCaches,
      };

      const yamlData = yaml.dump(cacheToWrite, { lineWidth: -1 });
      writeFileSync(this.cacheFilePath, yamlData);
      debug('cache flushed to file: %s', this.cacheFilePath);
    } catch (err) {
      debug(
        'write cache to file failed, path: %s, error: %s',
        this.cacheFilePath,
        err,
      );
    }
  }

  private flushCacheForExperienceWrite(): void {
    if (this.readOnlyMode) {
      debug('read-only mode, experience updated in memory only');
      return;
    }
    this.flushCacheToFile();
  }

  updateOrAppendCacheRecord(
    newRecord: CacheRecord,
    cachedRecord?: AnyMatchCacheResult,
  ) {
    ensureWritableCacheMetadata(newRecord);
    if (cachedRecord) {
      // update existing record
      if (newRecord.type === 'plan') {
        cachedRecord.updateFn((cache) => {
          const planCache = cache as PlanningCache;
          planCache.yamlWorkflow = newRecord.yamlWorkflow;
          planCache.scope = newRecord.scope ?? planCache.scope;
          planCache.state = newRecord.state ?? planCache.state;
          planCache.operationKey =
            newRecord.operationKey ?? planCache.operationKey;
          planCache.operation = newRecord.operation ?? planCache.operation;
        });
      } else if (newRecord.type === 'operation') {
        cachedRecord.updateFn((cache) => {
          const operationCache = cache as OperationCache;
          operationCache.prompt = newRecord.prompt;
          operationCache.operation = newRecord.operation;
          operationCache.operationKey = newRecord.operationKey;
          operationCache.yamlWorkflow = newRecord.yamlWorkflow;
          operationCache.scope = newRecord.scope ?? operationCache.scope;
          operationCache.state = newRecord.state ?? operationCache.state;
        });
      } else {
        cachedRecord.updateFn((cache) => {
          const locateCache = cache as LocateCache;
          locateCache.cache = newRecord.cache;
          locateCache.operation = newRecord.operation ?? locateCache.operation;
          locateCache.operationKey =
            newRecord.operationKey ?? locateCache.operationKey;
          locateCache.operationSignature =
            newRecord.operationSignature ?? locateCache.operationSignature;
          locateCache.scope = newRecord.scope ?? locateCache.scope;
          locateCache.state = newRecord.state ?? locateCache.state;
          if ('xpaths' in locateCache) {
            locateCache.xpaths = undefined;
          }
        });
      }
    } else {
      const equivalentRecord = this.findEquivalentCacheRecord(newRecord);
      if (equivalentRecord) {
        debug('equivalent cache record found, update instead of append');
        this.updateOrAppendCacheRecord(newRecord, equivalentRecord);
        return;
      }
      this.appendCache(newRecord);
    }
  }

  private findEquivalentCacheRecord(
    newRecord: CacheRecord,
  ): MatchCacheResult<CacheRecord> | undefined {
    for (let i = 0; i < this.cache.caches.length; i++) {
      const item = this.cache.caches[i];
      if (item.type !== newRecord.type) {
        continue;
      }
      if (!isDeepStrictEqual(item.prompt, newRecord.prompt)) {
        if (
          item.type !== 'operation' ||
          newRecord.type !== 'operation' ||
          item.operationKey !== newRecord.operationKey
        ) {
          continue;
        }
      }
      if (
        item.type === 'operation' &&
        newRecord.type === 'operation' &&
        item.operationKey === newRecord.operationKey &&
        matchCacheScope(item.scope, newRecord.scope) !== 'mismatch'
      ) {
        return this.createCacheMatchResult(item, newRecord.type, i);
      }
      if (!isDeepStrictEqual(item.prompt, newRecord.prompt)) {
        continue;
      }
      if (
        item.type === 'plan' &&
        newRecord.type === 'plan' &&
        matchCacheScope(item.scope, newRecord.scope) !== 'mismatch'
      ) {
        return this.createCacheMatchResult(item, newRecord.type, i);
      }
      if (
        item.type === 'locate' &&
        newRecord.type === 'locate' &&
        areLocateCachesEquivalent(item, newRecord)
      ) {
        return this.createCacheMatchResult(item, newRecord.type, i);
      }
    }
    return undefined;
  }

  private createCacheMatchResult<T extends CacheRecord>(
    item: T,
    type: T['type'],
    index: number,
  ): MatchCacheResult<T> {
    return {
      cacheContent: item,
      cacheUsable: true,
      scopeMatch: 'exact',
      updateFn: (cb: (cache: T) => void) => {
        cb(item);

        if (this.readOnlyMode) {
          debug(
            'read-only mode, equivalent cache updated in memory but not flushed to file',
          );
          return;
        }

        debug(
          'equivalent cache updated, will flush to file, type: %s, index: %d',
          type,
          index,
        );
        this.flushCacheToFile();
      },
    };
  }

  private evaluateCacheGovernance(
    record: CacheRecord,
    currentScope?: CacheScope,
  ): {
    usable: boolean;
    scopeMatch: CacheScopeMatch;
    scopeMatchDetail: CacheScopeMatchDetail;
    skipReason?: string;
  } {
    const scopeMatchDetail = describeCacheScopeMatch(
      record.scope,
      currentScope,
    );
    const governance = resolveCacheGovernance(record, scopeMatchDetail);
    if (!governance.usable) {
      const shouldDemote =
        scopeMatchDetail.result === 'mismatch' &&
        shouldDemoteForScopeDrift(record.scope, currentScope, scopeMatchDetail);
      this.recordCacheSkipInMemory(
        record,
        governance.reason ?? 'cache skipped by governance policy',
        scopeMatchDetail,
        {
          demote: shouldDemote,
          refreshRecommended: governance.recommendation === 'refresh',
        },
      );
    }

    return {
      usable: governance.usable,
      scopeMatch: scopeMatchDetail.result,
      scopeMatchDetail,
      skipReason: governance.reason,
    };
  }

  private recordCacheHitInMemory(
    record: CacheRecord,
    scopeMatchDetail?: CacheScopeMatchDetail,
  ): void {
    const now = new Date().toISOString();
    record.stats = {
      ...record.stats,
      hitCount: (record.stats?.hitCount ?? 0) + 1,
      lastHitAt: now,
    };
    record.state ??= {
      status: 'active',
      confidence: 1,
      updatedAt: now,
    };
    record.state = {
      ...record.state,
      lastScopeMatch: scopeMatchDetail?.result ?? record.state.lastScopeMatch,
      updatedAt: now,
    };
  }

  private recordCacheSkipInMemory(
    record: CacheRecord,
    reason: string,
    scopeMatchDetail: CacheScopeMatchDetail,
    options?: { demote?: boolean; refreshRecommended?: boolean },
  ): void {
    const now = new Date().toISOString();
    record.stats = {
      ...record.stats,
      skipCount: (record.stats?.skipCount ?? 0) + 1,
      lastSkipAt: now,
    };

    const currentState = record.state ?? {
      status: 'active' as const,
      confidence: 1,
    };
    const currentStatus = currentState.status ?? 'active';
    const demotedStatus =
      currentStatus === 'disabled' || currentStatus === 'stale'
        ? currentStatus
        : 'degraded';
    const nextConfidence = options?.demote
      ? Math.max(0, (currentState.confidence ?? 1) - 0.15)
      : (currentState.confidence ?? 1);
    const shouldPersistReason =
      Boolean(options?.demote) || Boolean(options?.refreshRecommended);

    record.state = {
      ...currentState,
      status: options?.demote ? demotedStatus : currentStatus,
      confidence: nextConfidence,
      reason: shouldPersistReason ? reason : currentState.reason,
      lastSkipReason: reason,
      lastScopeMatch: scopeMatchDetail.result,
      refreshRecommended:
        currentState.refreshRecommended ||
        Boolean(options?.demote) ||
        Boolean(options?.refreshRecommended),
      demotedAt: options?.demote ? now : currentState.demotedAt,
      updatedAt: now,
    };
  }
}

function normalizeLocateCache(record: LocateCache): LocateCache {
  const cache =
    record.cache || (record.xpaths ? { xpaths: record.xpaths } : {});
  return {
    type: 'locate',
    prompt: record.prompt,
    operation: record.operation,
    operationKey: record.operationKey,
    operationSignature: record.operationSignature,
    scope: record.scope,
    cache,
  };
}

function areLocateCachesEquivalent(
  current: LocateCache,
  incoming: LocateCache,
): boolean {
  const normalizedCurrent = normalizeLocateCache(current);
  const normalizedIncoming = normalizeLocateCache(incoming);
  if (!isDeepStrictEqual(normalizedCurrent.cache, normalizedIncoming.cache)) {
    return false;
  }
  if (
    normalizedCurrent.operationKey &&
    normalizedIncoming.operationKey &&
    normalizedCurrent.operationKey !== normalizedIncoming.operationKey
  ) {
    return false;
  }
  if (
    normalizedCurrent.operation &&
    normalizedIncoming.operation &&
    normalizedCurrent.operation !== normalizedIncoming.operation
  ) {
    return false;
  }
  return (
    matchCacheScope(normalizedCurrent.scope, normalizedIncoming.scope) !==
    'mismatch'
  );
}

function dedupeEquivalentLocateCaches(caches: CacheRecord[]): CacheRecord[] {
  const deduped: CacheRecord[] = [];

  for (const cache of caches) {
    if (cache.type !== 'locate') {
      deduped.push(cache);
      continue;
    }

    const existingIndex = deduped.findIndex(
      (item) =>
        item.type === 'locate' &&
        isDeepStrictEqual(item.prompt, cache.prompt) &&
        areLocateCachesEquivalent(item, cache),
    );

    if (existingIndex >= 0) {
      deduped[existingIndex] = cache;
    } else {
      deduped.push(cache);
    }
  }

  return deduped;
}

function cacheRecordSortOrder(type: CacheRecord['type']): number {
  if (type === 'plan') return 0;
  if (type === 'operation') return 1;
  return 2;
}

function ensureWritableCacheMetadata(record: CacheRecord): void {
  const now = new Date().toISOString();
  record.state ??= {
    status: 'active',
    confidence: 1,
    updatedAt: now,
  };
}

function updateCacheVerificationState(
  record: CacheRecord,
  verification: CacheVerificationResult,
): void {
  const now = new Date().toISOString();
  const currentStats = record.stats ?? {};
  const lastVerification: CacheVerificationRecord = {
    ...verification,
    at: now,
  };

  if (verification.status === 'success') {
    const confidence = Math.min(1, (record.state?.confidence ?? 0.95) + 0.05);
    record.stats = {
      ...currentStats,
      successCount: (currentStats.successCount ?? 0) + 1,
      lastSuccessAt: now,
    };
    record.state = {
      ...record.state,
      status: 'active',
      confidence,
      reason: undefined,
      refreshRecommended: false,
      updatedAt: now,
    };
    record.lastVerification = lastVerification;
    return;
  }

  const failureCount = (currentStats.failureCount ?? 0) + 1;
  const confidence = Math.max(0, (record.state?.confidence ?? 1) - 0.25);
  record.stats = {
    ...currentStats,
    failureCount,
    lastFailureAt: now,
  };
  record.state = {
    ...record.state,
    status: failureCount >= CACHE_FAILURES_BEFORE_STALE ? 'stale' : 'degraded',
    confidence,
    reason: verification.reason,
    refreshRecommended: true,
    demotedAt: now,
    updatedAt: now,
  };
  record.lastVerification = lastVerification;
}

function cacheIdentityMatches(
  item: PlanningCache | LocateCache,
  prompt: TUserPrompt,
  operationKey?: string,
): boolean {
  const itemOperationKey = item.operationKey;
  if (operationKey && itemOperationKey && itemOperationKey !== operationKey) {
    return false;
  }
  return (
    isDeepStrictEqual(item.prompt, prompt) ||
    Boolean(operationKey && itemOperationKey === operationKey)
  );
}

function valueToComparableString(value: unknown): string {
  return String(value).trim();
}

function hasComparableScopeValue(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    Boolean(valueToComparableString(value))
  );
}

function scopeValuesEqual(
  cachedScope: CacheScope | undefined,
  currentScope: CacheScope | undefined,
  key: keyof CacheScope,
): boolean {
  const cachedValue = cachedScope?.[key];
  const currentValue = currentScope?.[key];
  if (
    !hasComparableScopeValue(cachedValue) ||
    !hasComparableScopeValue(currentValue)
  ) {
    return false;
  }
  return (
    valueToComparableString(cachedValue) ===
    valueToComparableString(currentValue)
  );
}

function shouldDemoteForScopeDrift(
  cachedScope: CacheScope | undefined,
  currentScope: CacheScope | undefined,
  detail: CacheScopeMatchDetail,
): boolean {
  if (detail.driftKeys.length === 0) {
    return false;
  }
  const ownerKeys: Array<keyof CacheScope> = [
    'interfaceType',
    'packageName',
    'activity',
    'url',
  ];
  const hasOwnerMismatch = ownerKeys.some((key) =>
    detail.mismatchedKeys.includes(key),
  );
  if (hasOwnerMismatch) {
    return false;
  }
  return ownerKeys.some((key) =>
    scopeValuesEqual(cachedScope, currentScope, key),
  );
}

function normalizeCacheEntryState(record: CacheRecord): CacheEntryState {
  return {
    status: record.state?.status ?? 'active',
    confidence: record.state?.confidence ?? 1,
    reason: record.state?.reason,
    lastSkipReason: record.state?.lastSkipReason,
    lastScopeMatch: record.state?.lastScopeMatch,
    refreshRecommended: record.state?.refreshRecommended ?? false,
    demotedAt: record.state?.demotedAt,
    updatedAt: record.state?.updatedAt,
  };
}

function resolveCacheGovernance(
  record: CacheRecord,
  scopeMatchDetail?: CacheScopeMatchDetail,
): {
  usable: boolean;
  recommendation: CacheGovernanceRecommendation;
  confidence: number;
  status: NonNullable<CacheEntryState['status']>;
  refreshRecommended: boolean;
  reason?: string;
} {
  const state = normalizeCacheEntryState(record);
  const status = state.status ?? 'active';
  const confidence = state.confidence ?? 1;
  const refreshRecommended = state.refreshRecommended ?? false;

  if (status === 'disabled') {
    return {
      usable: false,
      recommendation: 'disabled',
      confidence,
      status,
      refreshRecommended,
      reason: state.reason ?? 'cache entry is disabled',
    };
  }

  if (status === 'stale') {
    return {
      usable: false,
      recommendation: 'refresh',
      confidence,
      status,
      refreshRecommended: true,
      reason: state.reason ?? 'cache entry is stale',
    };
  }

  if (confidence < CACHE_MIN_CONFIDENCE_TO_MATCH) {
    return {
      usable: false,
      recommendation: 'refresh',
      confidence,
      status,
      refreshRecommended: true,
      reason: `cache confidence ${confidence.toFixed(2)} is below ${CACHE_MIN_CONFIDENCE_TO_MATCH.toFixed(2)}`,
    };
  }

  if (scopeMatchDetail?.result === 'mismatch') {
    return {
      usable: false,
      recommendation:
        scopeMatchDetail.driftKeys.length > 0 ? 'refresh' : 'skip',
      confidence,
      status,
      refreshRecommended:
        refreshRecommended || scopeMatchDetail.driftKeys.length > 0,
      reason:
        scopeMatchDetail.reason ??
        `cache scope mismatch: ${scopeMatchDetail.mismatchedKeys.join(', ')}`,
    };
  }

  if (
    scopeMatchDetail?.result === 'unknown' ||
    scopeMatchDetail?.result === 'compatible'
  ) {
    return {
      usable: true,
      recommendation: refreshRecommended ? 'refresh' : 'verify',
      confidence,
      status,
      refreshRecommended,
      reason: state.reason,
    };
  }

  return {
    usable: true,
    recommendation: refreshRecommended ? 'refresh' : 'use',
    confidence,
    status,
    refreshRecommended,
    reason: state.reason,
  };
}

function createCacheGovernanceRecordSnapshot(
  record: CacheRecord,
  index: number,
  currentScope?: CacheScope,
): CacheGovernanceRecordSnapshot {
  const scopeMatch = currentScope
    ? describeCacheScopeMatch(record.scope, currentScope)
    : undefined;
  const governance = resolveCacheGovernance(record, scopeMatch);
  return {
    index,
    type: record.type,
    prompt: 'prompt' in record ? record.prompt : undefined,
    operationKey: record.operationKey,
    scope: record.scope,
    state: normalizeCacheEntryState(record),
    stats: record.stats ?? {},
    lastVerification: record.lastVerification,
    scopeMatch,
    governance,
  };
}

export function matchCacheScope(
  cachedScope?: CacheScope,
  currentScope?: CacheScope,
): CacheScopeMatch {
  return describeCacheScopeMatch(cachedScope, currentScope).result;
}

export function describeCacheScopeMatch(
  cachedScope?: CacheScope,
  currentScope?: CacheScope,
): CacheScopeMatchDetail {
  const comparedKeys: Array<keyof CacheScope> = [];
  const missingCurrentKeys: Array<keyof CacheScope> = [];
  const mismatchedKeys: Array<keyof CacheScope> = [];

  if (!cachedScope || !currentScope) {
    return {
      result: 'unknown',
      comparedKeys,
      missingCurrentKeys,
      mismatchedKeys,
      driftKeys: [],
      reason: 'cached or current cache scope is missing',
    };
  }

  for (const key of CACHE_SCOPE_KEYS) {
    const cachedValue = cachedScope[key];
    if (!hasComparableScopeValue(cachedValue)) {
      continue;
    }

    const currentValue = currentScope[key];
    if (!hasComparableScopeValue(currentValue)) {
      missingCurrentKeys.push(key);
      continue;
    }

    comparedKeys.push(key);
    if (
      valueToComparableString(cachedValue) !==
      valueToComparableString(currentValue)
    ) {
      mismatchedKeys.push(key);
    }
  }

  const driftKeys = mismatchedKeys.filter((key) =>
    CACHE_SCOPE_INVALIDATION_KEYS.includes(key),
  );

  if (mismatchedKeys.length > 0) {
    return {
      result: 'mismatch',
      comparedKeys,
      missingCurrentKeys,
      mismatchedKeys,
      driftKeys,
      reason: `cache scope mismatch: ${mismatchedKeys.join(', ')}`,
    };
  }

  if (comparedKeys.length === 0) {
    return {
      result: 'unknown',
      comparedKeys,
      missingCurrentKeys,
      mismatchedKeys,
      driftKeys,
      reason: 'no comparable cache scope keys',
    };
  }

  if (missingCurrentKeys.length > 0) {
    return {
      result: 'compatible',
      comparedKeys,
      missingCurrentKeys,
      mismatchedKeys,
      driftKeys,
      reason: `current cache scope is missing: ${missingCurrentKeys.join(', ')}`,
    };
  }

  return {
    result: 'exact',
    comparedKeys,
    missingCurrentKeys,
    mismatchedKeys,
    driftKeys,
  };
}
