import { playgroundForAgent } from '@midscene/playground';
import dotenv from 'dotenv';
import { agentFromAdbDevice, getConnectedDevices } from '../src';

dotenv.config({
  path: '../../.env',
});

const DEFAULT_PORT = 5809;
const DEFAULT_CACHE_ID = 'android-playground-cache';

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

function readPort(): number {
  const raw = process.env.ANDROID_PLAYGROUND_PORT;
  if (!raw) {
    return DEFAULT_PORT;
  }
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid ANDROID_PLAYGROUND_PORT: ${raw}`);
  }
  return port;
}

async function main() {
  const devices = await getConnectedDevices();
  if (devices.length === 0) {
    throw new Error(
      'No Android devices available. Make sure ADB is installed and devices are connected.',
    );
  }

  console.log(`Found ${devices.length} Android device(s):`);
  devices.forEach((device, index) => {
    console.log(
      `  ${index + 1}. ${device.udid} - ${device.state || 'unknown'}`,
    );
  });

  const targetDevice = devices[0];
  const port = readPort();
  const cacheId =
    process.env.ANDROID_PLAYGROUND_CACHE_ID ||
    `${DEFAULT_CACHE_ID}-${targetDevice.udid}`;
  const helperEnabled = readBooleanEnv('ANDROID_PLAYGROUND_HELPER', true);

  console.log(`Using device: ${targetDevice.udid}`);
  console.log(`Cache enabled: ${cacheId}`);
  console.log('Diagnostics enabled: true');
  console.log('Structured locate enabled: true');
  console.log('Candidate adjudication enabled: true');
  console.log(
    `Helper enabled: ${helperEnabled} (falls back to ADB when helper APK is unavailable)`,
  );

  const agent = await agentFromAdbDevice(targetDevice.udid, {
    cache: {
      id: cacheId,
      strategy: 'read-write',
    },
    diagnostics: {
      enabled: true,
      collectForegroundState: true,
      maxEvents: 1000,
    },
    scrcpyConfig: {
      enabled: true,
    },
    structuredLocate: {
      enabled: true,
      minScore: 0.72,
      minCandidateScore: 0.45,
      maxCandidates: 5,
    },
    candidateAdjudication: {
      enabled: true,
      maxCandidates: 5,
      minConfidence: 0.45,
      autoAcceptConfidence: 0.92,
    },
    helper: helperEnabled
      ? {
          adbForward: true,
          timeoutMs: 1000,
          failOnUnavailable: false,
          disableOnFailure: true,
        }
      : false,
    aiActionContext:
      'If any location, permission, user agreement, cookies popup, click agree or allow. If login page pops up, close it. Prefer visible Android native controls and avoid repeated loops.',
  });

  const server = await playgroundForAgent(agent).launch({
    port,
    openBrowser: readBooleanEnv('ANDROID_PLAYGROUND_OPEN_BROWSER', true),
    verbose: true,
  });

  console.log(`Generated Server ID: ${server.server.id}`);
  console.log(`Android Playground running at http://localhost:${port}`);
  console.log(`Connected to: ${targetDevice.udid}`);
  console.log('Press Ctrl+C to stop the playground.');

  await new Promise(() => {});
}

main().catch((err) => {
  console.error('Android Playground failed to start:');
  console.error(err);
  console.error('\nMake sure:');
  console.error('1. Android device is connected via USB or WiFi');
  console.error('2. USB debugging is enabled on the device');
  console.error('3. ADB is installed and working (try: adb devices)');
  console.error('4. Device is unlocked');
  console.error('5. ANDROID_HOME or ANDROID_SDK_ROOT points to Android SDK');
  process.exit(1);
});
