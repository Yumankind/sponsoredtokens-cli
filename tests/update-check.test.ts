/**
 * The update check, with the network and the clock handed in.
 *
 * Every decision in `src/update-check.ts` is a pure function precisely so this file can hold the
 * whole of it: no timers, no home directory, no request. The one thing worth stating loudly is what
 * is NOT tested here because it cannot go wrong here — the notice's placement, which is `index.ts`
 * awaiting the check after the command has finished writing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_TTL_MS,
  DEFAULT_INSTALL,
  compareVersions,
  checkForUpdate,
  installCommand,
  installKind,
  isNewer,
  latestUrl,
  noticeLine,
  parseLatest,
  shouldCheck,
  stampIsFresh,
  updateNotice,
  updateSpawn,
  versionLine,
  type UpdateStamp,
} from '../src/update-check.ts';

const NOW = Date.parse('2026-09-08T12:00:00.000Z');

const DOCUMENT = {
  version: '0.4.1',
  publishedAt: '2026-09-08T09:00:00.000Z',
  note: 'The short name.',
  install: DEFAULT_INSTALL,
};

/** A fetch that answers one body, and counts how many times it was asked. */
function stubFetch(body: unknown, ok = true): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    return { ok, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** A stamp store in memory, standing in for `<config dir>/update.json`. */
function stampStore(initial: UpdateStamp | null = null) {
  let held = initial;
  return {
    readStamp: () => held,
    writeStamp: (s: UpdateStamp) => {
      held = s;
    },
    get current() {
      return held;
    },
  };
}

// ── The document ──────────────────────────────────────────────────────────────────────────────

test('a document without a usable version is not a document', () => {
  assert.equal(parseLatest(null), null);
  assert.equal(parseLatest('0.4.1'), null);
  assert.equal(parseLatest({}), null);
  assert.equal(parseLatest({ version: 'latest' }), null);
  assert.equal(parseLatest({ version: '' }), null);
});

test('a version and nothing else still yields the three install lines', () => {
  const latest = parseLatest({ version: '0.4.1' });
  assert.equal(latest?.version, '0.4.1');
  assert.deepEqual(latest?.install, DEFAULT_INSTALL);
  assert.equal(latest?.note, '');
});

test('the published install lines win over ours, field by field', () => {
  const latest = parseLatest({ version: '0.5.0', install: { sh: 'curl newer | bash', npm: 42 } });
  assert.equal(latest?.install.sh, 'curl newer | bash');
  assert.equal(latest?.install.npm, DEFAULT_INSTALL.npm, 'a field that is not a string falls back');
  assert.equal(latest?.install.ps1, DEFAULT_INSTALL.ps1);
});

// ── Semver ────────────────────────────────────────────────────────────────────────────────────

test('versions compare as numbers, which is the whole reason this function exists', () => {
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1, 'string order would say the opposite');
  assert.equal(compareVersions('0.4.1', '0.4.0'), 1);
  assert.equal(compareVersions('0.4.0', '0.4.0'), 0);
  assert.equal(compareVersions('1.0.0', '0.999.999'), 1);
  assert.equal(compareVersions('v0.4.1', '0.4.1'), 0, 'a leading v is not a version difference');
});

test('a prerelease is older than the release it precedes', () => {
  assert.equal(compareVersions('0.5.0-rc.1', '0.5.0'), -1);
  assert.equal(compareVersions('0.5.0', '0.5.0-rc.1'), 1);
  assert.equal(isNewer('0.5.0-rc.1', '0.4.0'), true);
});

// ── The check itself ──────────────────────────────────────────────────────────────────────────

test('a newer version is fetched once and becomes one line', () => {
  const { impl, calls } = stubFetch(DOCUMENT);
  const store = stampStore();
  return checkForUpdate('https://x/cli/latest.json', { now: NOW, fetchImpl: impl, ...store }).then((result) => {
    assert.equal(calls.length, 1);
    assert.equal(result.fetched?.version, '0.4.1');
    assert.equal(result.known, '0.4.1');
    assert.equal(
      updateNotice(result, '0.4.0', 'sh'),
      'stok 0.4.1 is out, you have 0.4.0. Update: curl -fsSL https://sponsoredtokens.com/cli/install.sh | bash',
    );
    assert.equal(store.current?.latest, '0.4.1', 'and the version is remembered for --version');
  });
});

test('the same version says nothing, and neither does an older one', async () => {
  const { impl } = stubFetch(DOCUMENT);
  const same = await checkForUpdate('https://x', { now: NOW, fetchImpl: impl, ...stampStore() });
  assert.equal(updateNotice(same, '0.4.1', 'sh'), null);
  assert.equal(updateNotice(same, '0.5.0', 'sh'), null);
});

test('a failing fetch is silent, and still costs a day', async () => {
  const store = stampStore();
  const impl = (async () => {
    throw new Error('ENOTFOUND');
  }) as unknown as typeof fetch;
  const result = await checkForUpdate('https://x', { now: NOW, fetchImpl: impl, ...store });
  assert.equal(result.fetched, null);
  assert.equal(updateNotice(result, '0.4.0', 'sh'), null);
  assert.equal(store.current?.checkedAt, new Date(NOW).toISOString(), 'a dead network is not retried every command');
});

test('a non-200, and a body that is not the document, are both silence', async () => {
  const notOk = await checkForUpdate('https://x', { now: NOW, fetchImpl: stubFetch(DOCUMENT, false).impl, ...stampStore() });
  assert.equal(updateNotice(notOk, '0.4.0', 'sh'), null);
  const rubbish = await checkForUpdate('https://x', { now: NOW, fetchImpl: stubFetch({ hello: 'world' }).impl, ...stampStore() });
  assert.equal(updateNotice(rubbish, '0.4.0', 'sh'), null);
});

test('the daily stamp holds: a second run inside 24 hours does not ask', async () => {
  const { impl, calls } = stubFetch(DOCUMENT);
  const store = stampStore({ checkedAt: new Date(NOW - 60_000).toISOString(), latest: '0.4.1' });
  const result = await checkForUpdate('https://x', { now: NOW, fetchImpl: impl, ...store });
  assert.equal(calls.length, 0);
  assert.equal(result.fetched, null, 'and so prints nothing: the notice is once a day, not once a command');
  assert.equal(result.known, '0.4.1', 'but --version still knows');
});

test('a day later it asks again', async () => {
  const { impl, calls } = stubFetch(DOCUMENT);
  const store = stampStore({ checkedAt: new Date(NOW - CHECK_TTL_MS - 1).toISOString(), latest: '0.4.0' });
  await checkForUpdate('https://x', { now: NOW, fetchImpl: impl, ...store });
  assert.equal(calls.length, 1);
});

test('a stamp from the future is stale, not valid forever', () => {
  assert.equal(stampIsFresh(new Date(NOW + 60_000).toISOString(), NOW), false);
  assert.equal(stampIsFresh('not a date', NOW), false);
  assert.equal(stampIsFresh(new Date(NOW - 1000).toISOString(), NOW), true);
});

test('the check sends no key, and asks the site it was given', async () => {
  let headers: Record<string, string> = {};
  const impl = (async (url: string, init: RequestInit) => {
    headers = init.headers as Record<string, string>;
    return { ok: true, json: async () => DOCUMENT } as unknown as Response;
  }) as unknown as typeof fetch;
  await checkForUpdate(latestUrl({ site: 'https://sponsoredtokens.com' }), { now: NOW, fetchImpl: impl, ...stampStore() });
  assert.deepEqual(Object.keys(headers).sort(), ['accept', 'user-agent']);
  assert.equal(latestUrl({ site: 'https://sponsoredtokens.com' }), 'https://sponsoredtokens.com/cli/latest.json');
});

// ── Which install this is ─────────────────────────────────────────────────────────────────────

test('the installer directory means the installer one-liner, per platform', () => {
  const home = '/Users/b';
  assert.equal(installKind({ execPath: '/Users/b/.sponsoredtokens/bin/sponsoredtokens', scriptPath: null }, 'darwin', home), 'sh');
  assert.equal(installKind({ execPath: '/Users/b/.sponsoredtokens/bin/stok', scriptPath: null }, 'linux', home), 'sh');
  assert.equal(
    installKind({ execPath: 'C:\\Users\\b\\.sponsoredtokens\\bin\\stok.exe', scriptPath: null }, 'win32', 'C:\\Users\\b'),
    'ps1',
  );
});

test('a node_modules path means npm, whichever of the two paths carries it', () => {
  const home = '/Users/b';
  assert.equal(installKind({ execPath: '/usr/local/bin/node', scriptPath: '/usr/lib/node_modules/sponsoredtokens/dist/cli.js' }, 'linux', home), 'npm');
  assert.equal(installKind({ execPath: '/Users/b/.npm/_npx/abc/node_modules/.bin/stok', scriptPath: null }, 'darwin', home), 'npm');
});

test('the installer directory is checked first, so a home inside a checkout is still a binary install', () => {
  // A container whose home is `/work/node_modules/...` would otherwise be told to `npm i -g`.
  const home = '/work/node_modules/app/home';
  assert.equal(installKind({ execPath: `${home}/.sponsoredtokens/bin/stok`, scriptPath: null }, 'linux', home), 'sh');
});

test('anything else falls back to the platform installer, never to npm', () => {
  assert.equal(installKind({ execPath: '/opt/tools/stok', scriptPath: null }, 'linux', '/Users/b'), 'sh');
  assert.equal(installKind({ execPath: 'D:\\tools\\stok.exe', scriptPath: null }, 'win32', 'C:\\Users\\b'), 'ps1');
});

test('the notice names the command for that install', () => {
  const latest = parseLatest(DOCUMENT)!;
  assert.equal(installCommand('npm', latest), 'npm i -g sponsoredtokens');
  assert.equal(installCommand('ps1', latest), 'irm https://sponsoredtokens.com/cli/install.ps1 | iex');
  assert.equal(installCommand('sh', null), DEFAULT_INSTALL.sh, 'and works with no document at all');
  assert.equal(noticeLine('0.4.1', '0.4.0', 'npm i -g sponsoredtokens'), 'stok 0.4.1 is out, you have 0.4.0. Update: npm i -g sponsoredtokens');
});

// ── The gates ─────────────────────────────────────────────────────────────────────────────────

const isHarness = (id: string) => id === 'claude' || id === 'codex';

test('only the commands that already talk to the pool check', () => {
  const gate = { quiet: false, stderrIsTty: true };
  for (const command of ['login', 'status', 'run', 'claude', 'codex']) {
    assert.equal(shouldCheck({ ...gate, command }, isHarness), true, command);
  }
  for (const command of ['logout', 'reset', 'sponsor', 'update', 'nonsense']) {
    assert.equal(shouldCheck({ ...gate, command }, isHarness), false, command);
  }
  assert.equal(shouldCheck({ ...gate, command: null }, isHarness), false);
});

test('piped output and --quiet cost no request at all', () => {
  assert.equal(shouldCheck({ command: 'status', quiet: false, stderrIsTty: false }, isHarness), false);
  assert.equal(shouldCheck({ command: 'status', quiet: true, stderrIsTty: true }, isHarness), false);
});

// ── --version ─────────────────────────────────────────────────────────────────────────────────

test('--version says latest only when it knows of a newer one, and keeps the version first', () => {
  assert.equal(versionLine('0.4.0', null), '0.4.0');
  assert.equal(versionLine('0.4.0', '0.4.0'), '0.4.0');
  assert.equal(versionLine('0.4.0', '0.3.9'), '0.4.0', 'a stale stamp does not make it look behind');
  assert.equal(versionLine('0.4.0', '0.4.1'), '0.4.0 latest 0.4.1');
  assert.equal(versionLine('0.4.0', '0.4.1').split(' ')[0], '0.4.0');
});

// ── `stok update` ─────────────────────────────────────────────────────────────────────────────

test('each one-liner is run by the one thing that can run it', () => {
  const sh = updateSpawn('sh', 'curl x | bash', 'darwin', {});
  assert.deepEqual(sh, { file: '/bin/sh', args: ['-c', 'curl x | bash'] });
  assert.deepEqual(updateSpawn('npm', 'npm i -g sponsoredtokens', 'linux', {}), { file: '/bin/sh', args: ['-c', 'npm i -g sponsoredtokens'] });
  assert.deepEqual(updateSpawn('ps1', 'irm x | iex', 'win32', {}), { file: 'powershell.exe', args: ['-NoProfile', '-Command', 'irm x | iex'] });
  assert.deepEqual(updateSpawn('npm', 'npm i -g sponsoredtokens', 'win32', { ComSpec: 'C:\\cmd.exe' }), {
    file: 'C:\\cmd.exe',
    args: ['/d', '/s', '/c', 'npm i -g sponsoredtokens'],
  });
});

test('a line this platform cannot run is printed instead of guessed at', () => {
  assert.equal(updateSpawn('ps1', 'irm x | iex', 'darwin', {}), null);
  assert.equal(updateSpawn('sh', 'curl x | bash', 'win32', {}), null);
});
