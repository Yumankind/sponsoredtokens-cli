/**
 * Target detection and the Windows spawn plan.
 *
 * Both are tested cross-platform with an injected `exists` and an explicit `platform`, because the
 * Windows path is the one that will never be exercised on the machine this CLI is developed on and
 * is also the one that silently throws `EINVAL` if it is wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveExecutable, spawnPlan, cmdQuote } from '../src/exec.ts';
import { configLocation } from '../src/config-file.ts';

const existsIn = (files: string[]) => (path: string) => files.includes(path);

// ── PATH lookup ───────────────────────────────────────────────────────────────────────────────

test('finds a binary on a POSIX PATH, first directory wins', () => {
  const found = resolveExecutable('claude', {
    platform: 'darwin',
    env: { PATH: '/usr/local/bin:/opt/homebrew/bin' },
    exists: existsIn(['/opt/homebrew/bin/claude', '/usr/local/bin/claude']),
  });
  assert.equal(found, '/usr/local/bin/claude');
});

test('returns null rather than a name the caller would spawn blindly', () => {
  assert.equal(resolveExecutable('claude', { platform: 'linux', env: { PATH: '/usr/bin' }, exists: existsIn([]) }), null);
});

test('on Windows it tries PATHEXT, and finds the .cmd shim npm actually installs', () => {
  const found = resolveExecutable('claude', {
    platform: 'win32',
    env: { PATH: 'C:\\Users\\b\\AppData\\Roaming\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    exists: existsIn(['C:\\Users\\b\\AppData\\Roaming\\npm\\claude.CMD']),
  });
  assert.equal(found, 'C:\\Users\\b\\AppData\\Roaming\\npm\\claude.CMD');
});

test('a name with a separator is a path, not a PATH lookup', () => {
  const found = resolveExecutable('./bin/claude', { platform: 'darwin', env: { PATH: '/usr/bin' }, exists: existsIn(['./bin/claude']) });
  assert.equal(found, './bin/claude');
});

// ── Spawning ──────────────────────────────────────────────────────────────────────────────────

test('POSIX spawns the binary directly — no shell, nothing to quote', () => {
  const plan = spawnPlan('darwin', '/usr/local/bin/claude', ['-p', 'fix foo && bar']);
  assert.deepEqual(plan, { file: '/usr/local/bin/claude', args: ['-p', 'fix foo && bar'], windowsVerbatimArguments: false });
});

test('a Windows .exe also spawns directly — only shims need cmd.exe', () => {
  const plan = spawnPlan('win32', 'C:\\tools\\agent.exe', ['--help'], {});
  assert.equal(plan.file, 'C:\\tools\\agent.exe');
  assert.equal(plan.windowsVerbatimArguments, false);
});

test('a Windows .cmd goes through cmd.exe /d /s /c with a verbatim command line', () => {
  const plan = spawnPlan('win32', 'C:\\npm\\claude.CMD', ['-p', 'hello world'], { ComSpec: 'C:\\Windows\\system32\\cmd.exe' });
  assert.equal(plan.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(plan.windowsVerbatimArguments, true);
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(plan.args[3], '""C:\\npm\\claude.CMD" "-p" "hello world""');
});

test('every cmd argument is quoted, so & | > are never left for cmd to interpret', () => {
  assert.equal(cmdQuote('a & b'), '"a & b"');
  assert.equal(cmdQuote('plain'), '"plain"');
  assert.equal(cmdQuote('say "hi"'), '"say \\"hi\\""');
  // A trailing backslash would otherwise escape our own closing quote.
  assert.equal(cmdQuote('C:\\path\\'), '"C:\\path\\\\"');
});

// ── Where the key lives ───────────────────────────────────────────────────────────────────────

test('the config path follows the platform', () => {
  assert.equal(configLocation('darwin', {}, '/Users/b').file, '/Users/b/.sponsoredtokens/config.json');
  assert.equal(configLocation('linux', {}, '/home/b').file, '/home/b/.sponsoredtokens/config.json');
});

test('Windows uses %APPDATA%, and falls back to the home directory when it is not set', () => {
  const withAppData = configLocation('win32', { APPDATA: 'C:\\Users\\b\\AppData\\Roaming' }, 'C:\\Users\\b');
  assert.ok(withAppData.file.includes('AppData'));
  assert.ok(withAppData.file.endsWith('config.json'));
  const without = configLocation('win32', {}, 'C:\\Users\\b');
  assert.ok(without.file.includes('.sponsoredtokens'));
});
