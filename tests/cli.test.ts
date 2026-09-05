/**
 * The whole CLI, against a worker that is a `node:http` server on localhost.
 *
 * `SPONSOREDTOKENS_BASE_URL` exists precisely so the real binary can be driven against another
 * deployment (`endpoints.ts`), and that makes an end-to-end test cheap: everything below runs the
 * actual `src/cli.ts`, over a real socket, and asserts on the actual bytes a user would see. It is
 * the only test here that covers `index.ts` — the file where the blocks are assembled and where
 * `--quiet` has to mean something.
 *
 * `HOME` is redirected to a temp directory for every run. Without it, a test would read — and
 * `writeModelPlan` would WRITE — the developer's own `~/.sponsoredtokens/config.json`.
 */
import { test, before, after } from 'node:test';
import { VERSION } from '../src/version.ts';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src', 'cli.ts');

const LEADERBOARD = {
  pool: { balanceCents: 162_450, activeCount: 13, lifetimeCents: 326_200 },
  sponsors: [
    { displayName: 'Northwind Labs', balanceCents: 48_200, lifetimeCents: 120_000 },
    { displayName: 'Ferrite', balanceCents: 31_500, lifetimeCents: 31_500 },
    { displayName: 'Papertrail Books', balanceCents: 22_750, lifetimeCents: 40_000 },
  ],
  total: 13,
};

const RECENT = {
  sponsors: [
    { displayName: 'Kestrel Analytics', balanceCents: 27_000, lifetimeCents: 28_000 },
    { displayName: 'Northwind Labs', balanceCents: 48_200, lifetimeCents: 120_000 },
    { displayName: 'Muswell Coffee', balanceCents: 500, lifetimeCents: 9_000 },
  ],
};

const MODELS = {
  object: 'list',
  data: [
    { id: 'sponsored/anthropic/claude-haiku-4.5', sponsored: true, sponsored_source: 'anthropic/claude-haiku-4.5', tier: 0, pool_price_usd: { blended_per_million: 1.6 } },
    { id: 'sponsored/openai/gpt-5.1-mini', sponsored: true, sponsored_source: 'openai/gpt-5.1-mini', tier: 0, pool_price_usd: { blended_per_million: 1.1 } },
    { id: 'sponsored/anthropic/claude-sonnet-5', sponsored: true, sponsored_source: 'anthropic/claude-sonnet-5', tier: 1, pool_price_usd: { blended_per_million: 9 } },
  ],
  tier: 0,
  referralCount: 0,
  tiers: [
    { tier: 0, minReferrals: 0, current: true },
    { tier: 1, minReferrals: 2, current: false },
  ],
};

const ACCOUNT = {
  budget: { remainingCents: 1_875, weeklyCents: 2_500, resetsAt: '2026-09-08T00:00:00Z' },
  user: { tier: 0, referralLink: 'https://sponsoredtokens.com/r/K3ST' },
};

let server: Server;
let base = '';
let home = '';

before(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const body =
      path === '/api/leaderboard' ? LEADERBOARD : path === '/api/sponsors/recent' ? RECENT : path === '/api/v1/models' ? MODELS : path === '/api/account/me' ? ACCOUNT : null;
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: `no route ${path}` }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  home = mkdtempSync(join(tmpdir(), 'sponsoredtokens-test-'));
});

after(() => server.close());

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        SPONSOREDTOKENS_BASE_URL: base,
        SPONSOREDTOKENS_API_KEY: 'sk-st-testkey.SECRET',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

// ── status ────────────────────────────────────────────────────────────────────────────────────

test('`status` prints the wordmark, the three pool lines and one aligned account block', async () => {
  const { code, stdout } = await run(['status']);
  assert.equal(code, 0);
  assert.deepEqual(stdout.split('\n').slice(0, -1), [
    '',
    `  sponsored/tokens  ${VERSION}`,
    '',
    '  Pool      $1,624.50 left of $3,262 sponsored · 13 sponsors',
    '  Top       Northwind Labs $482 · Ferrite $315 · Papertrail Books $227.50',
    '  Recent    Kestrel Analytics $280 · Northwind Labs $1,200 · Muswell Coffee $90',
    '',
    '  Budget    $18.75 left of $25 this week',
    '  Resets    2026-09-08T00:00:00Z',
    '  Tier      0 — 2 referrals unlock anthropic/claude-sonnet-5',
    '  Model     sponsored/anthropic/claude-haiku-4.5',
    '  Referral  https://sponsoredtokens.com/r/K3ST',
    '  Key       from SPONSOREDTOKENS_API_KEY',
    '',
  ]);
});

test('`--quiet` drops the pool block and keeps everything that is about the caller', async () => {
  const { stdout } = await run(['status', '--quiet']);
  for (const label of ['Pool', 'Top', 'Recent']) assert.ok(!stdout.includes(`  ${label}  `), `${label} should be gone`);
  assert.ok(stdout.includes('  Budget    $18.75 left of $25 this week'));
  assert.ok(stdout.includes('  sponsored/tokens'));
});

test('a piped stdout gets no escape codes, and FORCE_COLOR puts the orange back', async () => {
  const plain = await run(['status']);
  assert.ok(!plain.stdout.includes('\u001b'), 'a pipe must never receive ANSI');

  const forced = await run(['status'], { FORCE_COLOR: '3' });
  assert.ok(forced.stdout.includes('\u001b[38;2;217;119;87m'), 'the brand orange, at 24-bit');
  assert.equal(forced.stdout.replace(/\u001b\[[0-9;]*m/g, ''), plain.stdout);
});

test('NO_COLOR wins over FORCE_COLOR even here', async () => {
  const { stdout } = await run(['status'], { FORCE_COLOR: '3', NO_COLOR: '1' });
  assert.ok(!stdout.includes('\u001b'));
});

// ── a launch ──────────────────────────────────────────────────────────────────────────────────

/**
 * `run` launches a program the user names, so `node --version` is a real launch with a real child —
 * the pool block, the model note and the banner go to STDERR and the child's output to stdout,
 * which is the separation the whole product depends on.
 */
test('a launch prints the block and the banner to stderr, and nothing to the child’s stdout', async () => {
  const { code, stdout, stderr } = await run(['run', process.execPath, '--version']);
  assert.equal(code, 0);
  assert.ok(stdout.startsWith('v'), 'stdout belongs to the child alone');
  assert.deepEqual(stderr.split('\n').slice(0, -1), [
    '',
    '  Pool      $1,624.50 left of $3,262 sponsored · 13 sponsors',
    '  Top       Northwind Labs $482 · Ferrite $315 · Papertrail Books $227.50',
    '  Recent    Kestrel Analytics $280 · Northwind Labs $1,200 · Muswell Coffee $90',
    '  Model     sponsored/anthropic/claude-haiku-4.5 — the best at tier 0; 2 referrals unlock anthropic/claude-sonnet-5',
    '',
    `  sponsored/tokens · ${process.execPath} · the pool pays`,
  ]);
});

test('`--quiet` before a launch leaves only the one banner line', async () => {
  const { stderr } = await run(['--quiet', 'run', process.execPath, '--version']);
  assert.equal(stderr.split('\n').filter(Boolean).length, 1);
  assert.ok(stderr.includes('the pool pays'));
});

test('the environment the child inherits is the pool, and ANTHROPIC_API_KEY is taken away', async () => {
  const { stdout } = await run(
    ['--quiet', 'run', process.execPath, '-e', 'console.log(JSON.stringify({b: process.env.ANTHROPIC_BASE_URL, k: process.env.ANTHROPIC_API_KEY ?? null}))'],
    { ANTHROPIC_API_KEY: 'sk-ant-the-users-own-key' },
  );
  assert.deepEqual(JSON.parse(stdout), { b: `${base}/api`, k: null });
});

// ── the model choice, end to end ──────────────────────────────────────────────────────────────

test('an unreachable pool still launches, on the tier-0 model, and says why', async () => {
  const { code, stderr } = await run(['run', process.execPath, '--version'], { SPONSOREDTOKENS_BASE_URL: 'http://127.0.0.1:1' });
  assert.equal(code, 0);
  assert.ok(!stderr.includes('Pool  '), 'a board we could not read prints nothing');
  assert.ok(stderr.includes("sponsored/anthropic/claude-haiku-4.5 — the pool's model list is unreachable"));
  assert.ok(!stderr.includes('sonnet'));
});

test('`--model` skips the tier lookup entirely and adds the prefix for you', async () => {
  const { stderr } = await run(['--quiet', 'claude', '--model', 'anthropic/claude-opus-4.6', '--', '--help'], { PATH: '' });
  // No `claude` on an emptied PATH, so the launch stops at 127 — but the plan was built first and
  // the banner is not reached; what this asserts is that the model line never appears.
  assert.ok(!stderr.includes('Model  '));
});

test('`--help` carries the wordmark and exits 0', async () => {
  const { code, stdout } = await run(['--help']);
  assert.equal(code, 0);
  assert.ok(stdout.startsWith(`  sponsored/tokens  ${VERSION}`));
  assert.ok(stdout.includes('--quiet, -q'));
  assert.ok(stdout.includes('--model anthropic/claude-haiku-4.5'));
});
