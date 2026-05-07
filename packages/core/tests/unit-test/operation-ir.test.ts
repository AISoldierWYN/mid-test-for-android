import {
  buildCanonicalOperationFromAction,
  buildOperationIRFromActionPlan,
  buildOperationIRFromPlans,
  buildOperationIRFromYamlFlow,
  parseNaturalLanguageOperation,
} from '@/agent';
import { describe, expect, it } from 'vitest';

const zhTapWlan = '\u70b9\u51fb WLAN \u9009\u9879';
const zhWlanOption = 'wlan \u9009\u9879';
const zhInputUsername = '\u5728\u7528\u6237\u540d\u8f93\u5165 alice';
const zhUsername = '\u7528\u6237\u540d';
const zhInputPassword = '\u5728\u5bc6\u7801\u8f93\u5165 123456';
const zhPassword = '\u5bc6\u7801';

describe('Operation IR', () => {
  it('parses common tap commands into canonical operations', () => {
    const ir = parseNaturalLanguageOperation(zhTapWlan);

    expect(ir).toMatchObject({
      source: 'deterministic-parser',
      key: `type=tap|target=${zhWlanOption}|gesture=tap`,
      operations: [
        {
          type: 'tap',
          target: zhWlanOption,
          gesture: 'tap',
        },
      ],
    });
  });

  it('redacts input values while keeping a value hash in the key', () => {
    const ir = parseNaturalLanguageOperation(zhInputUsername);

    expect(ir?.operations[0]).toMatchObject({
      type: 'input',
      target: zhUsername,
    });
    expect(ir?.operations[0].valueHash).toBeDefined();
    expect(JSON.stringify(ir)).not.toContain('alice');
  });

  it('does not key sensitive input caches by raw or hashed password value', () => {
    const ir = parseNaturalLanguageOperation(zhInputPassword);

    expect(ir?.operations[0]).toMatchObject({
      type: 'input',
      target: zhPassword,
      valueSensitive: true,
    });
    expect(ir?.operations[0].valueHash).toBeUndefined();
    expect(ir?.key).toBe(`type=input|target=${zhPassword}`);
  });

  it('canonicalizes action-space plans for tap, input, and scroll', () => {
    const tapIr = buildOperationIRFromActionPlan('Tap', {
      locate: { prompt: 'WLAN option' },
    });
    const inputIr = buildOperationIRFromActionPlan('Input', {
      locate: { prompt: 'username field' },
      value: 'alice',
      mode: 'replace',
    });
    const scrollIr = buildOperationIRFromActionPlan('Scroll', {
      direction: 'down',
      scrollType: 'singleAction',
    });

    expect(tapIr?.key).toBe('type=tap|target=wlan option|gesture=tap');
    expect(inputIr?.key).toContain('type=input|target=username field');
    expect(inputIr?.key).toContain('value=');
    expect(scrollIr?.key).toBe('type=scroll|direction=down');
  });

  it('builds multi-step operation IR from plans and YAML flow', () => {
    const fromPlans = buildOperationIRFromPlans([
      {
        type: 'Tap',
        param: { locate: { prompt: 'Login' } },
        thought: '',
      },
      {
        type: 'Input',
        param: { locate: { prompt: 'username' }, value: 'alice' },
        thought: '',
      },
    ]);
    const fromYaml = buildOperationIRFromYamlFlow([
      { aiTap: 'Login' },
      { aiInput: 'username', value: 'alice' },
    ]);

    expect(fromPlans?.operations).toHaveLength(2);
    expect(fromYaml?.operations).toHaveLength(2);
    expect(fromYaml?.key).toContain('type=tap|target=login|gesture=tap');
  });

  it('can build locate-level operations without value-sensitive keys', () => {
    const operation = buildCanonicalOperationFromAction(
      'Input',
      {
        locate: { prompt: 'username field' },
        value: 'alice',
      },
      {
        includeValueInKey: false,
      },
    );

    expect(operation).toMatchObject({
      type: 'input',
      target: 'username field',
    });
    expect(operation?.valueHash).toBeUndefined();
  });
});
