import { createHash } from 'node:crypto';
import type { ElementCacheFeature, Rect, Size } from '@midscene/core';
import { NodeType } from '@midscene/shared/constants';
import type { ElementInfo, ElementNode } from '@midscene/shared/extractor';

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
  const node = findSmallestNodeContainingPoint(tree, center);
  if (!node) {
    throw new Error(
      `No Android UI node contains point (${center[0]}, ${center[1]})`,
    );
  }

  return buildCacheFeature(node, options?.targetDescription);
}

export function rectMatchesAndroidCacheFeature(
  tree: ElementNode,
  feature: ElementCacheFeature,
): Rect {
  const typedFeature = feature as AndroidElementCacheFeature;
  const xpaths = sanitizeStringArray(typedFeature.xpaths);
  const androidFeature = typedFeature.android;

  for (const xpath of xpaths) {
    const byXpath = findNodeByXpath(tree, xpath);
    if (
      byXpath &&
      (!androidFeature || nodeMatchesFeature(byXpath, androidFeature))
    ) {
      return byXpath.rect;
    }
  }

  if (androidFeature?.nodeHashId) {
    const byHash = findFirstNode(tree, (node) => {
      return node.nodeHashId === androidFeature.nodeHashId;
    });
    if (byHash) {
      return byHash.rect;
    }
  }

  if (androidFeature?.resourceId) {
    const byResourceId = findBestNodeByFeature(tree, androidFeature);
    if (byResourceId) {
      return byResourceId.rect;
    }
  }

  if (androidFeature?.contentDesc || androidFeature?.text) {
    const byContent = findBestNodeByFeature(tree, androidFeature);
    if (byContent) {
      return byContent.rect;
    }
  }

  if (androidFeature?.bounds) {
    const byBounds = findFirstNode(tree, (node) =>
      rectsApproximatelyEqual(node.rect, androidFeature.bounds!),
    );
    if (byBounds) {
      return byBounds.rect;
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
  node: ElementInfo,
  targetDescription?: string,
): AndroidElementCacheFeature {
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

function findSmallestNodeContainingPoint(
  tree: ElementNode,
  center: [number, number],
): ElementInfo | undefined {
  const candidates: ElementInfo[] = [];
  traverseNodes(tree, (node) => {
    if (!node.isVisible) {
      return;
    }
    if (pointInRect(center, node.rect)) {
      candidates.push(node);
    }
  });

  return candidates.sort((a, b) => rectArea(a.rect) - rectArea(b.rect))[0];
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

function rectDistance(a: Rect, b: Rect): number {
  return Math.abs(a.left - b.left) + Math.abs(a.top - b.top);
}

function rectsApproximatelyEqual(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.left - b.left) <= 2 &&
    Math.abs(a.top - b.top) <= 2 &&
    Math.abs(a.width - b.width) <= 2 &&
    Math.abs(a.height - b.height) <= 2
  );
}

function nodeXpaths(node: ElementInfo): string[] {
  return sanitizeStringArray(node.xpaths);
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
