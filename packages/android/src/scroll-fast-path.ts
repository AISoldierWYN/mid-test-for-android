import type { ElementCacheFeature, Rect } from '@midscene/core';
import type { ElementInfo, ElementNode } from '@midscene/shared/extractor';
import {
  type AndroidScopedNodeContext,
  type AndroidScopedSelector,
  buildAndroidScopedSelector,
  collectScopedNodeContexts,
  rectDistance,
  signatureScore,
} from './scoped-selector';

export type AndroidScrollDirection = 'up' | 'down' | 'left' | 'right';

export interface AndroidScrollRecipeCache {
  container?: AndroidScopedSelector;
  containerBounds?: Rect;
  direction?: AndroidScrollDirection;
  maxAttempts?: number;
  anchors?: string[];
}

export interface AndroidScrollableContainer {
  node: ElementInfo;
  rect: Rect;
  center: [number, number];
  selector: AndroidScopedSelector;
  confidence: number;
  reasons: string[];
  anchors: string[];
  orientation: 'vertical' | 'horizontal' | 'both';
}

export interface AndroidScrollRecipe {
  container: AndroidScrollableContainer;
  direction: AndroidScrollDirection;
  distance: number;
  maxAttempts: number;
  targetText?: string;
  anchorsBefore: string[];
}

export interface AndroidScrollRecipeOptions {
  cacheEntry?: ElementCacheFeature;
  direction?: AndroidScrollDirection;
  maxAttempts?: number;
  targetText?: string;
}

const DEFAULT_SCROLL_ATTEMPTS = 6;
const SCROLLABLE_CLASS_PATTERN =
  /RecyclerView|ListView|ScrollView|HorizontalScrollView|NestedScrollView|ViewPager|GridView/i;

export function detectAndroidScrollableContainers(
  tree: ElementNode,
): AndroidScrollableContainer[] {
  return collectScopedNodeContexts(tree)
    .map(buildScrollableContainerCandidate)
    .filter((candidate): candidate is AndroidScrollableContainer =>
      Boolean(candidate),
    )
    .sort((first, second) => {
      if (second.confidence !== first.confidence) {
        return second.confidence - first.confidence;
      }
      return rectArea(second.rect) - rectArea(first.rect);
    });
}

export function findNearestAndroidScrollableContainer(
  context: AndroidScopedNodeContext,
): AndroidScrollableContainer | undefined {
  const ancestorContexts = collectAncestorContexts(context);
  for (const ancestorContext of ancestorContexts) {
    const candidate = buildScrollableContainerCandidate(ancestorContext);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

export function buildAndroidScrollRecipeCache(
  context: AndroidScopedNodeContext,
  options?: {
    direction?: AndroidScrollDirection;
    maxAttempts?: number;
  },
): AndroidScrollRecipeCache | undefined {
  const container = findNearestAndroidScrollableContainer(context);
  if (!container) {
    return undefined;
  }

  return pruneScrollRecipeCache({
    container: container.selector,
    containerBounds: container.rect,
    direction: options?.direction,
    maxAttempts: options?.maxAttempts,
    anchors: container.anchors,
  });
}

export function buildAndroidScrollRecipe(
  tree: ElementNode,
  options: AndroidScrollRecipeOptions = {},
): AndroidScrollRecipe | undefined {
  const cachedRecipe = getAndroidScrollRecipeCache(options.cacheEntry);
  const containers = detectAndroidScrollableContainers(tree);
  if (!containers.length) {
    return undefined;
  }

  const container = chooseScrollContainer(containers, cachedRecipe);
  if (!container) {
    return undefined;
  }

  const direction =
    options.direction ??
    cachedRecipe?.direction ??
    inferDirectionForContainer(container);
  const distance = distanceForContainer(container, direction);

  return {
    container,
    direction,
    distance,
    maxAttempts:
      options.maxAttempts ??
      cachedRecipe?.maxAttempts ??
      DEFAULT_SCROLL_ATTEMPTS,
    targetText: options.targetText,
    anchorsBefore: container.anchors,
  };
}

export function scrollRecipeAnchorSignature(
  recipe: AndroidScrollRecipe,
): string {
  return [
    recipe.container.node.attributes.resourceId,
    recipe.container.node.attributes.className,
    recipe.direction,
    ...recipe.anchorsBefore,
  ]
    .filter(Boolean)
    .join('|');
}

export function getAndroidScrollRecipeCache(
  cacheEntry: ElementCacheFeature | undefined,
): AndroidScrollRecipeCache | undefined {
  if (!cacheEntry || typeof cacheEntry !== 'object') {
    return undefined;
  }
  const recipe = (cacheEntry as { androidScroll?: AndroidScrollRecipeCache })
    .androidScroll;
  return recipe?.container || recipe?.containerBounds || recipe?.anchors?.length
    ? recipe
    : undefined;
}

function buildScrollableContainerCandidate(
  context: AndroidScopedNodeContext,
): AndroidScrollableContainer | undefined {
  const node = context.node;
  if (!node.isVisible || node.rect.width <= 0 || node.rect.height <= 0) {
    return undefined;
  }

  const attrs = node.attributes;
  const className = attrs.className || '';
  const childCount = context.tree.children.filter((child) => {
    return child.node?.isVisible;
  }).length;
  const reasons: string[] = [];
  let score = 0;

  if (attrs.scrollable === 'true') {
    score += 0.52;
    reasons.push('scrollable-attr');
  }
  if (SCROLLABLE_CLASS_PATTERN.test(className)) {
    score += 0.34;
    reasons.push('scrollable-class');
  }
  if (childCount >= 2) {
    score += 0.08;
    reasons.push('multiple-children');
  }
  if (node.rect.height >= 180 || node.rect.width >= 180) {
    score += 0.06;
    reasons.push('large-bounds');
  }

  if (score < 0.45) {
    return undefined;
  }

  const rect = node.rect;
  return {
    node,
    rect,
    center: [
      Math.round(rect.left + rect.width / 2),
      Math.round(rect.top + rect.height / 2),
    ],
    selector: buildAndroidScopedSelector(context),
    confidence: Math.min(1, score),
    reasons,
    anchors: collectVisibleAnchorTexts(context.tree),
    orientation: inferOrientation(node),
  };
}

function chooseScrollContainer(
  containers: AndroidScrollableContainer[],
  cachedRecipe: AndroidScrollRecipeCache | undefined,
): AndroidScrollableContainer | undefined {
  if (!cachedRecipe) {
    return containers[0];
  }

  const scored = containers
    .map((container) => ({
      container,
      score: scoreContainerAgainstRecipe(container, cachedRecipe),
    }))
    .sort((first, second) => second.score - first.score);

  return scored[0]?.score >= 0.45 ? scored[0].container : containers[0];
}

function scoreContainerAgainstRecipe(
  container: AndroidScrollableContainer,
  cachedRecipe: AndroidScrollRecipeCache,
): number {
  let score = 0;
  let weight = 0;

  if (cachedRecipe.container?.target) {
    const result = signatureScore(
      cachedRecipe.container.target,
      container.node,
    );
    if (result.compared) {
      score += result.score * 0.7;
      weight += 0.7;
    }
  }

  if (cachedRecipe.containerBounds) {
    const distance = rectDistance(container.rect, cachedRecipe.containerBounds);
    score += Math.max(0, 1 - distance / 360) * 0.2;
    weight += 0.2;
  }

  if (cachedRecipe.anchors?.length) {
    const anchorScore = anchorOverlap(cachedRecipe.anchors, container.anchors);
    score += anchorScore * 0.1;
    weight += 0.1;
  }

  return weight ? score / weight : 0;
}

function collectAncestorContexts(
  context: AndroidScopedNodeContext,
): AndroidScopedNodeContext[] {
  const allContexts = collectScopedNodeContexts(context.root);
  const ancestors = context.ancestors
    .slice()
    .reverse()
    .map((ancestor) =>
      allContexts.find((candidate) => candidate.node === ancestor),
    )
    .filter((candidate): candidate is AndroidScopedNodeContext =>
      Boolean(candidate),
    );
  return ancestors;
}

function collectVisibleAnchorTexts(tree: ElementNode, limit = 8): string[] {
  const anchors: string[] = [];
  visitTree(tree, (node) => {
    if (!node.isVisible) {
      return;
    }
    const text = compactText(
      [node.attributes.text, node.attributes.contentDescription]
        .filter(Boolean)
        .join(' '),
    );
    if (text && !anchors.includes(text)) {
      anchors.push(text);
    }
  });
  return anchors.slice(0, limit);
}

function visitTree(
  tree: ElementNode,
  visit: (node: ElementInfo) => void,
): void {
  if (tree.node) {
    visit(tree.node);
  }
  for (const child of tree.children) {
    visitTree(child, visit);
  }
}

function anchorOverlap(expected: string[], actual: string[]): number {
  const actualSet = new Set(actual.map((item) => item.toLowerCase()));
  const comparable = expected.filter(Boolean);
  if (!comparable.length) {
    return 0;
  }
  const matched = comparable.filter((item) =>
    actualSet.has(item.toLowerCase()),
  );
  return matched.length / comparable.length;
}

function inferOrientation(
  node: ElementInfo,
): AndroidScrollableContainer['orientation'] {
  const className = node.attributes.className || '';
  if (/HorizontalScrollView|ViewPager/i.test(className)) {
    return 'horizontal';
  }
  if (node.rect.width > node.rect.height * 1.8) {
    return 'horizontal';
  }
  return 'vertical';
}

function inferDirectionForContainer(
  container: AndroidScrollableContainer,
): AndroidScrollDirection {
  return container.orientation === 'horizontal' ? 'right' : 'down';
}

function distanceForContainer(
  container: AndroidScrollableContainer,
  direction: AndroidScrollDirection,
): number {
  const axisSize =
    direction === 'left' || direction === 'right'
      ? container.rect.width
      : container.rect.height;
  return Math.max(80, Math.round(axisSize * 0.72));
}

function pruneScrollRecipeCache(
  recipe: AndroidScrollRecipeCache,
): AndroidScrollRecipeCache {
  return Object.fromEntries(
    Object.entries(recipe).filter(([, value]) => {
      if (Array.isArray(value)) {
        return value.length > 0;
      }
      return value !== undefined && value !== null;
    }),
  ) as AndroidScrollRecipeCache;
}

function rectArea(rect: Rect): number {
  return rect.width * rect.height;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 80);
}
