import {
  PageExperienceGraph,
  buildCompactRecoveryEvidence,
  formatCompactRecoveryEvidenceForAI,
  formatExperienceGraphForPlanning,
  normalizeCandidateAdjudicationConfig,
} from '@/agent';
import { describe, expect, it } from 'vitest';

describe('Phase 5 recovery helpers', () => {
  it('normalizes candidate adjudication defaults and disable mode', () => {
    expect(normalizeCandidateAdjudicationConfig()).toMatchObject({
      enabled: true,
      maxCandidates: 5,
      minConfidence: 0.45,
      autoAcceptConfidence: 0.92,
      aiEnabled: true,
    });
    expect(normalizeCandidateAdjudicationConfig(false)).toMatchObject({
      enabled: false,
    });
  });

  it('formats experience graph hints for planning', () => {
    const graph = new PageExperienceGraph();
    graph.recordPath({
      from: 'home',
      to: 'settings',
      action: 'tap',
      intent: 'open settings',
      success: true,
      durationMs: 120,
    });

    const context = formatExperienceGraphForPlanning(graph);
    expect(context).toContain('<experience_graph>');
    expect(context).toContain('home -> settings');
    expect(context).toContain('intent=open settings');
  });

  it('builds compact evidence with runtime issues and candidates', () => {
    const evidence = buildCompactRecoveryEvidence({
      error: new Error('Element not found: confirm button'),
      time: '2026-05-01 12:00:00',
      userInstruction: 'accept permission',
      failedTask: {
        type: 'Planning',
        subType: 'Locate',
        thought: 'find confirm',
        param: { prompt: 'confirm button' },
        status: 'failed',
        taskId: 'task-1',
        executor: async () => undefined,
      } as any,
      runtimeState: {
        summary: 'Detected permission-dialog',
        issues: [
          {
            kind: 'permission-dialog',
            severity: 'warning',
            message: 'Permission dialog is visible',
          },
        ],
      },
      candidates: [
        {
          element: {
            description: 'Allow',
            center: [20, 30],
            rect: { left: 10, top: 20, width: 20, height: 20 },
          },
          confidence: 0.77,
          source: 'android-ui-tree',
          reason: 'text',
        },
      ],
    });

    const prompt = formatCompactRecoveryEvidenceForAI(evidence);
    expect(prompt).toContain('<recovery_evidence>');
    expect(prompt).toContain('permission-dialog');
    expect(prompt).toContain('Allow');
    expect(prompt).not.toContain('base64');
  });
});
