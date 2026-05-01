import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TaskCache, cacheFileExt } from '@/agent';
import { uuid } from '@midscene/shared/utils';
import { afterAll, describe, expect, it } from 'vitest';

const tmpDir = join(process.cwd(), 'tests', '.tmp-phase4');

function cachePath(name: string) {
  mkdirSync(tmpDir, { recursive: true });
  return join(tmpDir, `${name}${cacheFileExt}`);
}

describe('TaskCache experience graph and macros', () => {
  afterAll(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('persists flow macros and page experience graph in cache files', () => {
    const filePath = cachePath(uuid());
    const cache = new TaskCache('phase4-cache', true, filePath);

    cache.upsertFlowMacro({
      name: 'login',
      flow: [{ aiTap: 'login button' }],
      description: 'shared login flow',
    });
    const edge = cache.recordPathExperience({
      from: { fingerprint: 'home', packageName: 'com.demo' },
      to: { fingerprint: 'login' },
      action: 'tap',
      intent: 'open login',
      success: true,
      durationMs: 80,
    });

    const reloaded = new TaskCache('phase4-cache', true, filePath);
    expect(reloaded.getFlowMacro('login')).toMatchObject({
      description: 'shared login flow',
      flow: [{ aiTap: 'login button' }],
    });
    expect(reloaded.getExperienceGraph().getEdge(edge.id)).toMatchObject({
      action: 'tap',
      successRate: 1,
      averageDurationMs: 80,
    });
  });

  it('keeps read-only experience updates in memory without flushing', () => {
    const filePath = cachePath(uuid());
    const cache = new TaskCache('phase4-readonly', true, filePath);
    cache.upsertFlowMacro({
      name: 'home',
      flow: [{ aiTap: 'home tab' }],
    });
    const before = readFileSync(filePath, 'utf8');

    const readOnly = new TaskCache('phase4-readonly', true, filePath, {
      readOnly: true,
    });
    readOnly.upsertFlowMacro({
      name: 'home',
      flow: [{ aiTap: 'changed home tab' }],
    });
    readOnly.recordPathExperience({
      from: 'home',
      to: 'settings',
      action: 'tap',
      success: true,
    });

    expect(readOnly.getFlowMacro('home')?.flow).toEqual([
      { aiTap: 'changed home tab' },
    ]);
    expect(readFileSync(filePath, 'utf8')).toBe(before);
  });

  it('does not read old experience data in write-only mode', () => {
    const filePath = cachePath(uuid());
    const cache = new TaskCache('phase4-writeonly', true, filePath);
    cache.upsertFlowMacro({
      name: 'resetState',
      flow: [{ aiTap: 'reset' }],
    });

    const writeOnly = new TaskCache('phase4-writeonly', true, filePath, {
      writeOnly: true,
    });
    expect(writeOnly.getFlowMacro('resetState')).toBeUndefined();
    writeOnly.upsertFlowMacro({
      name: 'resetState',
      flow: [{ aiTap: 'fresh reset' }],
    });

    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('fresh reset');
    expect(content).not.toContain('aiTap: reset');
  });
});
