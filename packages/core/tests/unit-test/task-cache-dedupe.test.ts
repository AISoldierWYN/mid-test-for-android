import { TaskCache } from '@/agent';
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
      operation: 'Tap',
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

  it('records cache verification and degrades stale entries safely', () => {
    const taskCache = new TaskCache(uuid(), true);
    const locateRecord = {
      type: 'locate' as const,
      prompt: 'Submit button',
      operation: 'Tap',
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
});
