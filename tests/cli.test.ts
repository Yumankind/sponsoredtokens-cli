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
import { TERMS_VERSION } from '../src/sponsor.ts';
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
  suggestedCents: 48_700,
  minimumCents: 1_000,
};

/** `?board=local&country=PT`: the sponsors whose audience includes Portugal, and nobody else. */
const LOCAL_LEADERBOARD = {
  board: 'local',
  country: 'PT',
  pool: { balanceCents: 5_500, activeCount: 2 },
  sponsors: [
    { displayName: 'Pastelaria Central', balanceCents: 4_000, lifetimeCents: 4_000 },
    { displayName: 'Bica & Co', balanceCents: 1_500, lifetimeCents: 3_000 },
  ],
  total: 2,
  suggestedCents: 4_500,
  minimumCents: 1_000,
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

/** A Stripe Checkout URL, at the length and shape of a real one — 353 characters. */
const CHECKOUT_URL =
  'https://checkout.stripe.com/c/pay/cs_test_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0#fidkdWxOYHwnPyd1blpxYHZxWjA0S0BOfE5%2FUEBLcW5rT2NgTU5ScUFRSjZUR1RmYUlLbGB0YkZOfWJEV0xrVGJcYFVXVGBRZlxDU2JIY2BjcVdWTndqQ0BEUEBSbWtASHJTSHZWQ2JAZ0xEVzFvbnVsPCcpJ3VpbGtuQH11anZgYUxhJz8ncWB2cVo0MEsnKSdpZHxqcHFRfHVgJz8ndmxrYmlgWmxxYGgnKSdga2RnaWBVaWRmYG1qaWFgd3YnP3F3cGB4JSUn';

/** What the last `POST /api/sponsor/checkout` carried: the body, and whether a key rode with it. */
let lastCheckout: { body: Record<string, unknown>; authorization: string | null } | null = null;

/** The query of the last `GET /api/leaderboard` — which BOARD the amount and the rank came from. */
let lastLeaderboardQuery: string | null = null;

/** Set to make the next checkout refuse, the way the worker refuses. */
let checkoutRefusal: { status: number; body: unknown } | null = null;

let server: Server;
let base = '';
let home = '';

before(async () => {
  server = createServer((req, res) => {
    const [path, query = ''] = (req.url ?? '').split('?');

    if (path === '/api/sponsor/checkout' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        lastCheckout = { body: JSON.parse(raw) as Record<string, unknown>, authorization: req.headers.authorization ?? null };
        const refusal = checkoutRefusal;
        checkoutRefusal = null;
        res.writeHead(refusal ? refusal.status : 200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            refusal
              ? refusal.body
              : { url: CHECKOUT_URL, sponsorId: 'sp_7c1f', slug: 'acme.com', amountCents: lastCheckout!.body.amountCents },
          ),
        );
      });
      return;
    }

    if (path === '/api/leaderboard') lastLeaderboardQuery = query;
    const leaderboard = new URLSearchParams(query).get('board') === 'local' ? LOCAL_LEADERBOARD : LEADERBOARD;
    const body =
      path === '/api/leaderboard' ? leaderboard : path === '/api/sponsors/recent' ? RECENT : path === '/api/v1/models' ? MODELS : path === '/api/account/me' ? ACCOUNT : null;
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

// ── sponsor ───────────────────────────────────────────────────────────────────────────────────

/**
 * These run with no key at all — `SPONSOREDTOKENS_API_KEY` is emptied — because the endpoint is
 * public and an agent that has never logged in must still be able to put money in.
 */
const anonymous = { SPONSOREDTOKENS_API_KEY: '' };

test('`sponsor --json` prints ONE object on stdout and nothing else, with the operator as payer', async () => {
  const { code, stdout, stderr } = await run(['sponsor', 'acme.com', '--amount', '100', '--json', '--no-open'], anonymous);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), {
    target: 'https://acme.com',
    platform: null,
    audience: 'global',
    amountCents: 10_000,
    rank: 4,
    checkoutUrl: CHECKOUT_URL,
    shortUrl: null,
    terms: { version: TERMS_VERSION, payer: 'operator' },
  });
  assert.equal(stdout.trim().split('\n').length, 1, 'stdout is one line of JSON');
  assert.equal(stderr, '', 'nothing was worth saying on stderr either');
});

test('the request carries the terms, the acceptance and the platform, and no key when there is none', async () => {
  await run(['sponsor', '@acme', '--platform', 'github', '--amount', '250', '--json', '--no-open'], anonymous);
  assert.deepEqual(lastCheckout?.body, {
    target: '@acme',
    platform: 'github',
    amountCents: 25_000,
    audience: 'global',
    termsVersion: TERMS_VERSION,
    acceptTerms: true,
  });
  assert.equal(lastCheckout?.authorization, null);
});

test('a key, when there is one, rides along so the sponsorship can be attributed later', async () => {
  await run(['sponsor', 'acme.com', '--amount', '100', '--json', '--no-open']);
  assert.equal(lastCheckout?.authorization, 'Bearer sk-st-testkey.SECRET');
});

test('with no --amount the default is the amount that takes #1', async () => {
  const { stdout } = await run(['sponsor', 'acme.com', '--json', '--no-open'], anonymous);
  const json = JSON.parse(stdout) as { amountCents: number; rank: number };
  assert.equal(json.amountCents, 48_700, 'the top balance plus $5, rounded to a whole dollar');
  assert.equal(json.rank, 1);
});

test('the human output names the target, the amount, the rank, the link and who pays', async () => {
  const { code, stdout } = await run(['sponsor', 'acme.com', '--amount', '500', '--no-open']);
  assert.equal(code, 0);
  assert.ok(stdout.includes(`  sponsored/tokens  ${VERSION}`));
  assert.ok(stdout.includes('  Sponsor   https://acme.com'));
  assert.ok(stdout.includes('  Amount    $500'));
  assert.ok(stdout.includes('  Rank      #1 — the top spot'));
  assert.ok(stdout.includes(`  Pay       ${CHECKOUT_URL}`));
  assert.ok(stdout.includes('Give this link to the person who pays'));
  assert.ok(stdout.includes(`version ${TERMS_VERSION}`));
  assert.ok(stdout.includes('/terms'));
});

test('`--quiet` leaves the four facts and drops the wordmark and the explanation', async () => {
  const { stdout } = await run(['sponsor', 'acme.com', '--amount', '500', '--quiet', '--no-open']);
  assert.deepEqual(stdout.split('\n').slice(0, -1), [
    '  Sponsor   https://acme.com',
    '  Amount    $500',
    '  Rank      #1 — the top spot',
    `  Pay       ${CHECKOUT_URL}`,
  ]);
});

test('an amount under the pool’s minimum never reaches the pool', async () => {
  lastCheckout = null;
  const { code, stdout } = await run(['sponsor', 'acme.com', '--amount', '5', '--json', '--no-open'], anonymous);
  assert.equal(code, 1);
  assert.equal((JSON.parse(stdout) as { code: string }).code, 'amount_below_minimum');
  assert.equal(lastCheckout, null, 'no Checkout session was minted for a typo');
});

// ── sponsor --audience ────────────────────────────────────────────────────────────────────────

test('a local audience reads the LOCAL board and carries the sorted countries into the request', async () => {
  lastLeaderboardQuery = null;
  const { code, stdout } = await run(['sponsor', 'acme.com', '--audience', 'pt,es', '--amount', '20', '--json', '--no-open'], anonymous);
  assert.equal(code, 0);
  assert.equal(lastLeaderboardQuery, 'board=local&country=PT&sort=remaining', 'the board of the FIRST country named');
  assert.deepEqual(JSON.parse(stdout), {
    target: 'https://acme.com',
    platform: null,
    audience: ['ES', 'PT'],
    amountCents: 2_000,
    rank: 2,
    checkoutUrl: CHECKOUT_URL,
    shortUrl: null,
    terms: { version: TERMS_VERSION, payer: 'operator' },
  });
  assert.deepEqual(lastCheckout?.body.audience, ['ES', 'PT']);
});

test('a group name is expanded to countries before the request', async () => {
  const { code, stdout } = await run(['sponsor', 'acme.com', '--audience=iberia', '--amount', '20', '--json', '--no-open'], anonymous);
  assert.equal(code, 0);
  assert.deepEqual((JSON.parse(stdout) as { audience: string[] }).audience, ['ES', 'PT']);
  assert.deepEqual(lastCheckout?.body.audience, ['ES', 'PT']);
});

test('with no --amount a local sponsorship takes #1 on the LOCAL board, for local money', async () => {
  const { stdout } = await run(['sponsor', 'acme.com', '--audience', 'PT', '--json', '--no-open'], anonymous);
  const json = JSON.parse(stdout) as { amountCents: number; rank: number };
  assert.equal(json.amountCents, 4_500, 'the local board’s suggestion, not the global board’s $487');
  assert.equal(json.rank, 1);
});

test('the rank line says which board a local sponsorship is #1 on', async () => {
  const { stdout } = await run(['sponsor', 'acme.com', '--audience', 'PT,ES', '--amount', '50', '--quiet', '--no-open'], anonymous);
  assert.deepEqual(stdout.split('\n').slice(0, -1), [
    '  Sponsor   https://acme.com',
    '  Amount    $50',
    '  Rank      #1 — the top spot on the local board of PT',
    `  Pay       ${CHECKOUT_URL}`,
  ]);
});

test('a global sponsorship still carries `global`, and its rank line names no board', async () => {
  const { stdout } = await run(['sponsor', 'acme.com', '--amount', '500', '--quiet', '--no-open'], anonymous);
  assert.ok(stdout.includes('  Rank      #1 — the top spot\n'));
  assert.equal(lastCheckout?.body.audience, 'global');
});

test('$10 is the entry price on either board — the world, or one country', async () => {
  const global = await run(['sponsor', 'acme.com', '--amount', '10', '--json', '--no-open'], anonymous);
  assert.equal(global.code, 0, '$10 buys a global sponsorship');
  assert.equal((JSON.parse(global.stdout) as { amountCents: number }).amountCents, 1_000);
  assert.equal(lastCheckout?.body.audience, 'global');

  const local = await run(['sponsor', 'acme.com', '--audience', 'PT', '--amount', '10', '--json', '--no-open'], anonymous);
  assert.equal(local.code, 0, 'and the same $10 buys a place on Portugal’s board');
  assert.equal((JSON.parse(local.stdout) as { amountCents: number }).amountCents, 1_000);
});

test('$5 is below both minimums, and the refusal says which board it was measured against', async () => {
  lastCheckout = null;
  const global = await run(['sponsor', 'acme.com', '--amount', '5', '--json', '--no-open'], anonymous);
  assert.equal(global.code, 1);
  const refusal = JSON.parse(global.stdout) as { code: string; error: string };
  assert.equal(refusal.code, 'amount_below_minimum');
  assert.match(refusal.error, /global/);
  assert.match(refusal.error, /\$10\b/);
  assert.equal(lastCheckout, null, 'nothing was minted');

  // Two countries are two boards, so $10 no longer covers it — and the refusal counts them back.
  const pair = await run(['sponsor', 'acme.com', '--audience', 'PT,ES', '--amount', '10', '--json', '--no-open'], anonymous);
  assert.equal(pair.code, 1);
  assert.match((JSON.parse(pair.stdout) as { error: string }).error, /2 countries need at least \$20\b/);
  assert.equal(lastCheckout, null);
});

test('an audience that is not countries is refused before any request', async () => {
  for (const bad of ['portugal', 'global,PT', 'PT,,ES', 'XX']) {
    lastCheckout = null;
    const { code, stdout } = await run(['sponsor', 'acme.com', '--audience', bad, '--amount', '50', '--json', '--no-open'], anonymous);
    assert.equal(code, 1, `${bad} should be refused`);
    assert.equal((JSON.parse(stdout) as { code: string }).code, 'invalid_audience');
    assert.equal(lastCheckout, null);
  }
});

test('an amount over $100,000 never reaches the pool either', async () => {
  lastCheckout = null;
  const { code, stdout } = await run(['sponsor', 'acme.com', '--amount', '100001', '--json', '--no-open'], anonymous);
  assert.equal(code, 1);
  assert.equal((JSON.parse(stdout) as { code: string }).code, 'amount_above_maximum');
  assert.equal(lastCheckout, null);
});

test('a refusal from the pool arrives as { error, code } on stdout, exit 1', async () => {
  checkoutRefusal = { status: 400, body: { error: 'invalid_target', message: 'That is not a valid GitHub handle.' } };
  const { code, stdout } = await run(['sponsor', '@a/b', '--platform', 'github', '--amount', '100', '--json', '--no-open'], anonymous);
  assert.equal(code, 1);
  const body = JSON.parse(stdout) as { error: string; code: string };
  assert.equal(body.code, 'invalid_target');
  assert.match(body.error, /GitHub handle/);
});

test('a platform the worker has never heard of is refused before the request', async () => {
  lastCheckout = null;
  const { code, stdout } = await run(['sponsor', '@acme', '--platform', 'mastodon', '--json', '--no-open'], anonymous);
  assert.equal(code, 1);
  assert.equal((JSON.parse(stdout) as { code: string }).code, 'unknown_platform');
  assert.equal(lastCheckout, null);
});

test('`sponsor` with no target is a usage error rather than a request', async () => {
  lastCheckout = null;
  const { code, stdout } = await run(['sponsor', '--json', '--no-open'], anonymous);
  assert.equal(code, 1);
  assert.equal((JSON.parse(stdout) as { code: string }).code, 'missing_target');
  assert.equal(lastCheckout, null);
});

test('an unreachable pool with an --amount still mints a link; without one it says why', async () => {
  const named = await run(['sponsor', 'acme.com', '--amount', '100', '--json', '--no-open'], {
    ...anonymous,
    SPONSOREDTOKENS_BASE_URL: base,
  });
  assert.equal(named.code, 0);

  const guessing = await run(['sponsor', 'acme.com', '--json', '--no-open'], {
    ...anonymous,
    SPONSOREDTOKENS_BASE_URL: 'http://127.0.0.1:1',
  });
  assert.equal(guessing.code, 1);
  assert.equal((JSON.parse(guessing.stdout) as { code: string }).code, 'leaderboard_unreachable');
});

test('a QR code of the link is drawn on a colour terminal, and never into a pipe', async () => {
  const piped = await run(['sponsor', 'acme.com', '--amount', '100', '--no-open']);
  assert.ok(!piped.stdout.includes('▀'), 'no picture without colour: contrast could not be guaranteed');

  const coloured = await run(['sponsor', 'acme.com', '--amount', '100', '--no-open'], { FORCE_COLOR: '3', COLUMNS: '120' });
  const rows = coloured.stdout.split('\n').filter((line) => line.includes('▀'));
  assert.ok(rows.length > 10, 'the symbol is drawn, two module rows per line');
});

test('`--json` after another command belongs to that command, not to us', async () => {
  // `sponsor` is the only command that claims `--json` after the command word. Anywhere else it is
  // forwarded, which is what stops us stealing a flag a harness meant for itself.
  const { stdout } = await run([
    '--quiet',
    'run',
    process.execPath,
    '-e',
    'console.log(process.argv.slice(1).join(" "))',
    '--',
    '--json',
  ]);
  assert.equal(stdout.trim(), '--json');
});
