import { createHash } from 'node:crypto';
import type { TUserPrompt } from '@/ai-model';
import type { PlanningAction } from '@/types';
import type { MidsceneYamlFlowItem } from '@/yaml';

export const OPERATION_IR_VERSION = 1;

export type CanonicalOperationType =
  | 'tap'
  | 'input'
  | 'scroll'
  | 'wait'
  | 'assert'
  | 'launch'
  | 'system'
  | 'recover';

export type OperationIRSource =
  | 'deterministic-parser'
  | 'action-space'
  | 'yaml-flow';

export interface CanonicalOperation {
  type: CanonicalOperationType;
  target?: string;
  gesture?: string;
  direction?: string;
  mode?: string;
  rawAction?: string;
  valueHash?: string;
  valueSensitive?: boolean;
  commandHash?: string;
}

export interface OperationIR {
  version: typeof OPERATION_IR_VERSION;
  source: OperationIRSource;
  key: string;
  summary: string;
  operations: CanonicalOperation[];
}

interface BuildOperationOptions {
  source?: OperationIRSource;
  includeValueInKey?: boolean;
}

interface ParseInputResult {
  target: string;
  value?: unknown;
}

const actionTypeMap: Record<string, CanonicalOperationType> = {
  tap: 'tap',
  rightclick: 'tap',
  doubleclick: 'tap',
  hover: 'tap',
  longpress: 'tap',
  input: 'input',
  clearinput: 'input',
  keyboardpress: 'input',
  scroll: 'scroll',
  swipe: 'scroll',
  wait: 'wait',
  sleep: 'wait',
  waitfor: 'wait',
  assert: 'assert',
  launch: 'launch',
  terminate: 'launch',
  runadbshell: 'system',
  androidbackbutton: 'system',
  androidhomebutton: 'system',
  androidrecentappsbutton: 'system',
};

const actionGestureMap: Record<string, string> = {
  tap: 'tap',
  rightclick: 'rightClick',
  doubleclick: 'doubleClick',
  hover: 'hover',
  longpress: 'longPress',
};

const sensitiveValueKeys = new Set([
  'password',
  'passwd',
  'pwd',
  'token',
  'secret',
  '\u5bc6\u7801',
  '\u9a8c\u8bc1\u7801',
  '\u6821\u9a8c\u7801',
  'otp',
]);

function stableHash(value: unknown): string {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 12);
}

function normalizeText(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = String(value)
    .replace(/[\u201c\u201d\u2018\u2019"'`]/g, '')
    .replace(/[\u3001\u3002\uff0c\uff01\uff1f\uff1b\uff1a,.!?;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return normalized || undefined;
}

function promptToText(prompt: TUserPrompt | unknown): string | undefined {
  if (typeof prompt === 'string') {
    return normalizeText(prompt);
  }
  if (prompt && typeof prompt === 'object' && 'prompt' in prompt) {
    return normalizeText((prompt as { prompt?: unknown }).prompt);
  }
  return undefined;
}

function extractLocatePrompt(param: unknown): string | undefined {
  if (!param || typeof param !== 'object') {
    return undefined;
  }
  const input = param as Record<string, unknown>;
  const locate = input.locate;
  if (typeof locate === 'string') {
    return normalizeText(locate);
  }
  if (locate && typeof locate === 'object' && 'prompt' in locate) {
    return promptToText((locate as { prompt?: unknown }).prompt);
  }
  return promptToText(input.prompt);
}

function inferScrollDirection(param: unknown): string | undefined {
  if (!param || typeof param !== 'object') {
    return undefined;
  }
  const input = param as Record<string, unknown>;
  const direction = normalizeText(input.direction);
  if (direction) {
    return direction;
  }
  const scrollType = normalizeText(input.scrollType);
  if (!scrollType) {
    return undefined;
  }
  if (scrollType.includes('top')) return 'up';
  if (scrollType.includes('bottom')) return 'down';
  if (scrollType.includes('left')) return 'left';
  if (scrollType.includes('right')) return 'right';
  return scrollType;
}

function shouldHideValue(target?: string): boolean {
  if (!target) {
    return false;
  }
  return [...sensitiveValueKeys].some((key) => target.includes(key));
}

function operationKeyPart(operation: CanonicalOperation): string {
  const parts = [`type=${operation.type}`];
  if (operation.target) parts.push(`target=${operation.target}`);
  if (operation.gesture) parts.push(`gesture=${operation.gesture}`);
  if (operation.direction) parts.push(`direction=${operation.direction}`);
  if (operation.mode) parts.push(`mode=${operation.mode}`);
  if (operation.valueHash) parts.push(`value=${operation.valueHash}`);
  if (operation.commandHash) parts.push(`command=${operation.commandHash}`);
  return parts.join('|');
}

export function buildOperationKey(
  operations: CanonicalOperation[],
): string | undefined {
  if (operations.length === 0) {
    return undefined;
  }
  return operations.map(operationKeyPart).join(' -> ');
}

function operationSummary(operation: CanonicalOperation): string {
  const target = operation.target ? ` ${operation.target}` : '';
  const direction = operation.direction ? ` ${operation.direction}` : '';
  return `${operation.type}${target}${direction}`.trim();
}

function buildOperationIR(
  operations: CanonicalOperation[],
  source: OperationIRSource,
): OperationIR | undefined {
  const key = buildOperationKey(operations);
  if (!key) {
    return undefined;
  }
  return {
    version: OPERATION_IR_VERSION,
    source,
    key,
    summary: operations.map(operationSummary).join(' -> '),
    operations,
  };
}

export function canonicalizeActionType(
  actionType: string,
): CanonicalOperationType | undefined {
  return actionTypeMap[actionType.replace(/\s+/g, '').toLowerCase()];
}

export function buildCanonicalOperationFromAction(
  actionType: string,
  param: unknown,
  options: BuildOperationOptions = {},
): CanonicalOperation | undefined {
  const canonicalType = canonicalizeActionType(actionType);
  if (!canonicalType) {
    return undefined;
  }

  const normalizedActionType = actionType.replace(/\s+/g, '').toLowerCase();
  const input = param && typeof param === 'object' ? (param as any) : {};
  const target =
    canonicalType === 'launch'
      ? normalizeText(input.uri ?? input.app ?? input.packageName ?? param)
      : canonicalType === 'system'
        ? normalizeText(input.command ?? actionType)
        : extractLocatePrompt(param);

  const operation: CanonicalOperation = {
    type: canonicalType,
    target,
    rawAction: actionType,
  };

  const gesture = actionGestureMap[normalizedActionType];
  if (gesture) {
    operation.gesture = gesture;
  }

  if (canonicalType === 'scroll') {
    operation.direction = inferScrollDirection(param);
  }

  if (canonicalType === 'input') {
    const mode = normalizeText(input.mode ?? normalizedActionType);
    if (mode) {
      operation.mode = mode;
    }
    if (options.includeValueInKey && input.value !== undefined) {
      operation.valueSensitive = shouldHideValue(target);
      if (!operation.valueSensitive) {
        operation.valueHash = stableHash(input.value);
      }
    }
  }

  if (canonicalType === 'system' && input.command !== undefined) {
    operation.commandHash = stableHash(input.command);
  }

  return operation;
}

export function buildOperationIRFromActionPlan(
  actionType: string,
  param: unknown,
  options: BuildOperationOptions = {},
): OperationIR | undefined {
  const operation = buildCanonicalOperationFromAction(actionType, param, {
    includeValueInKey: true,
    ...options,
  });
  return operation
    ? buildOperationIR([operation], options.source ?? 'action-space')
    : undefined;
}

export function buildOperationIRFromPlans(
  plans: PlanningAction[],
  options: BuildOperationOptions = {},
): OperationIR | undefined {
  const operations = plans
    .map((plan) =>
      buildCanonicalOperationFromAction(plan.type, plan.param, {
        includeValueInKey: true,
        ...options,
      }),
    )
    .filter(Boolean) as CanonicalOperation[];
  return buildOperationIR(operations, options.source ?? 'action-space');
}

function parseInputCommand(prompt: string): ParseInputResult | undefined {
  const chineseInput = prompt.match(
    /^(?:\u5728|\u5411)?(.+?)(?:\u4e2d|\u91cc)?(?:\u8f93\u5165|\u586b\u5199|\u586b\u5165|\u952e\u5165)\s*(.+)$/i,
  );
  if (chineseInput?.[1] && chineseInput?.[2]) {
    return {
      target: normalizeText(chineseInput[1]) || chineseInput[1].trim(),
      value: chineseInput[2].trim(),
    };
  }

  const englishInput = prompt.match(
    /^(?:input|type|fill|enter)\s+(.+?)\s+(?:into|in|to)\s+(.+)$/i,
  );
  if (englishInput?.[1] && englishInput?.[2]) {
    return {
      target: normalizeText(englishInput[2]) || englishInput[2].trim(),
      value: englishInput[1].trim(),
    };
  }

  return undefined;
}

function inferSystemTarget(prompt: string): string | undefined {
  const target = prompt.match(
    /(wifi|wi-fi|wlan|\u84dd\u7259|bluetooth|\u5b9a\u4f4d|location|\u98de\u884c\u6a21\u5f0f|airplane|\u6df1\u8272\u6a21\u5f0f|dark mode)/i,
  )?.[1];
  const action = prompt.match(
    /(\u6253\u5f00|\u5f00\u542f|\u5173\u95ed|\u7981\u7528|\u542f\u7528|\u5207\u6362|enable|disable|turn on|turn off|toggle)/i,
  )?.[1];
  if (!target || !action) {
    return undefined;
  }
  return `${normalizeText(action)} ${normalizeText(target)}`.trim();
}

function inferScrollCommand(prompt: string): CanonicalOperation | undefined {
  const patterns: Array<[RegExp, string]> = [
    [/(\u5411\u4e0a\u6ed1|\u4e0a\u6ed1|scroll up|swipe up)/i, 'up'],
    [/(\u5411\u4e0b\u6ed1|\u4e0b\u6ed1|scroll down|swipe down)/i, 'down'],
    [/(\u5411\u5de6\u6ed1|\u5de6\u6ed1|scroll left|swipe left)/i, 'left'],
    [/(\u5411\u53f3\u6ed1|\u53f3\u6ed1|scroll right|swipe right)/i, 'right'],
  ];
  const direction = patterns.find(([pattern]) => pattern.test(prompt))?.[1];
  if (!direction) {
    return undefined;
  }
  return {
    type: 'scroll',
    direction,
  };
}

export function parseNaturalLanguageOperation(
  prompt: string,
): OperationIR | undefined {
  const normalizedPrompt = normalizeText(prompt);
  if (!normalizedPrompt) {
    return undefined;
  }

  const inputResult = parseInputCommand(prompt);
  if (inputResult) {
    const valueSensitive = shouldHideValue(inputResult.target);
    return buildOperationIR(
      [
        {
          type: 'input',
          target: inputResult.target,
          valueHash: valueSensitive ? undefined : stableHash(inputResult.value),
          valueSensitive,
        },
      ],
      'deterministic-parser',
    );
  }

  const waitTarget = prompt.match(
    /^(?:\u7b49\u5f85|\u7b49\u5230|wait for|wait until)\s*(.+)$/i,
  )?.[1];
  if (waitTarget) {
    return buildOperationIR(
      [
        {
          type: 'wait',
          target: normalizeText(waitTarget),
        },
      ],
      'deterministic-parser',
    );
  }

  const assertTarget = prompt.match(
    /^(?:\u9a8c\u8bc1|\u65ad\u8a00|\u68c0\u67e5|\u786e\u8ba4|assert|verify|check)\s*(.+)$/i,
  )?.[1];
  if (assertTarget) {
    return buildOperationIR(
      [
        {
          type: 'assert',
          target: normalizeText(assertTarget),
        },
      ],
      'deterministic-parser',
    );
  }

  const systemTarget = inferSystemTarget(prompt);
  if (systemTarget) {
    return buildOperationIR(
      [
        {
          type: 'system',
          target: systemTarget,
        },
      ],
      'deterministic-parser',
    );
  }

  const recoverTarget = prompt.match(
    /^(?:\u5904\u7406|\u5173\u95ed|\u5141\u8bb8|\u62d2\u7edd|dismiss|recover|close)\s*(?:\u5f39\u7a97|\u5e7f\u544a|\u6743\u9650|crash|anr|popup|dialog).*/i,
  )?.[0];
  if (recoverTarget) {
    return buildOperationIR(
      [
        {
          type: 'recover',
          target: normalizeText(recoverTarget),
        },
      ],
      'deterministic-parser',
    );
  }

  const launchTarget = prompt.match(/^(?:\u542f\u52a8|launch)\s*(.+)$/i)?.[1];
  if (launchTarget) {
    return buildOperationIR(
      [
        {
          type: 'launch',
          target: normalizeText(launchTarget),
        },
      ],
      'deterministic-parser',
    );
  }

  const openLaunchTarget = prompt.match(
    /^(?:\u6253\u5f00|open)\s*(.+(?:\u5e94\u7528|app|package|settings|\u8bbe\u7f6e|http|com\.))$/i,
  )?.[1];
  if (openLaunchTarget) {
    return buildOperationIR(
      [
        {
          type: 'launch',
          target: normalizeText(openLaunchTarget),
        },
      ],
      'deterministic-parser',
    );
  }

  const scrollOperation = inferScrollCommand(prompt);
  if (scrollOperation) {
    return buildOperationIR([scrollOperation], 'deterministic-parser');
  }

  const tapTarget = prompt.match(
    /^(?:\u70b9\u51fb|\u70b9\u4e00\u4e0b|\u70b9\u6309|\u9009\u62e9|\u8fdb\u5165|tap|click|press|select)\s*(.+)$/i,
  )?.[1];
  if (tapTarget) {
    return buildOperationIR(
      [
        {
          type: 'tap',
          target: normalizeText(tapTarget),
          gesture: 'tap',
        },
      ],
      'deterministic-parser',
    );
  }

  return undefined;
}

function operationFromYamlItem(
  flowItem: MidsceneYamlFlowItem,
): CanonicalOperation | undefined {
  const item = flowItem as Record<string, any>;
  if (item.aiTap !== undefined) {
    return buildCanonicalOperationFromAction(
      'Tap',
      {
        locate: item.locate ?? item.aiTap,
      },
      { includeValueInKey: true },
    );
  }
  if (item.aiInput !== undefined) {
    return buildCanonicalOperationFromAction(
      'Input',
      {
        locate: item.locate ?? item.aiInput,
        value: item.value,
        mode: item.mode,
      },
      { includeValueInKey: true },
    );
  }
  if (item.aiScroll !== undefined) {
    return buildCanonicalOperationFromAction(
      'Scroll',
      {
        locate: item.locate ?? item.aiScroll,
        direction: item.direction,
        scrollType: item.scrollType,
      },
      { includeValueInKey: true },
    );
  }
  if (item.aiWaitFor !== undefined) {
    return { type: 'wait', target: normalizeText(item.aiWaitFor) };
  }
  if (item.aiAssert !== undefined) {
    return { type: 'assert', target: normalizeText(item.aiAssert) };
  }
  if (item.sleep !== undefined) {
    return { type: 'wait', target: `${Number(item.sleep) || 0}ms` };
  }

  const actionKey = Object.keys(item).find((key) =>
    canonicalizeActionType(key),
  );
  if (!actionKey) {
    return undefined;
  }
  const rawParam = item[actionKey];
  const param =
    rawParam && typeof rawParam === 'object'
      ? { ...rawParam, ...item }
      : { ...item, value: item.value, locate: item.locate ?? rawParam };
  return buildCanonicalOperationFromAction(actionKey, param, {
    includeValueInKey: true,
  });
}

export function buildOperationIRFromYamlFlow(
  flow: MidsceneYamlFlowItem[] | undefined,
): OperationIR | undefined {
  if (!flow?.length) {
    return undefined;
  }
  const operations = flow
    .map(operationFromYamlItem)
    .filter(Boolean) as CanonicalOperation[];
  return buildOperationIR(operations, 'yaml-flow');
}

export function operationHasSensitiveValue(operation: OperationIR): boolean {
  return operation.operations.some((item) => item.valueSensitive);
}
