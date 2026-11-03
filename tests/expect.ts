// Minimal expect() bridge from bun:test to node:assert — only the matchers
// used by the ported suites, so the ported test files stay close to upstream.
import assert from "node:assert/strict"

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function subsetMatches(actual: unknown, expected: unknown): boolean {
  if (isPlainObject(expected) && isPlainObject(actual)) {
    return Object.keys(expected).every(
      (key) => key in actual && subsetMatches(actual[key], expected[key]),
    )
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    return (
      expected.length <= actual.length &&
      expected.every((value, i) => subsetMatches(actual[i], value))
    )
  }
  return Object.is(actual, expected)
}

function checkThrownError(error: unknown, expected: unknown): void {
  if (expected === undefined) return
  const message = error instanceof Error ? error.message : String(error)
  if (expected instanceof RegExp) {
    assert.ok(expected.test(message), `expected "${message}" to match ${expected}`)
  } else {
    assert.ok(
      message.includes(String(expected)),
      `expected "${message}" to include "${String(expected)}"`,
    )
  }
}

export function expect(actual: unknown) {
  return {
    toBe: (expected: unknown) => assert.strictEqual(actual, expected),
    toEqual: (expected: unknown) => assert.deepStrictEqual(actual, expected),
    toContain: (expected: unknown) => {
      if (typeof actual === "string") {
        assert.ok(actual.includes(String(expected)), `expected "${actual}" to contain "${expected}"`)
      } else if (Array.isArray(actual)) {
        assert.ok(actual.includes(expected), `expected array to contain ${JSON.stringify(expected)}`)
      } else {
        assert.fail("toContain expects a string or array")
      }
    },
    toMatch: (expected: RegExp) => {
      assert.ok(expected.test(String(actual)), `expected "${String(actual)}" to match ${expected}`)
    },
    toBeNull: () => assert.strictEqual(actual, null),
    toBeUndefined: () => assert.strictEqual(actual, undefined),
    toBeGreaterThan: (expected: number) => assert.ok((actual as number) > expected),
    toBeGreaterThanOrEqual: (expected: number) => assert.ok((actual as number) >= expected),
    toBeLessThanOrEqual: (expected: number) => assert.ok((actual as number) <= expected),
    toMatchObject: (expected: unknown) => {
      assert.ok(subsetMatches(actual, expected), `expected ${JSON.stringify(actual)} to match object ${JSON.stringify(expected)}`)
    },
    get not() {
      return {
        toBeNull: () => assert.notStrictEqual(actual, null),
        toContain: (expected: unknown) => {
          if (typeof actual === "string") {
            assert.ok(!actual.includes(String(expected)), `expected "${actual}" not to contain "${expected}"`)
          } else if (Array.isArray(actual)) {
            assert.ok(!actual.includes(expected), `expected array not to contain ${JSON.stringify(expected)}`)
          } else {
            assert.fail("not.toContain expects a string or array")
          }
        },
      }
    },
    get resolves() {
      return {
        toEqual: async (expected: unknown) => assert.deepStrictEqual(await actual, expected),
        toBe: async (expected: unknown) => assert.strictEqual(await actual, expected),
      }
    },
    toThrow: (expected?: unknown) => {
      const fn = actual as () => unknown
      assert.strictEqual(typeof fn, "function", "toThrow expects a function")
      try {
        fn()
      } catch (error) {
        checkThrownError(error, expected)
        return
      }
      assert.fail("expected function to throw")
    },
    get rejects() {
      return {
        toThrow: async (expected?: unknown) => {
          try {
            await actual
          } catch (error) {
            checkThrownError(error, expected)
            return
          }
          assert.fail("expected promise to reject")
        },
      }
    },
  }
}
