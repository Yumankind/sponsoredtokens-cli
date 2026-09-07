/**
 * The version string, hardcoded.
 *
 * A compiled `bun build --compile` binary has no `package.json` next to it to read, and reaching for
 * one at runtime would work under `npx` and fail in the single binary — the worst kind of difference.
 * `tests/version.test.ts` asserts this constant equals `package.json`'s, so the duplication cannot
 * drift silently.
 */
export const VERSION = '0.3.6';
