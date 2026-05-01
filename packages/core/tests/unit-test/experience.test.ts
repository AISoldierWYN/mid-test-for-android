import {
  PageExperienceGraph,
  TestModuleRegistry,
  createFlowMacro,
} from '@/agent';
import { describe, expect, it } from 'vitest';

describe('TestModuleRegistry', () => {
  it('loads modules on demand and resolves macros by priority', () => {
    const registry = new TestModuleRegistry();
    registry
      .register({
        id: 'generic',
        priority: 1,
        load: { interfaceType: 'android' },
        macros: {
          login: createFlowMacro('login', [{ aiTap: 'generic login' }]),
        },
      })
      .register({
        id: 'settings',
        priority: 10,
        load: {
          interfaceType: 'android',
          packageName: 'com.android.settings',
        },
        macros: {
          login: [{ aiTap: 'settings login' }],
          home: [{ aiTap: 'settings home' }],
        },
      });

    const loaded = registry.loadFor({
      interfaceType: 'android',
      packageName: 'com.android.settings',
    });
    expect(loaded.map((module) => module.id)).toEqual(['settings', 'generic']);

    expect(
      registry.resolveMacro('login', {
        interfaceType: 'android',
        packageName: 'com.android.settings',
      }),
    ).toMatchObject({
      moduleId: 'settings',
      flow: [{ aiTap: 'settings login' }],
    });

    expect(
      registry.resolveMacro('generic.login', {
        interfaceType: 'android',
        packageName: 'com.android.settings',
      }),
    ).toMatchObject({
      moduleId: 'generic',
      flow: [{ aiTap: 'generic login' }],
    });
  });

  it('supports tag and regexp load rules', () => {
    const registry = new TestModuleRegistry().register({
      id: 'checkout',
      load: {
        packageName: /^com\.shop\./,
        tags: ['checkout'],
      },
    });

    expect(
      registry.loadFor({
        packageName: 'com.shop.demo',
        tags: ['checkout', 'smoke'],
      }),
    ).toHaveLength(1);
    expect(
      registry.loadFor({
        packageName: 'com.shop.demo',
        tags: ['profile'],
      }),
    ).toHaveLength(0);
  });
});

describe('PageExperienceGraph', () => {
  it('records path success rate, average duration, and best next step', () => {
    const graph = new PageExperienceGraph();
    const first = graph.recordPath({
      from: { fingerprint: 'home', packageName: 'com.demo' },
      to: { fingerprint: 'detail' },
      action: 'tap',
      intent: 'open detail',
      success: true,
      durationMs: 100,
    });
    const second = graph.recordPath({
      from: 'home',
      to: 'detail',
      action: 'tap',
      intent: 'open detail',
      success: false,
      durationMs: 300,
    });

    expect(second.id).toBe(first.id);
    expect(second.attempts).toBe(2);
    expect(second.successes).toBe(1);
    expect(second.failures).toBe(1);
    expect(second.successRate).toBe(0.5);
    expect(second.averageDurationMs).toBe(200);
    expect(graph.bestNextStep('home', 'open detail')?.id).toBe(first.id);
  });

  it('demotes stale path experience and preserves it in snapshots', () => {
    const graph = new PageExperienceGraph();
    const edge = graph.recordPath({
      from: 'home',
      to: 'permission-dialog',
      action: 'tap',
      success: true,
    });

    const degraded = graph.degradePath(edge.id, {
      penalty: 0.3,
      reason: 'guard mismatch',
    });
    expect(degraded.status).toBe('degraded');
    expect(degraded.invalidationReason).toBe('guard mismatch');

    const reloaded = new PageExperienceGraph(graph.toJSON());
    expect(reloaded.getEdge(edge.id)).toMatchObject({
      status: 'degraded',
      invalidationReason: 'guard mismatch',
    });
  });
});
