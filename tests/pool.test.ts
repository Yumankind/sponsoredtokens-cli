/**
 * The three pool lines, from the two public bodies the worker actually returns.
 *
 * The fixtures below are the shapes in `worker/src/routes/sponsored-checkout.ts` (`/api/leaderboard`
 * and `/api/sponsors/recent`), trimmed to the fields this CLI reads. The assertions are on the
 * PLAIN text, because that is the contract with the user; colour has its own test in `ui.test.ts`.
 *
 * The two that matter most are the empty pool and the unreachable one: a launch must survive both,
 * and the difference between "$0, nobody yet" and "we could not ask" must never be blurred into a
 * line that says something untrue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardLines, cleanName, fetchBoard, parseBoard } from '../src/pool.ts';
import { endpoints } from '../src/endpoints.ts';
import { inkFor } from '../src/ui.ts';

const PLAIN = inkFor(0);
const EP = endpoints({} as NodeJS.ProcessEnv);

const LEADERBOARD = {
  pool: { balanceCents: 162_450, activeCount: 13, lifetimeCents: 326_200 },
  sponsors: [
    { displayName: 'Northwind Labs', slug: 'northwind', balanceCents: 48_200, lifetimeCents: 120_000 },
    { displayName: 'Ferrite', slug: 'ferrite', balanceCents: 31_500, lifetimeCents: 31_500 },
    { displayName: 'Papertrail Books', slug: 'papertrail', balanceCents: 22_750, lifetimeCents: 40_000 },
    { displayName: 'Fourth Place', slug: 'fourth', balanceCents: 1_000, lifetimeCents: 1_000 },
  ],
  sort: 'remaining',
  total: 13,
  suggestedCents: 48_700,
};

const RECENT = {
  sponsors: [
    { displayName: 'Kestrel Analytics', slug: 'kestrel', balanceCents: 27_000, lifetimeCents: 28_000 },
    { displayName: 'Northwind Labs', slug: 'northwind', balanceCents: 48_200, lifetimeCents: 120_000 },
    { displayName: 'Muswell Coffee', slug: 'muswell', balanceCents: 500, lifetimeCents: 9_000 },
  ],
};

const lines = (leaderboard: unknown, recent: unknown): string[] => boardLines(parseBoard(leaderboard, recent), PLAIN);

// ── The happy path ────────────────────────────────────────────────────────────────────────────

test('three lines: the pool, the top by remaining, the recent by what they paid', () => {
  assert.deepEqual(lines(LEADERBOARD, RECENT), [
    '  Pool      $1,624.50 left of $3,262 sponsored · 13 sponsors',
    '  Top       Northwind Labs $482 · Ferrite $315 · Papertrail Books $227.50',
    '  Recent    Kestrel Analytics $280 · Northwind Labs $1,200 · Muswell Coffee $90',
  ]);
});

test('only three names, however many the worker sends', () => {
  const board = parseBoard(LEADERBOARD, RECENT);
  assert.equal(board.top.length, 3);
  assert.ok(!boardLines(board, PLAIN)[1]!.includes('Fourth Place'));
});

test('one sponsor is not "1 sponsors"', () => {
  const [pool] = lines({ pool: { balanceCents: 1_000, activeCount: 1, lifetimeCents: 1_000 }, sponsors: [] }, null);
  assert.equal(pool, '  Pool      $10 left of $10 sponsored · 1 sponsor');
});

// ── Nothing there, versus nothing heard ───────────────────────────────────────────────────────

test('an empty pool says so in one line and prints no top or recent', () => {
  assert.deepEqual(lines({ pool: { balanceCents: 0, activeCount: 0, lifetimeCents: 0 }, sponsors: [] }, { sponsors: [] }), [
    '  Pool      $0 left — nobody has sponsored yet',
  ]);
});

test('a spent pool is not an empty one — the lifetime total is still worth printing', () => {
  const [pool] = lines({ pool: { balanceCents: 0, activeCount: 4, lifetimeCents: 50_000 }, sponsors: [] }, null);
  assert.equal(pool, '  Pool      $0 left of $500 sponsored · 4 sponsors');
});

test('a failed fetch prints NOTHING — no apology line above a login', () => {
  assert.deepEqual(lines(null, null), []);
});

test('half a board still prints its half', () => {
  assert.deepEqual(lines(LEADERBOARD, null).length, 2);
  assert.deepEqual(lines(null, RECENT), ['  Recent    Kestrel Analytics $280 · Northwind Labs $1,200 · Muswell Coffee $90']);
});

test('a body of the wrong shape is read as no board at all, never as a crash', () => {
  assert.deepEqual(lines('<html>captive portal</html>', 42), []);
  assert.deepEqual(lines({ pool: 'nope', sponsors: 'nope' }, { sponsors: [{}, 7, null] }), []);
});

// ── Names come from strangers ─────────────────────────────────────────────────────────────────

test('a sponsor cannot retitle the terminal or overwrite the line above', () => {
  // The ESC and the BEL go; what is left is inert text, which is the point — the sequence can no
  // longer be a sequence, and nothing about the name is silently rewritten beyond that.
  assert.equal(cleanName('\u001b]0;pwned\u0007Acme'), ']0;pwned Acme');
  assert.equal(cleanName('Acme\r\nPool      $0 left'), 'Acme Pool $0 left');
  assert.equal(cleanName(123), '');
  const [, top] = lines({ pool: LEADERBOARD.pool, sponsors: [{ displayName: 'A\u001b[31mB', balanceCents: 100, lifetimeCents: 100 }] }, null);
  assert.ok(!top!.includes('\u001b'));
});

test('a very long name is truncated rather than allowed to wrap the block', () => {
  const long = cleanName('An Extremely Long Sponsor Name That Goes On And On');
  assert.equal(long.length, 28);
  assert.ok(long.endsWith('…'));
});

// ── The network contract ──────────────────────────────────────────────────────────────────────

test('both public reads are unauthenticated, and `recent` asks for exactly what it prints', async () => {
  const seen: string[] = [];
  const board = await fetchBoard(EP, {
    fetchImpl: async (input, init) => {
      seen.push(String(input));
      assert.ok(!(init?.headers as Record<string, string>).authorization, 'the board is public — never send the key');
      const body = String(input).includes('leaderboard') ? LEADERBOARD : RECENT;
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    },
  });
  assert.deepEqual(seen, [
    'https://sponsoredtokens.com/api/leaderboard?sort=remaining',
    'https://sponsoredtokens.com/api/sponsors/recent?limit=3',
  ]);
  assert.equal(board.top.length, 3);
});

test('a throwing fetch, a 500 and a body that is not JSON all mean "no board" and no exception', async () => {
  const dead = await fetchBoard(EP, {
    fetchImpl: () => {
      throw new Error('getaddrinfo ENOTFOUND');
    },
  });
  assert.deepEqual(boardLines(dead, PLAIN), []);

  const broken = await fetchBoard(EP, {
    fetchImpl: async (input) =>
      String(input).includes('leaderboard') ? new Response('<html>502</html>', { status: 502 }) : new Response('not json', { status: 200 }),
  });
  assert.deepEqual(boardLines(broken, PLAIN), []);
});

test('a hung endpoint is abandoned at the timeout instead of holding up the launch', async () => {
  const started = Date.now();
  const board = await fetchBoard(EP, {
    timeoutMs: 30,
    fetchImpl: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  });
  assert.deepEqual(boardLines(board, PLAIN), []);
  assert.ok(Date.now() - started < 2_000, 'the timeout is the CLI’s, not the socket’s');
});
