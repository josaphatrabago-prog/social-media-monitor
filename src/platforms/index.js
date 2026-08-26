/**
 * Connector registry.
 *
 * Decides, per enabled platform, which implementation actually runs:
 *
 *   mockMode "on"    every platform is served by the mock generator
 *   mockMode "off"   only real connectors; unconfigured platforms are reported
 *                    as skipped rather than silently producing nothing
 *   mockMode "auto"  real connectors where credentials exist; if none exist at
 *                    all, fall back to mock so a fresh checkout still runs
 *
 * When a native connector is unconfigured but platforms.aggregator has an actor
 * for that platform, the aggregator takes over for it.
 */
import { createLogger } from '../log.js';
import { FacebookConnector } from './facebook.js';
import { YouTubeConnector } from './youtube.js';
import { TikTokConnector } from './tiktok.js';
import { InstagramConnector } from './instagram.js';
import { AggregatorConnector } from './aggregator.js';
import { MockConnector } from './mock.js';

const log = createLogger('platforms');

const NATIVE_CONNECTORS = {
  facebook: FacebookConnector,
  youtube: YouTubeConnector,
  tiktok: TikTokConnector,
  instagram: InstagramConnector
};

/** Display name for a platform key, used before a connector exists. */
export function platformLabel(key) {
  const Connector = NATIVE_CONNECTORS[key];
  return Connector ? Connector.platform : key;
}

/**
 * @typedef {Object} ConnectorSlot
 * @property {string} key           platform key, e.g. "youtube"
 * @property {string} platform      display name, e.g. "YouTube"
 * @property {Object|null} connector runnable connector, or null when skipped
 * @property {'native'|'aggregator'|'mock'|'skipped'} mode
 * @property {string|null} reason   why it is skipped or synthetic
 */

/**
 * @param {{config: Object, matcher: Object}} options
 * @returns {{slots: ConnectorSlot[], mock: MockConnector|null, mockMode: boolean}}
 */
export function createConnectors({ config, matcher }) {
  const { monitoring, platforms = {} } = config;
  const enabled = monitoring.enabledPlatforms || [];

  // Probe every native connector first, so "auto" can see the whole picture
  // before choosing between real and synthetic data.
  const probes = enabled.map((key) => {
    const Connector = NATIVE_CONNECTORS[key];
    if (!Connector) {
      return { key, platform: key, connector: null, missing: [`unknown platform "${key}"`] };
    }

    const connector = new Connector({
      settings: platforms[key] || {},
      monitoring,
      matcher
    });

    return { key, platform: connector.platform, connector, missing: connector.missingCredentials() };
  });

  const anyNativeReady = probes.some((probe) => probe.missing.length === 0);
  const useMock = monitoring.mockMode === 'on' ||
    (monitoring.mockMode === 'auto' && !anyNativeReady);

  if (useMock) {
    const reason = monitoring.mockMode === 'on'
      ? 'mockMode is "on"'
      : 'no platform credentials found (mockMode "auto")';
    log.warn(`running on SYNTHETIC data - ${reason}`);
  }

  const itemsPerPoll = Math.max(1, Math.min(4, Math.ceil((monitoring.maxItemsPerPoll || 25) / 12)));
  const mocks = [];

  const slots = probes.map((probe) => {
    if (useMock) {
      // One generator per platform, so each poll's items really belong to the
      // platform that reported them.
      const mock = new MockConnector({
        settings: {},
        monitoring,
        matcher,
        itemsPerPoll,
        forcePlatform: probe.platform
      });
      mocks.push(mock);

      return {
        key: probe.key,
        platform: probe.platform,
        connector: mock,
        mode: 'mock',
        reason: 'synthetic data'
      };
    }

    if (probe.missing.length === 0) {
      return {
        key: probe.key,
        platform: probe.platform,
        connector: probe.connector,
        mode: 'native',
        reason: null
      };
    }

    // Native credentials missing - try the aggregator for this platform.
    const aggregator = new AggregatorConnector({
      settings: platforms.aggregator || {},
      monitoring,
      matcher,
      targetPlatform: probe.platform
    });

    if (aggregator.isConfigured) {
      log.info(`${probe.platform}: using aggregator (native credentials missing)`);
      return {
        key: probe.key,
        platform: probe.platform,
        connector: aggregator,
        mode: 'aggregator',
        reason: `via ${platforms.aggregator?.provider || 'apify'}`
      };
    }

    const reason = `missing ${probe.missing.join(', ')}`;
    log.warn(`${probe.platform}: skipped - ${reason}`);

    return {
      key: probe.key,
      platform: probe.platform,
      connector: null,
      mode: 'skipped',
      reason
    };
  });

  // A facade so callers can queue a crisis without knowing there are several
  // generators behind it.
  const mockFacade = mocks.length === 0 ? null : {
    generators: mocks,
    queueCrisis(count = 6) {
      // Spread the burst across platforms, which is what a real pile-on looks
      // like and exercises the per-platform breakdown in the alert.
      const perPlatform = Math.max(1, Math.floor(count / mocks.length));
      let remaining = count;

      for (const [index, mock] of mocks.entries()) {
        const share = index === mocks.length - 1 ? remaining : Math.min(perPlatform, remaining);
        if (share > 0) mock.queueCrisis(share);
        remaining -= share;
      }

      return count;
    }
  };

  return { slots, mock: mockFacade, mockMode: useMock };
}

export {
  FacebookConnector,
  YouTubeConnector,
  TikTokConnector,
  InstagramConnector,
  AggregatorConnector,
  MockConnector,
  NATIVE_CONNECTORS
};
