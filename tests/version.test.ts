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
import { helpText } from '../src/args.ts';

test('src/version.ts matches package.json', () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  assert.equal(VERSION, pkg.version);
});

/**
 * `stok` is the name people type; `sponsoredtokens` is the long form that was there first and stays
 * (Bruno, 2026-09-08). npm writes one shim per key in `bin`, so both names must point at the SAME
 * file: two entries that drifted apart would install two commands that behave differently, and the
 * one a user typed would be a coin toss.
 *
 * The version is pinned here as well, because a new command name is a minor bump and 0.4.0 is the
 * release that introduced it. The installers and the docs were written against that number.
 */
test('bin installs both names from one file, at 0.4.0', () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version: string;
    bin: Record<string, string>;
  };
  assert.equal(pkg.version, '0.4.0');
  assert.deepEqual(Object.keys(pkg.bin).sort(), ['sponsoredtokens', 'stok']);
  assert.equal(pkg.bin.stok, './dist/cli.js');
  assert.equal(pkg.bin.sponsoredtokens, pkg.bin.stok);
});

/** The help header leads with the short name and says the long one is there too, in one line. */
test('the help text leads with stok and names the long form once', () => {
  const help = helpText(['claude', 'codex']);
  assert.match(help, /\n {2}stok login\b/);
  assert.match(help, /Also installed as sponsoredtokens\./);
  assert.equal(help.split('Also installed as sponsoredtokens.').length - 1, 1);
});
