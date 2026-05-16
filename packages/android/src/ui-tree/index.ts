import { createHash } from 'node:crypto';
import type { ElementCacheFeature, Rect, Size } from '@midscene/core';
import { NodeType } from '@midscene/shared/constants';
import type { ElementInfo, ElementNode } from '@midscene/shared/extractor';
import {
  type AndroidScopedNodeContext,
  type AndroidScopedSelector,
  buildAndroidScopedSelector,
  collectScopedNodeContexts,
  contextText,
  findScopedNodeContextAtPoint,
  findScopedNodeContextForNode,
  rectDistance,
  rectsApproximatelyEqual,
  signatureScore,
  textSimilarity,
} from '../scoped-selector';
import {
  type AndroidScrollRecipeCache,
  buildAndroidScrollRecipeCache,
} from '../scroll-fast-path';

export interface AndroidUiTreeScale {
  x: number;
  y: number;
}

export interface AndroidUiTreeParseOptions {
  scale?: AndroidUiTreeScale;
}

export interface AndroidNodeFeature {
  nodeHashId?: string;
  resourceId?: string;
  text?: string;
  contentDesc?: string;
  className?: string;
  packageName?: string;
  bounds?: Rect;
  targetDescription?: string;
}

export interface AndroidElementCacheFeature extends ElementCacheFeature {
  xpaths?: string[];
  android?: AndroidNodeFeature;
  androidSelector?: AndroidScopedSelector;
  androidScroll?: AndroidScrollRecipeCache;
}

export interface AndroidCacheFeatureCandidate {
  rect: Rect;
  node: ElementInfo;
  confidence: number;
  reasons: string[];
  selector?: AndroidScopedSelector;
}

export interface AndroidCacheFeatureMatch extends AndroidCacheFeatureCandidate {
  candidates: AndroidCacheFeatureCandidate[];
}

type ParsedAttributes = Record<string, string>;

type StackFrame = {
  tree: ElementNode;
  path: string;
  nodeChildCount: number;
};

const NODE_TAG_PATTERN =
  /<\/?node\b[^>]*\/?>|<hierarchy\b[^>]*>|<\/hierarchy>/g;
const ATTRIBUTE_PATTERN = /([\w:-]+)="([^"]*)"/g;

export function parseUiautomatorXml(
  xml: string,
  options?: AndroidUiTreeParseOptions,
): ElementNode {
  const trimmed = stripNonXmlPrefix(xml);
  if (!trimmed.includes('<hierarchy')) {
    throw new Error('Invalid uiautomator XML: missing <hierarchy> root');
  }

  const root: ElementNode = { node: null, children: [] };
  const stack: StackFrame[] = [
    { tree: root, path: '/hierarchy', nodeChildCount: 0 },
  ];
  let indexId = 1;
  let matchedTag = false;

  for (const match of trimmed.matchAll(NODE_TAG_PATTERN)) {
    const tag = match[0];
    matchedTag = true;

    if (tag.startsWith('</node')) {
      if (stack.length > 1) {
        stack.pop();
      }
      continue;
    }

    if (tag.startsWith('<hierarchy')) {
      continue;
    }

    if (tag.startsWith('</hierarchy')) {
      break;
    }

    const parent = stack[stack.length - 1];
    parent.nodeChildCount += 1;
    const xpath = `${parent.path}/node[${parent.nodeChildCount}]`;
    const attributes = parseAttributes(tag);
    const element = createElementInfo(attributes, xpath, indexId++, options);
    const treeNode: ElementNode = { node: element, children: [] };
    parent.tree.children.push(treeNode);

    if (!tag.endsWith('/>')) {
      stack.push({ tree: treeNode, path: xpath, nodeChildCount: 0 });
    }
  }

  if (!matchedTag || root.children.length === 0) {
    throw new Error('Invalid uiautomator XML: no <node> elements found');
  }

  return root;
}

export function buildAndroidCacheFeatureForPoint(
  tree: ElementNode,
  center: [number, number],
  options?: { targetDescription?: string },
): AndroidElementCacheFeature {
  const context = findScopedNodeContextAtPoint(tree, center);
  if (!context) {
    throw new Error(
      `No Android UI node contains point (${center[0]}, ${center[1]})`,
    );
  }

  return buildCacheFeature(context, options?.targetDescription);
}

export function rectMatchesAndroidCacheFeature(
  tree: ElementNode,
  feature: ElementCacheFeature,
): Rect {
  return matchAndroidCacheFeature(tree, feature).rect;
}

export function matchAndroidCacheFeature(
  tree: ElementNode,
  feature: ElementCacheFeature,
  options?: { minConfidence?: number; ambiguityMargin?: number },
): AndroidCacheFeatureMatch {
  const typedFeature = feature as AndroidElementCacheFeature;
  const xpaths = sanitizeStringArray(typedFeature.xpaths);
  const androidFeature = typedFeature.android;
  const androidSelector = typedFeature.androidSelector;
  const minConfidence = options?.minConfidence ?? 0.45;
  const ambiguityMargin = options?.ambiguityMargin ?? 0.08;

  if (androidFeature || androidSelector) {
    const candidates = collectScopedNodeContexts(tree)
      .filter((context) => context.node.isVisible)
      .map((context) =>
        scoreCacheCandidate(context, xpaths, androidFeature, androidSelector),
      )
      .filter((candidate) => candidate.confidence >= minConfidence)
      .sort(compareCacheCandidates);

    const best = candidates[0];
    if (best) {
      const competitor = candidates[1];
      if (
        competitor &&
        best.confidence - competitor.confidence <= ambiguityMargin
      ) {
        throw new Error(
          `Ambiguous Android cache feature: top candidates ${best.confidence.toFixed(
            2,
          )} and ${competitor.confidence.toFixed(2)} are too close`,
        );
      }
      return {
        ...best,
        candidates: candidates.slice(0, 5),
      };
    }
    if (androidSelector) {
      throw new Error(
        `No matching Android UI node found for scoped cache feature: ${JSON.stringify(
          feature,
        )}`,
      );
    }
  }

  for (const xpath of xpaths) {
    const byXpath = findNodeByXpath(tree, xpath);
    if (
      byXpath &&
      (!androidFeature || nodeMatchesFeature(byXpath, androidFeature))
    ) {
      return {
        rect: byXpath.rect,
        node: byXpath,
        confidence: 1,
        reasons: ['legacy-xpath'],
        candidates: [],
      };
    }
  }

  if (androidFeature?.resourceId) {
    const byResourceId = findBestNodeByFeature(tree, androidFeature);
    if (byResourceId) {
      return {
        rect: byResourceId.rect,
        node: byResourceId,
        confidence: 0.8,
        reasons: ['legacy-resource-id'],
        candidates: [],
      };
    }
  }

  if (androidFeature?.contentDesc || androidFeature?.text) {
    const byContent = findBestNodeByFeature(tree, androidFeature);
    if (byContent) {
      return {
        rect: byContent.rect,
        node: byContent,
        confidence: 0.7,
        reasons: ['legacy-content'],
        candidates: [],
      };
    }
  }

  if (androidFeature?.bounds) {
    const byBounds = findFirstNode(tree, (node) =>
      rectsApproximatelyEqual(node.rect, androidFeature.bounds!),
    );
    if (byBounds) {
      return {
        rect: byBounds.rect,
        node: byBounds,
        confidence: 0.6,
        reasons: ['legacy-bounds'],
        candidates: [],
      };
    }
  }

  throw new Error(
    `No matching Android UI node found for cache feature: ${JSON.stringify(
      feature,
    )}`,
  );
}

export function findNodeByXpath(
  tree: ElementNode,
  xpath: string,
): ElementInfo | undefined {
  return findFirstNode(tree, (node) => nodeXpaths(node).includes(xpath));
}

export function parseBounds(bounds: string, scale?: AndroidUiTreeScale): Rect {
  const match = bounds.match(/^\[(\d+),(\d+)]\[(\d+),(\d+)]$/);
  if (!match) {
    throw new Error(`Invalid Android bounds: ${bounds}`);
  }

  const left = Number(match[1]);
  const top = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  const scaledLeft = scaleValue(left, scale?.x);
  const scaledTop = scaleValue(top, scale?.y);
  const scaledRight = scaleValue(right, scale?.x);
  const scaledBottom = scaleValue(bottom, scale?.y);

  return {
    left: scaledLeft,
    top: scaledTop,
    width: Math.max(0, scaledRight - scaledLeft),
    height: Math.max(0, scaledBottom - scaledTop),
  };
}

export function getAndroidUiTreeScale(
  logicalSize: Size,
  physicalSize: Size,
): AndroidUiTreeScale {
  if (physicalSize.width <= 0 || physicalSize.height <= 0) {
    throw new Error(
      `Invalid Android physical size: ${physicalSize.width}x${physicalSize.height}`,
    );
  }

  return {
    x: logicalSize.width / physicalSize.width,
    y: logicalSize.height / physicalSize.height,
  };
}

function createElementInfo(
  rawAttributes: ParsedAttributes,
  xpath: string,
  indexId: number,
  options?: AndroidUiTreeParseOptions,
): ElementInfo {
  const rect = parseBounds(
    rawAttributes.bounds || '[0,0][0,0]',
    options?.scale,
  );
  const nodeType = inferNodeType(rawAttributes);
  const content = contentFromAttributes(rawAttributes);
  const nodeHashId = createNodeHash(rawAttributes, xpath);
  const resourceId = rawAttributes['resource-id'];
  const className = rawAttributes.class;

  const attributes = {
    nodeType,
    resourceId: resourceId || '',
    text: rawAttributes.text || '',
    contentDescription: rawAttributes['content-desc'] || '',
    className: className || '',
    packageName: rawAttributes.package || '',
    clickable: rawAttributes.clickable || '',
    enabled: rawAttributes.enabled || '',
    selected: rawAttributes.selected || '',
    checked: rawAttributes.checked || '',
    scrollable: rawAttributes.scrollable || '',
  };

  const idBase =
    resourceId ||
    rawAttributes['content-desc'] ||
    rawAttributes.text ||
    className ||
    'android-node';
  const id = `${sanitizeId(idBase)}-${indexId}`;

  return {
    id,
    indexId,
    nodeHashId,
    xpaths: [xpath],
    attributes,
    nodeType,
    content,
    rect,
    center: [
      Math.round(rect.left + rect.width / 2),
      Math.round(rect.top + rect.height / 2),
    ],
    isVisible: rect.width > 0 && rect.height > 0,
  };
}

function buildCacheFeature(
  context: AndroidScopedNodeContext,
  targetDescription?: string,
): AndroidElementCacheFeature {
  const node = context.node;
  return {
    xpaths: nodeXpaths(node),
    android: {
      nodeHashId: node.nodeHashId,
      resourceId: emptyToUndefined(node.attributes.resourceId),
      text: emptyToUndefined(node.attributes.text),
      contentDesc: emptyToUndefined(node.attributes.contentDescription),
      className: emptyToUndefined(node.attributes.className),
      packageName: emptyToUndefined(node.attributes.packageName),
      bounds: node.rect,
      targetDescription,
    },
    androidSelector: buildAndroidScopedSelector(context),
    androidScroll: buildAndroidScrollRecipeCache(context),
  };
}

function parseAttributes(tag: string): ParsedAttributes {
  const attributes: ParsedAttributes = {};
  for (const match of tag.matchAll(ATTRIBUTE_PATTERN)) {
    attributes[match[1]] = decodeXmlEntities(match[2]);
  }
  return attributes;
}

function inferNodeType(attributes: ParsedAttributes): NodeType {
  const className = attributes.class || '';
  if (className.includes('EditText')) {
    return NodeType.FORM_ITEM;
  }
  if (
    attributes.clickable === 'true' ||
    className.includes('Button') ||
    className.includes('ImageButton')
  ) {
    return NodeType.BUTTON;
  }
  if (contentFromAttributes(attributes)) {
    return NodeType.TEXT;
  }
  return NodeType.CONTAINER;
}

function contentFromAttributes(attributes: ParsedAttributes): string {
  const text = (attributes.text || '').trim();
  const contentDesc = (attributes['content-desc'] || '').trim();
  return [text, contentDesc]
    .filter((item, index, arr) => item && arr.indexOf(item) === index)
    .join(' ');
}

function findBestNodeByFeature(
  tree: ElementNode,
  feature: AndroidNodeFeature,
): ElementInfo | undefined {
  const candidates: ElementInfo[] = [];
  traverseNodes(tree, (node) => {
    if (!node.isVisible) {
      return;
    }
    if (
      feature.resourceId &&
      node.attributes.resourceId !== feature.resourceId
    ) {
      return;
    }
    if (feature.className && node.attributes.className !== feature.className) {
      return;
    }
    if (feature.text && node.attributes.text !== feature.text) {
      return;
    }
    if (
      feature.contentDesc &&
      node.attributes.contentDescription !== feature.contentDesc
    ) {
      return;
    }
    candidates.push(node);
  });

  if (!candidates.length) {
    return undefined;
  }

  return candidates.sort((a, b) => {
    const aDistance = feature.bounds ? rectDistance(a.rect, feature.bounds) : 0;
    const bDistance = feature.bounds ? rectDistance(b.rect, feature.bounds) : 0;
    return aDistance - bDistance;
  })[0];
}

function nodeMatchesFeature(
  node: ElementInfo,
  feature: AndroidNodeFeature,
): boolean {
  if (feature.resourceId && node.attributes.resourceId !== feature.resourceId) {
    return false;
  }
  if (feature.className && node.attributes.className !== feature.className) {
    return false;
  }
  if (feature.text && node.attributes.text !== feature.text) {
    return false;
  }
  if (
    feature.contentDesc &&
    node.attributes.contentDescription !== feature.contentDesc
  ) {
    return false;
  }
  return true;
}

function findFirstNode(
  tree: ElementNode,
  predicate: (node: ElementInfo) => boolean,
): ElementInfo | undefined {
  let result: ElementInfo | undefined;
  traverseNodes(tree, (node) => {
    if (!result && predicate(node)) {
      result = node;
    }
  });
  return result;
}

function traverseNodes(tree: ElementNode, visit: (node: ElementInfo) => void) {
  if (tree.node) {
    visit(tree.node);
  }
  for (const child of tree.children) {
    traverseNodes(child, visit);
  }
}

function nodeXpaths(node: ElementInfo): string[] {
  return sanitizeStringArray(node.xpaths);
}

function scoreCacheCandidate(
  context: AndroidScopedNodeContext,
  xpaths: string[],
  feature: AndroidNodeFeature | undefined,
  selector: AndroidScopedSelector | undefined,
): AndroidCacheFeatureCandidate {
  const reasons: string[] = [];
  let score = 0;
  let weight = 0;

  if (feature && !nodeHasTargetIdentityMatch(context.node, feature)) {
    return {
      rect: context.node.rect,
      node: context.node,
      confidence: 0,
      reasons: ['target-identity-mismatch'],
      selector: selector ? buildAndroidScopedSelector(context) : undefined,
    };
  }

  addScore(
    xpaths.some((xpath) => nodeXpaths(context.node).includes(xpath)) ? 1 : 0,
    xpaths.length ? 0.2 : 0,
    'xpath',
    reasons,
    (value) => value === 1,
  );

  if (feature?.nodeHashId) {
    addScore(
      context.node.nodeHashId === feature.nodeHashId ? 1 : 0,
      0.16,
      'node-hash',
      reasons,
      (value) => value === 1,
    );
  }

  if (feature) {
    const featureScore = scoreNodeFeature(context.node, feature, reasons);
    score += featureScore.score;
    weight += featureScore.weight;
  }

  if (selector) {
    const selectorScore = scoreScopedSelector(context, selector, reasons);
    score += selectorScore.score;
    weight += selectorScore.weight;
  }

  let confidence = weight ? Math.min(1, score / weight) : 0;
  const rowContext = selector
    ? nearestComparableRowContext(context)
    : undefined;
  if (
    selector?.rowText &&
    textSimilarity(selector.rowText, contextText(rowContext?.tree)) < 0.75
  ) {
    confidence = Math.min(confidence, 0.44);
    reasons.push('row-context-mismatch');
  }

  function addScore(
    value: number,
    valueWeight: number,
    reason: string,
    targetReasons: string[],
    acceptReason: (score: number) => boolean = (item) => item >= 0.75,
  ) {
    if (!valueWeight) {
      return;
    }
    score += value * valueWeight;
    weight += valueWeight;
    if (acceptReason(value)) {
      targetReasons.push(reason);
    }
  }

  return {
    rect: context.node.rect,
    node: context.node,
    confidence,
    reasons,
    selector: selector ? buildAndroidScopedSelector(context) : undefined,
  };
}

function nodeHasTargetIdentityMatch(
  node: ElementInfo,
  feature: AndroidNodeFeature,
): boolean {
  const identityChecks: Array<[unknown, unknown]> = [
    [feature.resourceId, node.attributes.resourceId],
    [feature.text, node.attributes.text],
    [feature.contentDesc, node.attributes.contentDescription],
    [feature.className, node.attributes.className],
  ];
  const comparable = identityChecks.filter(([expected]) => hasText(expected));
  if (!comparable.length) {
    return true;
  }
  return comparable.some(([expected, actual]) => {
    return String(expected) === String(actual ?? '');
  });
}

function scoreNodeFeature(
  node: ElementInfo,
  feature: AndroidNodeFeature,
  reasons: string[],
): { score: number; weight: number } {
  let score = 0;
  let weight = 0;
  const checks: Array<[unknown, unknown, number, string]> = [
    [feature.resourceId, node.attributes.resourceId, 0.26, 'resource-id'],
    [feature.text, node.attributes.text, 0.16, 'text'],
    [
      feature.contentDesc,
      node.attributes.contentDescription,
      0.16,
      'content-desc',
    ],
    [feature.className, node.attributes.className, 0.08, 'class'],
    [feature.packageName, node.attributes.packageName, 0.06, 'package'],
  ];

  for (const [expected, actual, itemWeight, reason] of checks) {
    if (!hasText(expected)) {
      continue;
    }
    weight += itemWeight;
    if (String(expected) === String(actual ?? '')) {
      score += itemWeight;
      reasons.push(reason);
    }
  }

  if (feature.bounds) {
    weight += 0.12;
    if (rectsApproximatelyEqual(node.rect, feature.bounds)) {
      score += 0.12;
      reasons.push('bounds');
    } else {
      const distance = rectDistance(node.rect, feature.bounds);
      const scaled = Math.max(0, 1 - distance / 240);
      score += scaled * 0.12;
      if (scaled >= 0.75) {
        reasons.push('bounds-near');
      }
    }
  }

  return { score, weight };
}

function scoreScopedSelector(
  context: AndroidScopedNodeContext,
  selector: AndroidScopedSelector,
  reasons: string[],
): { score: number; weight: number } {
  let score = 0;
  let weight = 0;

  addSignature(selector.target, context.node, 0.2, 'target');
  addSignature(selector.parent, context.parent, 0.12, 'parent');
  const rowContext = nearestComparableRowContext(context);
  addSignature(selector.row, rowContext?.node, 0.12, 'row');
  addText(selector.rowText, contextText(rowContext?.tree), 0.12, 'row-text');
  const containerContext = nearestComparableContainerContext(context);
  addSignature(selector.container, containerContext?.node, 0.08, 'container');
  addText(
    selector.containerText,
    contextText(containerContext?.tree),
    0.04,
    'container-text',
  );
  addSignature(
    selector.previousSibling,
    context.siblingIndex > 0
      ? context.siblings[context.siblingIndex - 1]
      : undefined,
    0.04,
    'previous-sibling',
  );
  addSignature(
    selector.nextSibling,
    context.siblingIndex >= 0 &&
      context.siblingIndex < context.siblings.length - 1
      ? context.siblings[context.siblingIndex + 1]
      : undefined,
    0.04,
    'next-sibling',
  );
  if (
    typeof selector.siblingIndex === 'number' &&
    typeof selector.siblingCount === 'number'
  ) {
    weight += 0.04;
    if (
      selector.siblingIndex === context.siblingIndex &&
      selector.siblingCount === context.siblings.length
    ) {
      score += 0.04;
      reasons.push('sibling-position');
    }
  }

  function addSignature(
    signature: AndroidScopedSelector['target'] | undefined,
    node: ElementInfo | undefined,
    itemWeight: number,
    reason: string,
  ) {
    if (!signature) {
      return;
    }
    const result = signatureScore(signature, node);
    if (!result.compared) {
      return;
    }
    weight += itemWeight;
    score += result.score * itemWeight;
    if (result.score >= 0.75) {
      reasons.push(reason);
    }
  }

  function addText(
    expected: string | undefined,
    actual: string,
    itemWeight: number,
    reason: string,
  ) {
    if (!hasText(expected)) {
      return;
    }
    weight += itemWeight;
    const similarity = textSimilarity(expected, actual);
    score += similarity * itemWeight;
    if (similarity >= 0.75) {
      reasons.push(reason);
    }
  }

  return { score, weight };
}

function nearestComparableRowContext(
  context: AndroidScopedNodeContext,
): AndroidScopedNodeContext | undefined {
  return context.parent
    ? findScopedNodeContextForNode(context.root, context.parent)
    : undefined;
}

function nearestComparableContainerContext(
  context: AndroidScopedNodeContext,
): AndroidScopedNodeContext | undefined {
  const container =
    context.ancestors
      .slice()
      .reverse()
      .find((node) => {
        const className = node.attributes.className || '';
        return (
          node.attributes.scrollable === 'true' ||
          /RecyclerView|ListView|ScrollView|ViewPager|GridView|LinearLayout/.test(
            className,
          ) ||
          Boolean(node.attributes.resourceId)
        );
      }) ?? context.parent;
  return container
    ? findScopedNodeContextForNode(context.root, container)
    : undefined;
}

function compareCacheCandidates(
  first: AndroidCacheFeatureCandidate,
  second: AndroidCacheFeatureCandidate,
): number {
  if (second.confidence !== first.confidence) {
    return second.confidence - first.confidence;
  }
  return rectArea(first.rect) - rectArea(second.rect);
}

function rectArea(rect: Rect): number {
  return rect.width * rect.height;
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => {
    return typeof item === 'string' && item.length > 0;
  });
}

function stripNonXmlPrefix(xml: string): string {
  const xmlStart = xml.indexOf('<hierarchy');
  if (xmlStart < 0) {
    return xml.trim();
  }
  return xml.slice(xmlStart).trim();
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-fA-F]+);/g, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function createNodeHash(attributes: ParsedAttributes, xpath: string): string {
  const source = JSON.stringify({
    xpath,
    resourceId: attributes['resource-id'] || '',
    text: attributes.text || '',
    contentDesc: attributes['content-desc'] || '',
    className: attributes.class || '',
    bounds: attributes.bounds || '',
  });
  return createHash('sha1').update(source).digest('hex').slice(0, 16);
}

function sanitizeId(value: string): string {
  return (
    value.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'android-node'
  );
}

function scaleValue(value: number, scale = 1): number {
  return Math.round(value * scale);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value || undefined;
}

function hasText(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== '';
}
