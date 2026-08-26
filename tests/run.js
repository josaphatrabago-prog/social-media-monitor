#!/usr/bin/env node
/**
 * Test entry point: discovers every *.test.js in this directory, runs them and
 * exits non-zero if anything failed.
 *
 * Usage:
 *   npm test
 *   node tests/run.js matcher sentiment     (only suites whose file matches)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runSuites } from './harness.js';
import { setLogLevel } from '../src/log.js';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));

// Application logs would drown the results. Set LOG_LEVEL to see them.
if (!process.env.LOG_LEVEL) setLogLevel('error');

const filters = process.argv.slice(2);

const files = fs.readdirSync(TESTS_DIR)
  .filter((name) => name.endsWith('.test.js'))
  .filter((name) => filters.length === 0 || filters.some((filter) => name.includes(filter)))
  .sort();

if (files.length === 0) {
  process.stderr.write(`No test files matched ${filters.join(', ') || '*.test.js'}\n`);
  process.exit(1);
}

process.stdout.write(`Running ${files.length} test file(s)\n`);

// Importing a test file registers its suites via describe().
for (const file of files) {
  await import(pathToFileURL(path.join(TESTS_DIR, file)).href);
}

const { passed, failed, failures } = await runSuites();

process.stdout.write(`\n${'-'.repeat(58)}\n`);

if (failed === 0) {
  process.stdout.write(`[32m${passed} passed[0m, 0 failed\n`);
  process.exit(0);
}

process.stdout.write(`[32m${passed} passed[0m, [31m${failed} failed[0m\n\n`);
for (const failure of failures) {
  process.stdout.write(`  - ${failure.suite} :: ${failure.test}\n`);
}
process.exit(1);
