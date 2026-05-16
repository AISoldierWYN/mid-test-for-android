import { TaskCache, describeCacheScopeMatch } from '@/agent';
import { uuid } from '@midscene/shared/utils';
import { describe, expect, it } from 'vitest';

function getTaskCacheInternal(taskCache: TaskCache) {
  return taskCache as unknown as {
    cache: { caches: any[] };
    cacheOriginalLength: number;
  };
}

describe('TaskCache locate cache reuse and dedupe', () => {
  it('updates an equivalent locate cache record instead of appending duplicates', () => {
    const taskCache = new TaskCache(uuid(), true);
    const locateRecord = {
      type: 'locate' as const,
      prompt: 'WLAN option',
      cache: {
        xpaths: ['/hierarchy/node[1]/node[1]/node[1]/node[3]/node[3]/node[2]'],
        android: {
          nodeHashId: '7aa97fc88106929b',
          resourceId: 'android:id/summary',
          text: 'wxy',
          className: 'android.widget.TextView',
          packageName: 'com.android.settings',
          bounds: { left: 128, top: 420, width: 191, height: 19 },
          targetDescription: 'WLAN option',
        },
      },
    };

    taskCache.updateOrAppendCacheRecord(locateRecord);
    taskCache.updateOrAppendCacheRecord({ ...locateRecord });
    taskCache.updateOrAppendCacheRecord({ ...locateRecord });

    const internal = getTaskCacheInternal(taskCache);
    expect(internal.cache.caches).toHaveLength(1);
    expect(internal.cache.caches[0]).toMatchObject(locateRecord);
  });

  it('can reuse newly written locate cache records across playground actions', () => {
    const taskCache = new TaskCache(uuid(), true);

    taskCache.updateOrAppendCacheRecord({
      type: 'locate',
      prompt: 'WLAN option',
      cache: {
        xpaths: ['/hierarchy/node[1]'],
      },
    });

    taskCache.resetMatchedCacheUsage();
    const firstMatch = taskCache.matchLocateCache('WLAN option');
    expect(firstMatch).toBeDefined();

    const consumedInSameCycle = taskCache.matchLocateCache('WLAN option');
    expect(consumedInSameCycle).toBeUndefined();

    taskCache.resetMatchedCacheUsage();
    const nextPlaygroundActionMatch = taskCache.matchLocateCache('WLAN option');
    expect(nextPlaygroundActionMatch).toBeDefined();
  });

  it('dedupes equivalent locate cache records when flushing', () => {
    const taskCache = new TaskCache(uuid(), true);
    const internal = getTaskCacheInternal(taskCache);
    internal.cache.caches.push(
      {
        type: 'locate',
        prompt: 'WLAN option',
        cache: {
          xpaths: ['/hierarchy/node[1]'],
        },
      },
      {
        type: 'locate',
        prompt: 'WLAN option',
        cache: {
          xpaths: ['/hierarchy/node[1]'],
        },
      },
      {
        type: 'locate',
        prompt: 'Bluetooth option',
        cache: {
          xpaths: ['/hierarchy/node[2]'],
        },
      },
    );

    taskCache.flushCacheToFile();

    expect(internal.cache.caches).toHaveLength(2);
    expect(
      internal.cache.caches.filter((item) => item.prompt === 'WLAN option'),
    ).toHaveLength(1);
  });

  it('skips scoped cache records when the current page scope mismatches', () => {
    const taskCache = new TaskCache(uuid(), true);
    const internal = getTaskCacheInternal(taskCache);
    internal.cache.caches.push({
      type: 'locate',
      prompt: 'WLAN option',
      operation: 'tap',
      operationKey: 'type=tap|target=wlan option|gesture=tap',
      scope: {
        interfaceType: 'android',
        packageName: 'com.android.settings',
        activity: '.Settings',
        pageFingerprint: 'settings-home',
      },
      cache: {
        xpaths: ['/hierarchy/node[1]'],
      },
    });
    internal.cacheOriginalLength = 1;

    const mismatch = taskCache.matchLocateCache('WLAN option', {
      interfaceType: 'android',
      packageName: 'com.demo.app',
      activity: '.MainActivity',
      pageFingerprint: 'demo-home',
    });
    expect(mismatch).toBeUndefined();

    const match = taskCache.matchLocateCache('WLAN option', {
      interfaceType: 'android',
      packageName: 'com.android.settings',
      activity: '.Settings',
      pageFingerprint: 'settings-home',
    });
    expect(match).toBeDefined();
    expect(match?.scopeMatch).toBe('exact');
  });

  it('matches operation cache by canonical key across equivalent prompts', () => {
    const taskCache = new TaskCache(uuid(), true);
    const internal = getTaskCacheInternal(taskCache);
    internal.cache.caches.push({
      type: 'operation',
      prompt: '点击 WLAN 选项',
      operationKey: 'type=tap|target=wlan 选项|gesture=tap',
      operation: {
        version: 1,
        source: 'deterministic-parser',
        key: 'type=tap|target=wlan 选项|gesture=tap',
        summary: 'tap wlan 选项',
        operations: [
          {
            type: 'tap',
            target: 'wlan 选项',
            gesture: 'tap',
          },
        ],
      },
      scope: {
        interfaceType: 'android',
        packageName: 'com.android.settings',
      },
      yamlWorkflow:
        'tasks:\n  - name: 点击 WLAN 选项\n    flow:\n      - Tap: ""\n        locate:\n          prompt: WLAN 选项\n',
    });
    internal.cacheOriginalLength = 1;

    const match = taskCache.matchOperationCache(
      'type=tap|target=wlan 选项|gesture=tap',
      {
        interfaceType: 'android',
        packageName: 'com.android.settings',
      },
    );

    expect(match).toBeDefined();
    expect(match?.cacheContent.prompt).toBe('点击 WLAN 选项');
    expect(match?.cacheContent.operation.summary).toBe('tap wlan 选项');
  });

  it('records cache verification and degrades stale entries safely', () => {
    const taskCache = new TaskCache(uuid(), true);
    const locateRecord = {
      type: 'locate' as const,
      prompt: 'Submit button',
      operation: 'tap',
      cache: {
        xpaths: ['/hierarchy/node[1]'],
      },
    };

    taskCache.updateOrAppendCacheRecord(locateRecord);
    const internal = getTaskCacheInternal(taskCache);
    const cachedRecord = internal.cache.caches[0];

    taskCache.recordCacheVerification(cachedRecord, {
      status: 'failure',
      source: 'rectMatchesCacheFeature',
      reason: 'not found',
    });

    expect(cachedRecord.stats?.failureCount).toBe(1);
    expect(cachedRecord.state?.status).toBe('degraded');
    expect(cachedRecord.lastVerification).toMatchObject({
      status: 'failure',
      source: 'rectMatchesCacheFeature',
      reason: 'not found',
    });

    taskCache.recordCacheVerification(cachedRecord, {
      status: 'success',
      source: 'rectMatchesCacheFeature',
    });

    expect(cachedRecord.stats?.successCount).toBe(1);
    expect(cachedRecord.state?.status).toBe('active');
    expect(cachedRecord.lastVerification?.status).toBe('success');
  });

  it('invalidates page and app-version drift before cache match', () => {
    const taskCache = new TaskCache(uuid(), true);
    const internal = getTaskCacheInternal(taskCache);
    internal.cache.caches.push({
      type: 'locate',
      prompt: 'WLAN option',
      operation: 'tap',
      scope: {
        interfaceType: 'android',
        packageName: 'com.android.settings',
        activity: '.Settings',
        pageFingerprint: 'settings-home-v1',
        appVersion: '1',
      },
      cache: {
        xpaths: ['/hierarchy/node[1]'],
      },
    });
    internal.cacheOriginalLength = 1;

    const currentScope = {
      interfaceType: 'android',
      packageName: 'com.android.settings',
      activity: '.Settings',
      pageFingerprint: 'settings-home-v2',
      appVersion: '2',
    };

    const match = taskCache.matchLocateCache('WLAN option', currentScope);
    const cachedRecord = internal.cache.caches[0];
    const snapshot = taskCache.getGovernanceSnapshot(currentScope);

    expect(match).toBeUndefined();
    expect(cachedRecord.stats?.skipCount).toBe(1);
    expect(cachedRecord.state?.status).toBe('degraded');
    expect(cachedRecord.state?.refreshRecommended).toBe(true);
    expect(cachedRecord.state?.lastScopeMatch).toBe('mismatch');
    expect(cachedRecord.state?.confidence).toBeLessThan(1);
    expect(snapshot.records[0].scopeMatch?.driftKeys).toEqual([
      'pageFingerprint',
      'appVersion',
    ]);
    expect(snapshot.records[0].governance.usable).toBe(false);
    expect(snapshot.records[0].governance.recommendation).toBe('refresh');
  });

  it('does not demote reusable prompts that only mismatch by app owner', () => {
    const taskCache = new TaskCache(uuid(), true);
    const internal = getTaskCacheInternal(taskCache);
    internal.cache.caches.push({
      type: 'locate',
      prompt: 'Submit button',
      scope: {
        interfaceType: 'android',
        packageName: 'com.demo.old',
        pageFingerprint: 'form',
      },
      state: {
        status: 'active',
        confidence: 1,
      },
      cache: {
        xpaths: ['/hierarchy/node[1]'],
      },
    });
    internal.cacheOriginalLength = 1;

    const match = taskCache.matchLocateCache('Submit button', {
      interfaceType: 'android',
      packageName: 'com.demo.new',
      pageFingerprint: 'form',
    });
    const cachedRecord = internal.cache.caches[0];

    expect(match).toBeUndefined();
    expect(cachedRecord.stats?.skipCount).toBe(1);
    expect(cachedRecord.state?.status).toBe('active');
    expect(cachedRecord.state?.confidence).toBe(1);
    expect(cachedRecord.state?.lastSkipReason).toContain('packageName');
    expect(cachedRecord.state?.refreshRecommended).toBe(false);
  });

  it('skips low-confidence cache entries and exposes inspector counters', () => {
    const taskCache = new TaskCache(uuid(), true);
    const internal = getTaskCacheInternal(taskCache);
    internal.cache.caches.push({
      type: 'operation',
      prompt: 'tap WLAN option',
      operationKey: 'type=tap|target=wlan option|gesture=tap',
      operation: {
        version: 1,
        source: 'deterministic-parser',
        key: 'type=tap|target=wlan option|gesture=tap',
        summary: 'tap wlan option',
        operations: [
          {
            type: 'tap',
            target: 'wlan option',
            gesture: 'tap',
          },
        ],
      },
      yamlWorkflow:
        'tasks:\n  - name: tap WLAN option\n    flow:\n      - Tap: ""\n        locate:\n          prompt: WLAN option\n',
      state: {
        status: 'degraded',
        confidence: 0.1,
      },
      scope: {
        interfaceType: 'android',
        packageName: 'com.android.settings',
      },
    });
    internal.cacheOriginalLength = 1;

    const match = taskCache.matchOperationCache(
      'type=tap|target=wlan option|gesture=tap',
      {
        interfaceType: 'android',
        packageName: 'com.android.settings',
      },
    );
    const snapshot = taskCache.getGovernanceSnapshot({
      interfaceType: 'android',
      packageName: 'com.android.settings',
    });

    expect(match).toBeUndefined();
    expect(snapshot.byType.operation).toBe(1);
    expect(snapshot.byStatus.degraded).toBe(1);
    expect(snapshot.records[0].stats.skipCount).toBe(1);
    expect(snapshot.records[0].governance.usable).toBe(false);
    expect(snapshot.records[0].governance.recommendation).toBe('refresh');
    expect(snapshot.records[0].state.refreshRecommended).toBe(true);
  });

  it('describes cache scope matches for inspector surfaces', () => {
    const detail = describeCacheScopeMatch(
      {
        interfaceType: 'android',
        packageName: 'com.android.settings',
        pageFingerprint: 'settings-home',
        appVersion: '1',
      },
      {
        interfaceType: 'android',
        packageName: 'com.android.settings',
        pageFingerprint: 'settings-network',
      },
    );

    expect(detail.result).toBe('mismatch');
    expect(detail.comparedKeys).toEqual([
      'interfaceType',
      'packageName',
      'pageFingerprint',
    ]);
    expect(detail.missingCurrentKeys).toEqual(['appVersion']);
    expect(detail.mismatchedKeys).toEqual(['pageFingerprint']);
    expect(detail.driftKeys).toEqual(['pageFingerprint']);
  });
});
