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
});
