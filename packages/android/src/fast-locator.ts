import type { LocateResultElement } from '@midscene/core';
import { NodeType } from '@midscene/shared/constants';
import {
  type ElementInfo,
  type ElementNode,
  treeToList,
} from '@midscene/shared/extractor';

export interface AndroidFastLocatorOptions {
  minScore?: number;
}

export interface AndroidFastLocatorMatch {
  element: LocateResultElement;
  confidence: number;
  node: ElementInfo;
  reason: string;
}

const DEFAULT_MIN_SCORE = 0.72;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'in',
  'into',
  'of',
  'on',
  'please',
  'the',
  'to',
]);

const ROLE_WORDS = new Set([
  'button',
  'btn',
  'click',
  'field',
  'input',
  'item',
  'link',
  'tap',
  'text',
  'view',
]);

const BUTTON_PROMPT_PATTERN =
  /\b(button|btn|tap|click)\b|\u6309\u94ae|\u6309\u952e|\u70b9\u51fb|\u786e\u8ba4|\u63d0\u4ea4|\u767b\u5f55/u;
const INPUT_PROMPT_PATTERN =
  /\b(input|field|textbox|text\s*box|edit\s*text|search)\b|\u8f93\u5165|\u8f93\u5165\u6846|\u641c\u7d22\u6846/u;
const TEXT_PROMPT_PATTERN =
  /\b(text|label|title)\b|\u6587\u672c|\u6807\u9898|\u6587\u6848/u;

export function locateAndroidElementByPrompt(
  tree: ElementNode,
  prompt: unknown,
  options?: AndroidFastLocatorOptions,
): LocateResultElement | null {
  return locateAndroidElementWithScore(tree, prompt, options)?.element ?? null;
}

export function locateAndroidElementWithScore(
  tree: ElementNode,
  prompt: unknown,
  options?: AndroidFastLocatorOptions,
): AndroidFastLocatorMatch | null {
  const promptText = promptToText(prompt);
  const promptNormalized = normalizeText(promptText);
  if (!promptNormalized) {
    return null;
  }

  const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;
  const matches = treeToList(tree)
    .filter(isUsableNode)
    .map((node) => scoreNode(node, promptNormalized))
    .filter((match) => match.confidence >= minScore)
    .sort(compareMatches);

  return matches[0] ?? null;
}

function promptToText(prompt: unknown): string {
  if (typeof prompt === 'string') {
    return prompt;
  }

  if (!prompt || typeof prompt !== 'object') {
    return '';
  }

  const promptObject = prompt as { prompt?: unknown };
  return typeof promptObject.prompt === 'string' ? promptObject.prompt : '';
}

function scoreNode(
  node: ElementInfo,
  promptNormalized: string,
): AndroidFastLocatorMatch {
  const attributes = node.attributes;
  const contentNormalized = normalizeText(
    [node.content, attributes.text, attributes.contentDescription].filter(
      Boolean,
    ),
  );
  const resourceNormalized = normalizeText([
    attributes.resourceId,
    resourceIdTail(attributes.resourceId),
  ]);
  const classNormalized = normalizeText(attributes.className);
  const combinedNormalized = normalizeText([
    contentNormalized,
    resourceNormalized,
    classNormalized,
  ]);
  const role = promptRole(promptNormalized);
  const intentTokens = promptTokens(promptNormalized);
  const promptOnlyRole = intentTokens.length === 0 && !!role;

  const contentScore = textScore(
    promptNormalized,
    contentNormalized,
    intentTokens,
    promptOnlyRole,
  );
  const resourceScore =
    textScore(
      promptNormalized,
      resourceNormalized,
      intentTokens,
      promptOnlyRole,
    ) * 0.86;
  const combinedScore =
    tokenCoverage(intentTokens, combinedNormalized, true) * 0.74;

  let confidence = Math.max(contentScore, resourceScore, combinedScore);
  let reason = 'text';

  if (resourceScore > contentScore && resourceScore >= combinedScore) {
    reason = 'resource-id';
  } else if (combinedScore > contentScore) {
    reason = 'combined';
  }

  if (role && nodeMatchesRole(node, role)) {
    confidence += role === 'input' ? 0.14 : 0.1;
    reason = `${reason}+role`;
  }

  if (attributes.clickable === 'true') {
    confidence += 0.03;
  }

  if (node.nodeType === NodeType.CONTAINER) {
    confidence -= contentNormalized || resourceNormalized ? 0.08 : 0.2;
  }

  if (promptOnlyRole) {
    confidence = Math.min(confidence, 0.55);
  }

  confidence = clamp(confidence, 0, 1);

  return {
    element: {
      description:
        node.content ||
        attributes.contentDescription ||
        attributes.text ||
        attributes.resourceId ||
        'Android UI node',
      center: node.center,
      rect: node.rect,
    },
    confidence,
    node,
    reason,
  };
}

function isUsableNode(node: ElementInfo): boolean {
  return node.isVisible && node.rect.width > 0 && node.rect.height > 0;
}

function compareMatches(
  first: AndroidFastLocatorMatch,
  second: AndroidFastLocatorMatch,
): number {
  if (second.confidence !== first.confidence) {
    return second.confidence - first.confidence;
  }

  const roleDelta = nodeRank(second.node) - nodeRank(first.node);
  if (roleDelta !== 0) {
    return roleDelta;
  }

  return rectArea(first.node.rect) - rectArea(second.node.rect);
}

function textScore(
  promptNormalized: string,
  fieldNormalized: string,
  intentTokens: string[],
  promptOnlyRole: boolean,
): number {
  if (!fieldNormalized) {
    return 0;
  }

  if (fieldNormalized === promptNormalized) {
    return promptOnlyRole ? 0.55 : 1;
  }

  if (!promptOnlyRole && fieldNormalized.includes(promptNormalized)) {
    return 0.95;
  }

  if (
    !promptOnlyRole &&
    promptNormalized.includes(fieldNormalized) &&
    !ROLE_WORDS.has(fieldNormalized)
  ) {
    return 0.9;
  }

  const coverage = tokenCoverage(intentTokens, fieldNormalized, false);
  if (coverage === 1) {
    return 0.86;
  }
  if (coverage > 0) {
    return 0.5 + coverage * 0.28;
  }
  return 0;
}

function tokenCoverage(
  tokens: string[],
  fieldNormalized: string,
  allowPartial: boolean,
): number {
  if (!tokens.length || !fieldNormalized) {
    return 0;
  }

  const fieldTokens = new Set(tokenize(fieldNormalized));
  const matched = tokens.filter((token) => {
    if (fieldTokens.has(token)) {
      return true;
    }
    return allowPartial && fieldNormalized.includes(token);
  }).length;

  return matched / tokens.length;
}

function promptTokens(promptNormalized: string): string[] {
  return unique(
    tokenize(promptNormalized).filter(
      (token) => !STOP_WORDS.has(token) && !ROLE_WORDS.has(token),
    ),
  );
}

function tokenize(value: string): string[] {
  return value.split(' ').filter(Boolean);
}

function normalizeText(value: unknown): string {
  const raw = Array.isArray(value) ? value.join(' ') : String(value ?? '');
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_:./\\-]+/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function resourceIdTail(resourceId: string | undefined): string {
  if (!resourceId) {
    return '';
  }
  return resourceId.split('/').pop() ?? resourceId;
}

function promptRole(
  promptNormalized: string,
): 'button' | 'input' | 'text' | '' {
  if (INPUT_PROMPT_PATTERN.test(promptNormalized)) {
    return 'input';
  }
  if (BUTTON_PROMPT_PATTERN.test(promptNormalized)) {
    return 'button';
  }
  if (TEXT_PROMPT_PATTERN.test(promptNormalized)) {
    return 'text';
  }
  return '';
}

function nodeMatchesRole(
  node: ElementInfo,
  role: 'button' | 'input' | 'text',
): boolean {
  if (role === 'input') {
    return (
      node.nodeType === NodeType.FORM_ITEM ||
      node.attributes.className?.includes('EditText') ||
      node.attributes.className?.includes('SearchView')
    );
  }

  if (role === 'button') {
    return (
      node.nodeType === NodeType.BUTTON ||
      node.nodeType === NodeType.A ||
      node.attributes.clickable === 'true'
    );
  }

  return node.nodeType === NodeType.TEXT;
}

function nodeRank(node: ElementInfo): number {
  if (
    node.nodeType === NodeType.FORM_ITEM ||
    node.nodeType === NodeType.BUTTON
  ) {
    return 3;
  }
  if (node.attributes.clickable === 'true' || node.nodeType === NodeType.A) {
    return 2;
  }
  if (node.nodeType === NodeType.TEXT) {
    return 1;
  }
  return 0;
}

function rectArea(rect: ElementInfo['rect']): number {
  return rect.width * rect.height;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
