import { NodeType } from '@midscene/shared/constants';
import { describe, expect, it, vi } from 'vitest';
import { AndroidDevice } from '../../src/device';
import {
  locateAndroidElementByPrompt,
  locateAndroidElementCandidates,
  locateAndroidElementWithScore,
} from '../../src/fast-locator';
import {
  buildAndroidScrollRecipe,
  detectAndroidScrollableContainers,
  getAndroidScrollRecipeCache,
} from '../../src/scroll-fast-path';
import {
  buildAndroidCacheFeatureForPoint,
  matchAndroidCacheFeature,
  parseBounds,
  parseUiautomatorXml,
  rectMatchesAndroidCacheFeature,
} from '../../src/ui-tree';

const sampleXml = String.raw`
<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[0,0][200,400]">
    <node index="0" text="Sign in" resource-id="com.example:id/login" class="android.widget.Button" package="com.example" content-desc="Login button" clickable="true" enabled="true" bounds="[20,40][180,100]" />
    <node index="1" text="" resource-id="com.example:id/email" class="android.widget.EditText" package="com.example" content-desc="Email" clickable="true" enabled="true" bounds="[20,120][180,180]" />
  </node>
</hierarchy>
`;

const duplicateRowsXml = String.raw`
<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="com.example:id/list" class="androidx.recyclerview.widget.RecyclerView" package="com.example" content-desc="" clickable="false" enabled="true" scrollable="true" bounds="[0,0][400,500]">
    <node index="0" text="" resource-id="" class="android.widget.LinearLayout" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[0,0][400,100]">
      <node index="0" text="Alice" resource-id="com.example:id/name" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[20,20][180,80]" />
      <node index="1" text="Delete" resource-id="com.example:id/delete" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="true" bounds="[260,20][380,80]" />
    </node>
    <node index="1" text="" resource-id="" class="android.widget.LinearLayout" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[0,100][400,200]">
      <node index="0" text="Bob" resource-id="com.example:id/name" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[20,120][180,180]" />
      <node index="1" text="Delete" resource-id="com.example:id/delete" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="true" bounds="[260,120][380,180]" />
    </node>
  </node>
</hierarchy>
`;

const duplicateRowsReorderedXml = String.raw`
<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="com.example:id/list" class="androidx.recyclerview.widget.RecyclerView" package="com.example" content-desc="" clickable="false" enabled="true" scrollable="true" bounds="[0,0][400,500]">
    <node index="0" text="" resource-id="" class="android.widget.LinearLayout" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[0,0][400,100]">
      <node index="0" text="Bob" resource-id="com.example:id/name" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[20,20][180,80]" />
      <node index="1" text="Delete" resource-id="com.example:id/delete" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="true" bounds="[260,20][380,80]" />
    </node>
    <node index="1" text="" resource-id="" class="android.widget.LinearLayout" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[0,100][400,200]">
      <node index="0" text="Alice" resource-id="com.example:id/name" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[20,120][180,180]" />
      <node index="1" text="Delete" resource-id="com.example:id/delete" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="true" bounds="[260,120][380,180]" />
    </node>
  </node>
</hierarchy>
`;

const duplicateRowsWithoutBobXml = String.raw`
<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="com.example:id/list" class="androidx.recyclerview.widget.RecyclerView" package="com.example" content-desc="" clickable="false" enabled="true" scrollable="true" bounds="[0,0][400,500]">
    <node index="0" text="" resource-id="" class="android.widget.LinearLayout" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[0,0][400,100]">
      <node index="0" text="Alice" resource-id="com.example:id/name" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[20,20][180,80]" />
      <node index="1" text="Delete" resource-id="com.example:id/delete" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="true" bounds="[260,20][380,80]" />
    </node>
    <node index="1" text="" resource-id="" class="android.widget.LinearLayout" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[0,100][400,200]">
      <node index="0" text="Carol" resource-id="com.example:id/name" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[20,120][180,180]" />
      <node index="1" text="Delete" resource-id="com.example:id/delete" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="true" bounds="[260,120][380,180]" />
    </node>
  </node>
</hierarchy>
`;

describe('Android UI tree parser', () => {
  it('parses uiautomator nodes into ElementNode with logical bounds', () => {
    const tree = parseUiautomatorXml(sampleXml, {
      scale: { x: 0.5, y: 0.5 },
    });

    expect(tree.children).toHaveLength(1);
    const root = tree.children[0].node!;
    const login = tree.children[0].children[0].node!;
    const email = tree.children[0].children[1].node!;

    expect(root.rect).toEqual({ left: 0, top: 0, width: 100, height: 200 });
    expect(login).toMatchObject({
      content: 'Sign in Login button',
      nodeType: NodeType.BUTTON,
      rect: { left: 10, top: 20, width: 80, height: 30 },
      center: [50, 35],
    });
    expect(login.xpaths).toEqual(['/hierarchy/node[1]/node[1]']);
    expect(email.nodeType).toBe(NodeType.FORM_ITEM);
  });

  it('builds a reusable cache feature from the smallest node at a point', () => {
    const tree = parseUiautomatorXml(sampleXml, {
      scale: { x: 0.5, y: 0.5 },
    });

    const feature = buildAndroidCacheFeatureForPoint(tree, [50, 35], {
      targetDescription: 'login button',
    });

    expect(feature.xpaths).toEqual(['/hierarchy/node[1]/node[1]']);
    expect(feature.android).toMatchObject({
      resourceId: 'com.example:id/login',
      text: 'Sign in',
      contentDesc: 'Login button',
      className: 'android.widget.Button',
      targetDescription: 'login button',
    });
    expect(feature.androidSelector).toMatchObject({
      target: {
        resourceId: 'com.example:id/login',
        text: 'Sign in',
      },
    });
  });

  it('detects scrollable containers and records scroll recipes in cache features', () => {
    const tree = parseUiautomatorXml(duplicateRowsXml);
    const containers = detectAndroidScrollableContainers(tree);

    expect(containers[0]).toMatchObject({
      rect: { left: 0, top: 0, width: 400, height: 500 },
      reasons: expect.arrayContaining(['scrollable-attr']),
      anchors: expect.arrayContaining(['Alice', 'Bob']),
    });

    const feature = buildAndroidCacheFeatureForPoint(tree, [320, 150], {
      targetDescription: 'Bob delete button',
    });
    expect(feature.androidScroll).toMatchObject({
      container: {
        target: {
          resourceId: 'com.example:id/list',
          className: 'androidx.recyclerview.widget.RecyclerView',
        },
      },
      anchors: expect.arrayContaining(['Alice', 'Bob']),
    });

    const recipe = buildAndroidScrollRecipe(tree, {
      cacheEntry: feature,
      targetText: 'Bob delete button',
    });
    expect(recipe).toMatchObject({
      direction: 'down',
      maxAttempts: 6,
      targetText: 'Bob delete button',
      container: {
        rect: { left: 0, top: 0, width: 400, height: 500 },
      },
    });
    expect(getAndroidScrollRecipeCache(feature)?.anchors).toContain('Bob');
  });

  it('scrolls deterministically until a cached row-scoped target is visible', async () => {
    const targetTree = parseUiautomatorXml(duplicateRowsXml);
    const firstTree = parseUiautomatorXml(duplicateRowsWithoutBobXml);
    const feature = buildAndroidCacheFeatureForPoint(targetTree, [320, 150], {
      targetDescription: 'Bob delete button',
    });
    const device = new AndroidDevice('test-device', {
      diagnostics: false,
      scrollFastPath: { settleMs: 0, maxAttempts: 2 },
    });
    const snapshots = [firstTree, targetTree];
    let snapshotIndex = 0;
    vi.spyOn(device, 'getElementsNodeTree').mockImplementation(async () => {
      return snapshots[snapshotIndex];
    });
    const scrollDown = vi
      .spyOn(device, 'scrollDown')
      .mockImplementation(async () => {
        snapshotIndex = 1;
      });

    const result = await device.scrollUntilVisible(
      { prompt: 'Bob delete button' },
      { cacheEntry: feature },
    );

    expect(scrollDown).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      center: [320, 150],
      rect: { left: 260, top: 120, width: 120, height: 60 },
    });
  });

  it('matches cache features by xpath, semantic attributes, and bounds fallback', () => {
    const tree = parseUiautomatorXml(sampleXml, {
      scale: { x: 0.5, y: 0.5 },
    });
    const reorderedTree = parseUiautomatorXml(
      String.raw`
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[0,0][200,400]">
    <node index="0" text="Cancel" resource-id="com.example:id/cancel" class="android.widget.Button" package="com.example" content-desc="Cancel" clickable="true" enabled="true" bounds="[20,40][180,100]" />
    <node index="1" text="Sign in" resource-id="com.example:id/login" class="android.widget.Button" package="com.example" content-desc="Login button" clickable="true" enabled="true" bounds="[20,200][180,260]" />
  </node>
</hierarchy>
`,
      { scale: { x: 0.5, y: 0.5 } },
    );

    expect(
      rectMatchesAndroidCacheFeature(tree, {
        xpaths: ['/hierarchy/node[1]/node[2]'],
      }),
    ).toEqual({ left: 10, top: 60, width: 80, height: 30 });

    expect(
      rectMatchesAndroidCacheFeature(tree, {
        android: {
          resourceId: 'com.example:id/login',
          text: 'Sign in',
          className: 'android.widget.Button',
        },
      }),
    ).toEqual({ left: 10, top: 20, width: 80, height: 30 });

    expect(
      rectMatchesAndroidCacheFeature(reorderedTree, {
        xpaths: ['/hierarchy/node[1]/node[1]'],
        android: {
          resourceId: 'com.example:id/login',
          text: 'Sign in',
          className: 'android.widget.Button',
        },
      }),
    ).toEqual({ left: 10, top: 100, width: 80, height: 30 });

    expect(
      rectMatchesAndroidCacheFeature(tree, {
        android: {
          bounds: { left: 10, top: 60, width: 80, height: 30 },
        },
      }),
    ).toEqual({ left: 10, top: 60, width: 80, height: 30 });
  });

  it('uses scoped row context when cached xpath points to a repeated element after reorder', () => {
    const originalTree = parseUiautomatorXml(duplicateRowsXml);
    const reorderedTree = parseUiautomatorXml(duplicateRowsReorderedXml);
    const feature = buildAndroidCacheFeatureForPoint(originalTree, [320, 150], {
      targetDescription: 'Bob delete button',
    });

    expect(feature.androidSelector?.rowText).toContain('Bob');

    expect(rectMatchesAndroidCacheFeature(reorderedTree, feature)).toEqual({
      left: 260,
      top: 20,
      width: 120,
      height: 60,
    });
    const match = matchAndroidCacheFeature(reorderedTree, feature);
    expect(match.reasons).toContain('row-text');
  });

  it('rejects ambiguous cache matches when repeated controls have no scoped context', () => {
    const tree = parseUiautomatorXml(duplicateRowsXml);

    expect(() =>
      rectMatchesAndroidCacheFeature(tree, {
        android: {
          text: 'Delete',
          className: 'android.widget.Button',
          packageName: 'com.example',
        },
      }),
    ).toThrow(/Ambiguous Android cache feature/);
  });

  it('parses raw physical bounds with scaling', () => {
    expect(parseBounds('[20,40][180,100]', { x: 0.5, y: 0.5 })).toEqual({
      left: 10,
      top: 20,
      width: 80,
      height: 30,
    });
  });
});

describe('Android fast locator', () => {
  it('finds high-confidence targets from text, content-desc, and resource id', () => {
    const tree = parseUiautomatorXml(sampleXml, {
      scale: { x: 0.5, y: 0.5 },
    });

    const login = locateAndroidElementWithScore(tree, 'login button');
    expect(login?.confidence).toBeGreaterThanOrEqual(0.72);
    expect(login?.element).toMatchObject({
      description: 'Sign in Login button',
      center: [50, 35],
      rect: { left: 10, top: 20, width: 80, height: 30 },
    });

    const email = locateAndroidElementByPrompt(tree, 'email input field');
    expect(email?.center).toEqual([50, 75]);
  });

  it('returns null for low-confidence prompts so AI can fallback', () => {
    const tree = parseUiautomatorXml(sampleXml, {
      scale: { x: 0.5, y: 0.5 },
    });

    expect(
      locateAndroidElementByPrompt(tree, 'checkout button', { minScore: 0.8 }),
    ).toBeNull();
  });

  it('returns compact candidates for AI adjudication', () => {
    const tree = parseUiautomatorXml(sampleXml, {
      scale: { x: 0.5, y: 0.5 },
    });

    const candidates = locateAndroidElementCandidates(tree, 'login', {
      minScore: 0.45,
      maxCandidates: 3,
    });

    expect(candidates[0]).toMatchObject({
      source: 'android-ui-tree',
      reason: expect.any(String),
      element: {
        description: 'Sign in Login button',
        center: [50, 35],
      },
      metadata: {
        resourceId: 'com.example:id/login',
        selector: expect.any(Object),
      },
    });
  });

  it('uses row context and reports ambiguity for repeated structured candidates', () => {
    const tree = parseUiautomatorXml(duplicateRowsXml);

    const bobCandidates = locateAndroidElementCandidates(
      tree,
      'Bob delete button',
      {
        minScore: 0.45,
        maxCandidates: 3,
      },
    );
    expect(bobCandidates[0]).toMatchObject({
      element: {
        center: [320, 150],
      },
      reason: expect.stringContaining('context'),
      metadata: {
        rowText: expect.stringContaining('Bob'),
      },
    });

    expect(
      locateAndroidElementByPrompt(tree, 'delete button', {
        minScore: 0.45,
      }),
    ).toBeNull();
    const ambiguousCandidates = locateAndroidElementCandidates(
      tree,
      'delete button',
      {
        minScore: 0.45,
        maxCandidates: 2,
      },
    );
    expect(ambiguousCandidates[0].metadata).toMatchObject({
      ambiguous: true,
      ambiguity: {
        competitorCount: 1,
      },
    });
  });
});

describe('AndroidDevice UI tree integration', () => {
  it('dumps uiautomator XML and exposes Android cache hooks', async () => {
    const device = new AndroidDevice('test-device', {
      scrcpyConfig: { enabled: false },
    });
    const mockAdb = {
      shell: vi.fn().mockResolvedValue(sampleXml),
    };

    vi.spyOn(device, 'getAdb').mockResolvedValue(mockAdb as any);
    vi.spyOn(device as any, 'getOrientedPhysicalSize').mockResolvedValue({
      width: 200,
      height: 400,
    });
    vi.spyOn(device, 'size').mockResolvedValue({ width: 100, height: 200 });

    const tree = await device.getElementsNodeTree();
    expect(tree.children[0].children[0].node?.content).toBe(
      'Sign in Login button',
    );

    const elements = await device.getElementsInfo();
    expect(elements).toHaveLength(3);

    const feature = await device.cacheFeatureForPoint([50, 35], {
      targetDescription: 'login button',
    });
    expect(feature).toMatchObject({
      xpaths: ['/hierarchy/node[1]/node[1]'],
    });

    await expect(device.rectMatchesCacheFeature(feature)).resolves.toEqual({
      left: 10,
      top: 20,
      width: 80,
      height: 30,
    });
    await expect(
      device.structuredLocate({ prompt: 'login button' }),
    ).resolves.toMatchObject({
      center: [50, 35],
      rect: { left: 10, top: 20, width: 80, height: 30 },
    });
    expect(mockAdb.shell).toHaveBeenCalledWith(
      expect.stringContaining('uiautomator dump --compressed'),
    );
  });
});
