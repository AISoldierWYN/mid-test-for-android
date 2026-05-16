import { describe, expect, it, vi } from 'vitest';
import {
  evaluateAndroidAssertion,
  extractAndroidDeterministic,
  extractAndroidUiTree,
} from '../../src/assertion';
import { parseUiautomatorXml } from '../../src/ui-tree';

const sampleXml = String.raw`
<hierarchy rotation="0">
  <node index="0" text="" resource-id="com.example:id/root" class="android.widget.LinearLayout" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[0,0][400,800]">
    <node index="0" text="WLAN" resource-id="com.example:id/title" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[20,40][180,100]" />
    <node index="1" text="Connected" resource-id="com.example:id/status" class="android.widget.TextView" package="com.example" content-desc="Connection status" clickable="false" enabled="true" bounds="[20,120][220,180]" />
    <node index="2" text="" resource-id="com.example:id/wifi_switch" class="android.widget.Switch" package="com.example" content-desc="Wi-Fi switch" clickable="true" enabled="true" checked="true" bounds="[300,120][380,180]" />
  </node>
</hierarchy>
`;

describe('Android deterministic assertions and extraction', () => {
  it('extracts structured UI tree data without screenshots', () => {
    const result = extractAndroidUiTree(parseUiautomatorXml(sampleXml), {
      textContains: 'connected',
      includeBounds: true,
    });

    expect(result).toMatchObject({
      source: 'ui-tree',
      count: 1,
      texts: ['Connected', 'Connection status'],
    });
    expect(result.nodes[0]).toMatchObject({
      text: 'Connected',
      resourceId: 'com.example:id/status',
      rect: { left: 20, top: 120, width: 200, height: 60 },
    });
  });

  it('evaluates UI predicates through the UI tree provider', async () => {
    const providers = createProviders();

    const result = await evaluateAndroidAssertion(
      {
        ui: {
          anyText: ['Unavailable', 'WLAN'],
          allText: ['Connected'],
          noneText: ['Airplane mode'],
          nodes: [
            {
              resourceId: 'com.example:id/wifi_switch',
              checked: true,
              clickable: true,
            },
          ],
        },
      },
      providers,
    );

    expect(result.pass).toBe(true);
    expect(result.source).toEqual(['ui-tree']);
    expect(providers.getUiTree).toHaveBeenCalledTimes(1);
    expect(providers.getSystemState).not.toHaveBeenCalled();
  });

  it('evaluates system, permission, notification, logcat, and shell predicates', async () => {
    const providers = createProviders();

    const result = await evaluateAndroidAssertion(
      {
        foreground: {
          packageName: 'com.example',
          activity: { contains: 'MainActivity' },
        },
        settings: [
          {
            namespace: 'global',
            key: 'wifi_on',
            value: '1',
          },
        ],
        properties: [
          {
            key: 'ro.build.version.sdk',
            value: { matches: '^35$' },
          },
        ],
        permissions: [
          {
            packageName: 'com.example',
            permission: 'android.permission.CAMERA',
            granted: true,
          },
        ],
        notifications: [
          {
            packageName: 'com.example',
            anyText: ['Download complete'],
          },
        ],
        logcat: {
          command: 'logcat -d -t 10',
          contains: ['ActivityTaskManager'],
        },
        shell: [
          {
            command: 'settings get global wifi_on',
            value: '1',
          },
        ],
      },
      providers,
    );

    expect(result.pass).toBe(true);
    expect(result.source).toEqual([
      'system-state',
      'permissions',
      'notifications',
      'logcat',
      'shell',
    ]);
    expect(providers.getSystemState).toHaveBeenCalledWith({
      include: ['foreground', 'settings', 'properties'],
      settings: [{ namespace: 'global', key: 'wifi_on' }],
      properties: ['ro.build.version.sdk'],
    });
    expect(providers.runShell).toHaveBeenCalledWith('logcat -d -t 10');
    expect(providers.runShell).toHaveBeenCalledWith(
      'settings get global wifi_on',
    );
  });

  it('extracts deterministic provider data by source', async () => {
    const providers = createProviders();

    const result = await extractAndroidDeterministic(
      {
        source: 'system',
        system: {
          include: ['properties'],
          properties: ['ro.build.version.sdk'],
        },
      },
      providers,
    );

    expect(result).toMatchObject({
      source: 'system-state',
      data: {
        properties: [{ key: 'ro.build.version.sdk', value: '35' }],
      },
    });
    expect(providers.getSystemState).toHaveBeenCalledWith({
      include: ['properties'],
      properties: ['ro.build.version.sdk'],
    });
  });

  it('reports failed deterministic checks instead of silently passing', async () => {
    const result = await evaluateAndroidAssertion(
      {
        ui: {
          allText: ['Bluetooth'],
        },
      },
      createProviders(),
    );

    expect(result.pass).toBe(false);
    expect(result.checks).toMatchObject([
      {
        source: 'ui-tree',
        name: 'ui:allText:Bluetooth',
        pass: false,
      },
    ]);
  });
});

function createProviders() {
  return {
    getUiTree: vi.fn().mockResolvedValue(parseUiautomatorXml(sampleXml)),
    getSystemState: vi.fn().mockResolvedValue({
      source: 'adb',
      foreground: {
        packageName: 'com.example',
        activity: '.MainActivity',
      },
      settings: [{ namespace: 'global', key: 'wifi_on', value: '1' }],
      properties: [{ key: 'ro.build.version.sdk', value: '35' }],
    }),
    getPermissions: vi.fn().mockResolvedValue({
      handled: true,
      packageName: 'com.example',
      permissions: [{ permission: 'android.permission.CAMERA', granted: true }],
    }),
    getNotifications: vi.fn().mockResolvedValue({
      handled: true,
      notifications: [
        {
          packageName: 'com.example',
          title: 'Download',
          text: 'Download complete',
        },
      ],
    }),
    runShell: vi.fn(async (command: string) => {
      if (command.startsWith('logcat')) {
        return 'ActivityTaskManager: displayed com.example/.MainActivity';
      }
      if (command === 'settings get global wifi_on') {
        return '1\n';
      }
      return '';
    }),
  };
}
