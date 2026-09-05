/**
 * The version is written twice — once in `package.json` for npm, once in `src/version.ts` for the
 * compiled binary, which has no `package.json` to read. This is the test that stops the two from
 * disagreeing, which they otherwise would on the first release.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VERSION } from '../src/version.ts';

test('src/version.ts matches package.json', () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  assert.equal(VERSION, pkg.version);
});
