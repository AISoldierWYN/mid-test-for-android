import type { AbstractInterface } from '@/device';
import { getDebug } from '@midscene/shared/logger';
import type { CacheScope } from './task-cache';

const debug = getDebug('cache');

function hasScopeValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function pruneScope(scope: CacheScope): CacheScope | undefined {
  const entries = Object.entries(scope).filter(([, value]) =>
    hasScopeValue(value),
  );
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries) as CacheScope;
}

export async function captureCacheScope(
  interfaceInstance: AbstractInterface,
): Promise<CacheScope | undefined> {
  const scope: CacheScope = {
    interfaceType: interfaceInstance.interfaceType,
  };

  if (interfaceInstance.url) {
    try {
      const url = await interfaceInstance.url();
      if (url) {
        scope.url = url;
      }
    } catch (error) {
      debug('failed to capture cache URL scope: %s', error);
    }
  }

  if (interfaceInstance.recoveryState) {
    try {
      const recoveryState = await interfaceInstance.recoveryState();
      const foreground = recoveryState?.foreground;
      if (foreground?.packageName) {
        scope.packageName = foreground.packageName;
      }
      if (foreground?.activity) {
        scope.activity = foreground.activity;
      }
      if (foreground?.pageFingerprint) {
        scope.pageFingerprint = foreground.pageFingerprint;
      }
    } catch (error) {
      debug('failed to capture runtime cache scope: %s', error);
    }
  }

  return pruneScope(scope);
}
