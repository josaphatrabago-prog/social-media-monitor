/** Config loading, secret handling and schedule specs. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, describe, test } from './harness.js';
import { ConfigStore, loadEnvFile, validateConfig, DEFAULTS, deepMerge } from '../src/config.js';
import { parseCron, isValidCron } from '../src/util/cron.js';
import { parseFrequency, isValidFrequency, describeSeconds, MIN_INTERVAL_SECONDS } from '../src/util/frequency.js';
import { toCsv } from '../src/util/csv.js';

let counter = 0;

/** Writes a throwaway project directory containing config.json (and .env). */
function projectDir(config, envFile) {
  counter += 1;
  const directory = path.join(os.tmpdir(), `smm-cfg-${process.pid}-${counter}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify(config, null, 2));
  if (envFile) fs.writeFileSync(path.join(directory, '.env'), envFile);
  return directory;
}

function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

const MINIMAL_CONFIG = {
  companies: [{ id: 'acme', name: 'Acme Corp', aliases: ['Acme'] }],
  monitoring: { frequency: '5m', enabledPlatforms: ['youtube'] }
};

describe('cron', () => {
  test('parses step, list, range and name syntax', () => {
    assert.ok(isValidCron('*/10 * * * *'));
    assert.ok(isValidCron('15,45 * * * *'));
    assert.ok(isValidCron('0 9-17 * * MON-FRI'));
    assert.ok(isValidCron('0 0 1 JAN *'));
  });

  test('rejects malformed expressions', () => {
    for (const bad of ['* * *', '99 * * * *', '* * * * * *', 'nonsense', '*/0 * * * *']) {
      assert.notOk(isValidCron(bad), `"${bad}" should be rejected`);
    }
  });

  test('nextRun finds the next matching minute', () => {
    const next = parseCron('*/10 * * * *').nextRun(new Date('2026-08-26T10:03:00'));
    assert.equal(next.getMinutes(), 10);
    assert.equal(next.getHours(), 10);
  });

  test('nextRun rolls over to the following day', () => {
    const next = parseCron('0 0 * * *').nextRun(new Date('2026-08-26T10:03:00'));
    assert.equal(next.getDate(), 27);
    assert.equal(next.getHours(), 0);
  });

  test('nextRun skips non-matching weekdays', () => {
    // 2026-08-29 is a Saturday, so the next weekday 09:00 is Monday the 31st.
    const next = parseCron('0 9 * * MON-FRI').nextRun(new Date('2026-08-29T10:00:00'));
    assert.equal(next.getDate(), 31);
    assert.equal(next.getHours(), 9);
  });

  test('nextRun is always strictly in the future', () => {
    const from = new Date('2026-08-26T10:00:00');
    assert.ok(parseCron('* * * * *').nextRun(from).getTime() > from.getTime());
  });

  test('treats 7 as Sunday', () => {
    assert.ok(parseCron('0 0 * * 7').matches(new Date('2026-08-30T00:00:00')));
  });
});

describe('frequency', () => {
  test('accepts every documented preset', () => {
    for (const [preset, seconds] of Object.entries({
      realtime: 30, '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '12h': 43200
    })) {
      const parsed = parseFrequency(preset);
      assert.equal(parsed.kind, 'interval');
      assert.equal(parsed.seconds, seconds, `preset ${preset}`);
    }
  });

  test('accepts durations, bare seconds and numbers', () => {
    assert.equal(parseFrequency('45s').seconds, 45);
    assert.equal(parseFrequency('2h').seconds, 7200);
    assert.equal(parseFrequency('90').seconds, 90);
    assert.equal(parseFrequency(120).seconds, 120);
  });

  test('enforces the polling floor', () => {
    assert.equal(parseFrequency('1s').seconds, MIN_INTERVAL_SECONDS);
    assert.equal(parseFrequency(0).seconds, MIN_INTERVAL_SECONDS);
  });

  test('accepts cron with and without the prefix', () => {
    assert.equal(parseFrequency('cron:*/10 * * * *').kind, 'cron');
    assert.equal(parseFrequency('0 9 * * MON-FRI').kind, 'cron');
    assert.equal(parseFrequency('0 9 * * MON-FRI').source, 'cron:0 9 * * MON-FRI');
  });

  test('rejects unparseable input with a helpful message', () => {
    const error = assert.throws(() => parseFrequency('banana'));
    assert.includes(error.message, 'cannot understand');
    assert.notOk(isValidFrequency('banana'));
    assert.notOk(isValidFrequency(''));
  });

  test('describeSeconds is human readable', () => {
    assert.equal(describeSeconds(30), 'every 30s');
    assert.equal(describeSeconds(300), 'every 5m');
    assert.equal(describeSeconds(3600), 'every 1h');
    assert.equal(describeSeconds(43200), 'every 12h');
  });
});

describe('config store', () => {
  test('loads config.json and merges defaults', () => {
    const directory = projectDir(MINIMAL_CONFIG);
    try {
      const store = new ConfigStore(path.join(directory, 'config.json'));
      store.load();

      assert.equal(store.get().companies[0].id, 'acme');
      assert.equal(store.get().monitoring.frequency, '5m');
      // Untouched sections come from the defaults.
      assert.equal(store.get().crisis.windowMinutes, DEFAULTS.crisis.windowMinutes);
      assert.equal(store.get().server.port, DEFAULTS.server.port);
    } finally {
      cleanup(directory);
    }
  });

  test('resolves env: placeholders from .env', () => {
    const directory = projectDir(
      {
        ...MINIMAL_CONFIG,
        platforms: { youtube: { apiKey: 'env:TEST_YT_KEY' } }
      },
      'TEST_YT_KEY=abc123secret\n# a comment\nQUOTED="quoted value"\n'
    );

    try {
      delete process.env.TEST_YT_KEY;
      delete process.env.QUOTED;

      const store = new ConfigStore(path.join(directory, 'config.json'));
      store.load();

      assert.equal(store.get().platforms.youtube.apiKey, 'abc123secret');
      assert.equal(process.env.QUOTED, 'quoted value', 'quotes should be stripped');
      assert.equal(store.raw.platforms.youtube.apiKey, 'env:TEST_YT_KEY', 'raw keeps the placeholder');
    } finally {
      delete process.env.TEST_YT_KEY;
      delete process.env.QUOTED;
      cleanup(directory);
    }
  });

  test('an unset placeholder resolves to an empty string', () => {
    const directory = projectDir({
      ...MINIMAL_CONFIG,
      platforms: { youtube: { apiKey: 'env:DEFINITELY_NOT_SET_12345' } }
    });

    try {
      const store = new ConfigStore(path.join(directory, 'config.json'));
      store.load();
      assert.equal(store.get().platforms.youtube.apiKey, '');
    } finally {
      cleanup(directory);
    }
  });

  test('does not overwrite a real env var with a .env value', () => {
    const directory = projectDir(MINIMAL_CONFIG, 'PRESET_VAR=from-file\n');
    try {
      process.env.PRESET_VAR = 'from-environment';
      loadEnvFile(path.join(directory, '.env'));
      assert.equal(process.env.PRESET_VAR, 'from-environment');
    } finally {
      delete process.env.PRESET_VAR;
      cleanup(directory);
    }
  });

  test('save() writes placeholders, never resolved secrets', () => {
    const directory = projectDir(
      { ...MINIMAL_CONFIG, platforms: { youtube: { apiKey: 'env:TEST_SAVE_KEY' } } },
      'TEST_SAVE_KEY=super-secret-value\n'
    );

    try {
      const configPath = path.join(directory, 'config.json');
      const store = new ConfigStore(configPath);
      store.load();
      store.save();

      const onDisk = fs.readFileSync(configPath, 'utf8');
      assert.includes(onDisk, 'env:TEST_SAVE_KEY');
      assert.notOk(onDisk.includes('super-secret-value'), 'secret must not be written to disk');
    } finally {
      delete process.env.TEST_SAVE_KEY;
      cleanup(directory);
    }
  });

  test('redacted() masks secret-looking values', () => {
    const directory = projectDir(
      { ...MINIMAL_CONFIG, platforms: { youtube: { apiKey: 'env:TEST_REDACT_KEY' } } },
      'TEST_REDACT_KEY=abcdefghijklmnop\n'
    );

    try {
      const store = new ConfigStore(path.join(directory, 'config.json'));
      store.load();

      const masked = store.redacted().platforms.youtube.apiKey;
      assert.notOk(masked.includes('efghijklmn'), 'the middle must be hidden');
      assert.includes(masked, '...');
      assert.equal(store.redacted().companies[0].name, 'Acme Corp', 'non-secrets stay readable');
    } finally {
      delete process.env.TEST_REDACT_KEY;
      cleanup(directory);
    }
  });

  test('update() applies a patch and rolls back an invalid one', () => {
    const directory = projectDir(MINIMAL_CONFIG);
    try {
      const store = new ConfigStore(path.join(directory, 'config.json'));
      store.load();

      store.update({ crisis: { negativeThreshold: 9 } });
      assert.equal(store.get().crisis.negativeThreshold, 9);

      assert.throws(() => store.update({ crisis: { negativeThreshold: 0 } }), 'at least 1');
      assert.equal(store.get().crisis.negativeThreshold, 9, 'should roll back to the last good value');
    } finally {
      cleanup(directory);
    }
  });

  test('CLI overrides apply at runtime but are never saved', () => {
    const directory = projectDir(MINIMAL_CONFIG);
    try {
      const configPath = path.join(directory, 'config.json');
      const store = new ConfigStore(configPath);
      store.load();

      store.setOverrides({ monitoring: { frequency: '15s', mockMode: 'on' } });
      assert.equal(store.get().monitoring.frequency, '15s');
      assert.equal(store.raw.monitoring.frequency, '5m', 'raw must be untouched');

      store.save();
      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.equal(onDisk.monitoring.frequency, '5m', 'the flag must not persist');
    } finally {
      cleanup(directory);
    }
  });

  test('an explicit update wins over a CLI override for the same key', () => {
    const directory = projectDir(MINIMAL_CONFIG);
    try {
      const store = new ConfigStore(path.join(directory, 'config.json'));
      store.load();

      store.setOverrides({ monitoring: { frequency: '15s' } });
      store.update({ monitoring: { frequency: '1h' } });

      assert.equal(store.get().monitoring.frequency, '1h', 'the override must stop shadowing');
    } finally {
      cleanup(directory);
    }
  });

  test('throws a readable error for malformed JSON', () => {
    counter += 1;
    const directory = path.join(os.tmpdir(), `smm-cfg-bad-${process.pid}-${counter}`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'config.json'), '{ not json');

    try {
      const store = new ConfigStore(path.join(directory, 'config.json'));
      assert.throws(() => store.load(), 'not valid JSON');
    } finally {
      cleanup(directory);
    }
  });
});

describe('config validation', () => {
  /** DEFAULTS plus a valid company, so only the field under test is wrong. */
  function withConfig(overrides) {
    return deepMerge(deepMerge(DEFAULTS, {
      companies: [{ id: 'acme', name: 'Acme Corp' }]
    }), overrides);
  }

  test('accepts a valid config with no errors', () => {
    const { errors } = validateConfig(withConfig({}));
    assert.deepEqual(errors, []);
  });

  test('requires at least one company', () => {
    const { errors } = validateConfig(deepMerge(DEFAULTS, { companies: [] }));
    assert.includes(errors.join(' '), 'at least one company');
  });

  test('rejects duplicate company ids', () => {
    const { errors } = validateConfig(withConfig({
      companies: [{ id: 'acme', name: 'A' }, { id: 'acme', name: 'B' }]
    }));
    assert.includes(errors.join(' '), 'duplicated');
  });

  test('rejects an invalid frequency', () => {
    const { errors } = validateConfig(withConfig({ monitoring: { frequency: 'banana' } }));
    assert.includes(errors.join(' '), 'not a valid frequency');
  });

  test('rejects a non-https webhook URL', () => {
    const { errors } = validateConfig(withConfig({
      notifications: { webhooks: [{ name: 'x', type: 'slack', url: 'http://insecure.example', enabled: true }] }
    }));
    assert.includes(errors.join(' '), 'must be an https URL');
  });

  test('rejects an unknown webhook type', () => {
    const { errors } = validateConfig(withConfig({
      notifications: { webhooks: [{ name: 'x', type: 'carrier-pigeon', enabled: false }] }
    }));
    assert.includes(errors.join(' '), 'must be slack, discord, teams or generic');
  });

  test('warns rather than fails for an enabled webhook with no URL', () => {
    const { errors, warnings } = validateConfig(withConfig({
      notifications: { webhooks: [{ name: 'Ops', type: 'slack', url: '', enabled: true }] }
    }));

    assert.deepEqual(errors, [], 'a missing secret must not stop startup');
    assert.includes(warnings.join(' '), 'no URL');
  });

  test('warns for an unknown platform instead of failing', () => {
    const { errors, warnings } = validateConfig(withConfig({
      monitoring: { enabledPlatforms: ['facebook', 'myspace'] }
    }));

    assert.deepEqual(errors, []);
    assert.includes(warnings.join(' '), 'myspace');
  });

  test('rejects an invalid port and bad crisis numbers', () => {
    assert.includes(validateConfig(withConfig({ server: { port: 99999 } })).errors.join(' '), 'valid port');
    assert.includes(validateConfig(withConfig({ crisis: { windowMinutes: 0 } })).errors.join(' '), 'greater than 0');
    assert.includes(validateConfig(withConfig({ crisis: { baselineMultiplier: 0 } })).errors.join(' '), 'at least 1');
  });

  test('rejects inverted sentiment thresholds', () => {
    const { errors } = validateConfig(withConfig({
      sentiment: { positiveThreshold: -5, negativeThreshold: 5 }
    }));
    assert.includes(errors.join(' '), 'positiveThreshold must be >=');
  });
});

describe('csv export', () => {
  const columns = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }];

  test('quotes commas, quotes and newlines', () => {
    const csv = toCsv([{ a: 'has, comma', b: 'say "hi"' }, { a: 'line\nbreak', b: 'x' }], columns);
    assert.includes(csv, '"has, comma"');
    assert.includes(csv, '"say ""hi"""');
    assert.includes(csv, '"line\nbreak"');
  });

  test('neutralises formula injection in text', () => {
    const csv = toCsv([{ a: '=SUM(A1:A2)', b: '@handle' }], columns);
    assert.includes(csv, "'=SUM(A1:A2)");
    assert.includes(csv, "'@handle");
  });

  test('leaves negative numbers usable as numbers', () => {
    // Apostrophe-quoting "-0.647" would make Excel store the score as text and
    // break every average built on the column.
    const csv = toCsv([{ a: -0.647, b: '-1.5' }], columns);
    assert.includes(csv, '-0.647');
    assert.notOk(csv.includes("'-0.647"), 'numbers must not be apostrophe-quoted');
    assert.notOk(csv.includes("'-1.5"), 'numeric strings must not be apostrophe-quoted');
  });

  test('writes a header, a BOM and CRLF line endings', () => {
    const csv = toCsv([{ a: 1, b: 2 }], columns);
    assert.ok(csv.startsWith('﻿'), 'BOM keeps non-ASCII readable in Excel');
    assert.includes(csv, 'A,B\r\n');
  });

  test('renders empty values and objects safely', () => {
    const csv = toCsv([{ a: null, b: undefined }, { a: { nested: true }, b: '' }], columns);
    assert.includes(csv, '\r\n,\r\n');
    assert.includes(csv, '"{""nested"":true}"');
  });
});
