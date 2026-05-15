import type { Rect } from '@midscene/core';
import type { ElementInfo, ElementNode } from '@midscene/shared/extractor';

export interface AndroidNodeSelectorSignature {
  resourceId?: string;
  text?: string;
  contentDesc?: string;
  className?: string;
  packageName?: string;
  nodeType?: string;
}

export interface AndroidScopedSelector {
  target: AndroidNodeSelectorSignature;
  parent?: AndroidNodeSelectorSignature;
  ancestors?: AndroidNodeSelectorSignature[];
  previousSibling?: AndroidNodeSelectorSignature;
  nextSibling?: AndroidNodeSelectorSignature;
  siblingIndex?: number;
  siblingCount?: number;
  row?: AndroidNodeSelectorSignature;
  rowText?: string;
  container?: AndroidNodeSelectorSignature;
  containerText?: string;
}

export interface AndroidScopedNodeContext {
  root: ElementNode;
  tree: ElementNode;
  node: ElementInfo;
  ancestors: ElementInfo[];
  parent?: ElementInfo;
  siblings: ElementInfo[];
  siblingIndex: number;
}

const CONTEXT_TEXT_LIMIT = 240;

export function collectScopedNodeContexts(
  tree: ElementNode,
): AndroidScopedNodeContext[] {
  const contexts: AndroidScopedNodeContext[] = [];

  function visit(current: ElementNode, ancestors: ElementInfo[]) {
    const parent = ancestors[ancestors.length - 1];
    const siblingNodes = current.node
      ? currentParentSiblings(tree, current, ancestors)
      : [];

    if (current.node) {
      contexts.push({
        tree: current,
        root: tree,
        node: current.node,
        ancestors,
        parent,
        siblings: siblingNodes,
        siblingIndex: siblingNodes.indexOf(current.node),
      });
    }

    const nextAncestors = current.node
      ? [...ancestors, current.node]
      : ancestors;
    for (const child of current.children) {
      visit(child, nextAncestors);
    }
  }

  visit(tree, []);
  return contexts;
}

export function findScopedNodeContextAtPoint(
  tree: ElementNode,
  center: [number, number],
): AndroidScopedNodeContext | undefined {
  return collectScopedNodeContexts(tree)
    .filter((context) => {
      return context.node.isVisible && pointInRect(center, context.node.rect);
    })
    .sort((a, b) => rectArea(a.node.rect) - rectArea(b.node.rect))[0];
}

export function findScopedNodeContextForNode(
  tree: ElementNode,
  node: ElementInfo,
): AndroidScopedNodeContext | undefined {
  return collectScopedNodeContexts(tree).find((context) => {
    return context.node === node;
  });
}

export function buildAndroidScopedSelector(
  context: AndroidScopedNodeContext,
): AndroidScopedSelector {
  const row = findRowContext(context);
  const container = findContainerContext(context);
  const previousSibling =
    context.siblingIndex > 0
      ? context.siblings[context.siblingIndex - 1]
      : undefined;
  const nextSibling =
    context.siblingIndex >= 0 &&
    context.siblingIndex < context.siblings.length - 1
      ? context.siblings[context.siblingIndex + 1]
      : undefined;

  return pruneScopedSelector({
    target: nodeSelectorSignature(context.node),
    parent: context.parent ? nodeSelectorSignature(context.parent) : undefined,
    ancestors: context.ancestors
      .slice(-3)
      .map(nodeSelectorSignature)
      .filter(hasSignatureValue),
    previousSibling: previousSibling
      ? nodeSelectorSignature(previousSibling)
      : undefined,
    nextSibling: nextSibling ? nodeSelectorSignature(nextSibling) : undefined,
    siblingIndex: context.siblingIndex >= 0 ? context.siblingIndex : undefined,
    siblingCount: context.siblings.length || undefined,
    row: row ? nodeSelectorSignature(row.node) : undefined,
    rowText: row ? visibleContextText(row.tree) : undefined,
    container: container ? nodeSelectorSignature(container.node) : undefined,
    containerText: container ? visibleContextText(container.tree) : undefined,
  });
}

export function buildAndroidCandidateMetadata(
  context: AndroidScopedNodeContext,
): Record<string, unknown> {
  const selector = buildAndroidScopedSelector(context);
  return {
    resourceId: context.node.attributes.resourceId,
    text: context.node.attributes.text,
    contentDescription: context.node.attributes.contentDescription,
    className: context.node.attributes.className,
    clickable: context.node.attributes.clickable,
    xpaths: context.node.xpaths,
    selector,
    rowText: selector.rowText,
    containerText: selector.containerText,
    siblingIndex: selector.siblingIndex,
    siblingCount: selector.siblingCount,
  };
}

export function nodeSelectorSignature(
  node: ElementInfo,
): AndroidNodeSelectorSignature {
  return pruneSignature({
    resourceId: emptyToUndefined(node.attributes.resourceId),
    text: emptyToUndefined(node.attributes.text),
    contentDesc: emptyToUndefined(node.attributes.contentDescription),
    className: emptyToUndefined(node.attributes.className),
    packageName: emptyToUndefined(node.attributes.packageName),
    nodeType: String(node.nodeType),
  });
}

export function signatureScore(
  signature: AndroidNodeSelectorSignature | undefined,
  node: ElementInfo | undefined,
): { score: number; compared: number; matched: number; reasons: string[] } {
  if (!signature || !node) {
    return { score: 0, compared: 0, matched: 0, reasons: [] };
  }

  const fields: Array<
    [keyof AndroidNodeSelectorSignature, string | undefined, string]
  > = [
    ['resourceId', node.attributes.resourceId, 'resource-id'],
    ['text', node.attributes.text, 'text'],
    ['contentDesc', node.attributes.contentDescription, 'content-desc'],
    ['className', node.attributes.className, 'class'],
    ['packageName', node.attributes.packageName, 'package'],
    ['nodeType', String(node.nodeType), 'node-type'],
  ];
  let compared = 0;
  let matched = 0;
  const reasons: string[] = [];

  for (const [key, actualValue, reason] of fields) {
    const expectedValue = signature[key];
    if (!hasText(expectedValue)) {
      continue;
    }
    compared += 1;
    if (String(expectedValue) === String(actualValue ?? '')) {
      matched += 1;
      reasons.push(reason);
    }
  }

  return {
    score: compared ? matched / compared : 0,
    compared,
    matched,
    reasons,
  };
}

export function textSimilarity(expected: string | undefined, actual: string) {
  const expectedTokens = tokenizeForSelector(expected);
  const actualTokens = new Set(tokenizeForSelector(actual));
  if (!expectedTokens.length || !actualTokens.size) {
    return 0;
  }
  const matched = expectedTokens.filter((token) => actualTokens.has(token));
  return matched.length / expectedTokens.length;
}

export function contextText(tree: ElementNode | undefined): string {
  if (!tree) {
    return '';
  }
  const parts: string[] = [];
  collectTreeText(tree, parts);
  return compactText(parts.join(' '), CONTEXT_TEXT_LIMIT);
}

export function visibleContextText(tree: ElementNode | undefined): string {
  if (!tree) {
    return '';
  }
  const parts: string[] = [];
  collectVisibleTreeText(tree, parts);
  return compactText(parts.join(' '), CONTEXT_TEXT_LIMIT);
}

export function rectDistance(a: Rect, b: Rect): number {
  return Math.abs(a.left - b.left) + Math.abs(a.top - b.top);
}

export function rectsApproximatelyEqual(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.left - b.left) <= 2 &&
    Math.abs(a.top - b.top) <= 2 &&
    Math.abs(a.width - b.width) <= 2 &&
    Math.abs(a.height - b.height) <= 2
  );
}

function findRowContext(
  context: AndroidScopedNodeContext,
): AndroidScopedNodeContext | undefined {
  const candidates = collectAncestorContexts(context);
  return candidates.find((candidate) => {
    const directVisibleChildren = candidate.tree.children.filter(
      (child) => child.node?.isVisible,
    );
    if (directVisibleChildren.length < 2) {
      return false;
    }
    const nodeHeight = Math.max(1, context.node.rect.height);
    return candidate.node.rect.height <= Math.max(160, nodeHeight * 5);
  });
}

function findContainerContext(
  context: AndroidScopedNodeContext,
): AndroidScopedNodeContext | undefined {
  const candidates = collectAncestorContexts(context);
  return candidates.find((candidate) => {
    const attrs = candidate.node.attributes;
    const className = attrs.className || '';
    return (
      attrs.scrollable === 'true' ||
      /RecyclerView|ListView|ScrollView|ViewPager|GridView|LinearLayout/.test(
        className,
      ) ||
      Boolean(attrs.resourceId)
    );
  });
}

function collectAncestorContexts(
  context: AndroidScopedNodeContext,
): AndroidScopedNodeContext[] {
  const result: AndroidScopedNodeContext[] = [];
  for (let index = context.ancestors.length - 1; index >= 0; index -= 1) {
    const node = context.ancestors[index];
    const parent = context.ancestors[index - 1];
    const currentTree =
      findTreeByNodeReference(context.root, node) ?? context.tree;
    const parentTree = parent
      ? findTreeByNodeReference(context.root, parent)
      : undefined;
    const siblings =
      parentTree?.children
        .map((child) => child.node)
        .filter((item): item is ElementInfo => Boolean(item)) ?? [];
    result.push({
      tree: currentTree,
      root: context.root,
      node,
      ancestors: context.ancestors.slice(0, index),
      parent,
      siblings,
      siblingIndex: siblings.indexOf(node),
    });
  }
  return result;
}

function currentParentSiblings(
  root: ElementNode,
  current: ElementNode,
  ancestors: ElementInfo[],
): ElementInfo[] {
  const parent = ancestors[ancestors.length - 1];
  const parentTree = parent ? findTreeByNodeReference(root, parent) : root;
  return (
    parentTree?.children
      .map((child) => child.node)
      .filter((item): item is ElementInfo => Boolean(item)) ?? []
  );
}

function findTreeByNodeReference(
  tree: ElementNode,
  target: ElementInfo,
): ElementNode | undefined {
  if (tree.node === target) {
    return tree;
  }
  for (const child of tree.children) {
    const result = findTreeByNodeReference(child, target);
    if (result) {
      return result;
    }
  }
  return undefined;
}

function collectTreeText(tree: ElementNode, output: string[]) {
  if (tree.node) {
    output.push(
      tree.node.content,
      tree.node.attributes.text,
      tree.node.attributes.contentDescription,
      tree.node.attributes.resourceId,
    );
  }
  for (const child of tree.children) {
    collectTreeText(child, output);
  }
}

function collectVisibleTreeText(tree: ElementNode, output: string[]) {
  if (tree.node) {
    output.push(
      tree.node.content,
      tree.node.attributes.text,
      tree.node.attributes.contentDescription,
    );
  }
  for (const child of tree.children) {
    collectVisibleTreeText(child, output);
  }
}

function pruneScopedSelector(selector: AndroidScopedSelector) {
  const result: AndroidScopedSelector = {
    target: selector.target,
  };
  const output = result as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(selector)) {
    if (key === 'target') {
      continue;
    }
    if (Array.isArray(value)) {
      const filtered = value.filter(hasSignatureValue);
      if (filtered.length) {
        output[key] = filtered;
      }
      continue;
    }
    if (typeof value === 'object' && value !== null) {
      if (hasSignatureValue(value as AndroidNodeSelectorSignature)) {
        output[key] = value;
      }
      continue;
    }
    if (hasText(value)) {
      output[key] = value;
    }
  }
  return result;
}

function pruneSignature(
  signature: AndroidNodeSelectorSignature,
): AndroidNodeSelectorSignature {
  return Object.fromEntries(
    Object.entries(signature).filter(([, value]) => hasText(value)),
  ) as AndroidNodeSelectorSignature;
}

function hasSignatureValue(signature: AndroidNodeSelectorSignature): boolean {
  return Object.values(signature).some(hasText);
}

function tokenizeForSelector(value: string | undefined): string[] {
  return compactText(value ?? '')
    .toLowerCase()
    .split(' ')
    .filter(Boolean);
}

function compactText(value: string, limit = Number.POSITIVE_INFINITY): string {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_:./\\-]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return normalized.length > limit
    ? `${normalized.slice(0, Math.max(0, limit - 1)).trim()}...`
    : normalized;
}

function pointInRect(point: [number, number], rect: Rect): boolean {
  return (
    point[0] >= rect.left &&
    point[0] < rect.left + rect.width &&
    point[1] >= rect.top &&
    point[1] < rect.top + rect.height
  );
}

function rectArea(rect: Rect): number {
  return rect.width * rect.height;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value || undefined;
}

function hasText(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== '';
}
