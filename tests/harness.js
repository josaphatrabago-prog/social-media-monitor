/**
 * Tiny test harness.
 *
 * The project ships with no dependencies, so rather than pull in a runner this
 * provides the three things the tests actually need: grouping, assertions and
 * a non-zero exit code on failure.
 */

const suites = [];
let currentSuite = null;

export function describe(name, body) {
  currentSuite = { name, tests: [] };
  suites.push(currentSuite);
  body();
  currentSuite = null;
}

export function test(name, body) {
  if (!currentSuite) throw new Error(`test("${name}") called outside describe()`);
  currentSuite.tests.push({ name, body });
}

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

function format(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value instanceof Set) return `Set(${format([...value])})`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const assert = {
  ok(value, message = 'expected a truthy value') {
    if (!value) throw new AssertionError(`${message} (got ${format(value)})`);
  },

  notOk(value, message = 'expected a falsy value') {
    if (value) throw new AssertionError(`${message} (got ${format(value)})`);
  },

  equal(actual, expected, message = 'values differ') {
    if (actual !== expected) {
      throw new AssertionError(`${message}\n    expected: ${format(expected)}\n    actual:   ${format(actual)}`);
    }
  },

  deepEqual(actual, expected, message = 'structures differ') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
      throw new AssertionError(`${message}\n    expected: ${b}\n    actual:   ${a}`);
    }
  },

  close(actual, expected, tolerance = 0.001, message = 'numbers differ') {
    if (Math.abs(actual - expected) > tolerance) {
      throw new AssertionError(`${message}\n    expected: ~${expected}\n    actual:   ${actual}`);
    }
  },

  includes(haystack, needle, message = 'value not found') {
    const found = typeof haystack === 'string'
      ? haystack.includes(needle)
      : Array.from(haystack || []).includes(needle);

    if (!found) {
      throw new AssertionError(`${message}\n    looked for: ${format(needle)}\n    in:         ${format(haystack)}`);
    }
  },

  /** Asserts the callback throws, optionally matching the message. */
  throws(body, expectedMessage, message = 'expected a throw') {
    let threw = null;
    try {
      body();
    } catch (error) {
      threw = error;
    }

    if (!threw) throw new AssertionError(message);

    if (expectedMessage && !threw.message.includes(expectedMessage)) {
      throw new AssertionError(
        `${message}: wrong error\n    expected to include: ${format(expectedMessage)}\n    actual: ${format(threw.message)}`
      );
    }

    return threw;
  },

  async rejects(promise, expectedMessage, message = 'expected a rejection') {
    let threw = null;
    try {
      await promise;
    } catch (error) {
      threw = error;
    }

    if (!threw) throw new AssertionError(message);
    if (expectedMessage && !threw.message.includes(expectedMessage)) {
      throw new AssertionError(
        `${message}: wrong error\n    expected to include: ${format(expectedMessage)}\n    actual: ${format(threw.message)}`
      );
    }

    return threw;
  }
};

/** Runs every registered suite. @returns {Promise<{passed, failed}>} */
export async function runSuites() {
  let passed = 0;
  const failures = [];

  for (const suite of suites) {
    process.stdout.write(`\n  ${suite.name}\n`);

    for (const testCase of suite.tests) {
      try {
        await testCase.body();
        passed += 1;
        process.stdout.write(`    [32mPASS[0m  ${testCase.name}\n`);
      } catch (error) {
        failures.push({ suite: suite.name, test: testCase.name, error });
        process.stdout.write(`    [31mFAIL[0m  ${testCase.name}\n`);
        const detail = (error.stack || error.message)
          .split('\n')
          .slice(0, error.name === 'AssertionError' ? 4 : 3)
          .map((line) => `          ${line.trim()}`)
          .join('\n');
        process.stdout.write(`${detail}\n`);
      }
    }
  }

  return { passed, failed: failures.length, failures };
}
