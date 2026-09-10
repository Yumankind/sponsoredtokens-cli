/**
 * `sponsor`'s decisions, and the two constants it copies from elsewhere in this repository.
 *
 * The copies are the important part. This package publishes to npm on its own and cannot import
 * from the site or the worker, so `TERMS_VERSION` and `PLATFORM_IDS` are written twice — and a
 * silent drift in either is a real failure with money attached: a stale terms version records the
 * wrong agreement against a payment, and a stale platform list refuses a handle the worker accepts.
 * Both tests read the ORIGINAL file as text (the site's module calls `import.meta.glob`, which only
 * exists inside Vite, so it cannot be imported here) and compare.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  DEFAULT_PLATFORM,
  MIN_GLOBAL_CENTS,
  MIN_LOCAL_CENTS,
  MAX_SPONSOR_CENTS,
  PLATFORM_IDS,
  TERMS_VERSION,
  checkoutBody,
  isRefusal,
  parseTarget,
  rankFor,
  rankLabel,
  refusalFrom,
  resolveAmountCents,
  sponsorJson,
  wholeDollars,
  checkoutResult,
  type SponsorBoard,
} from '../src/sponsor.ts';
import { parseSponsorBoard } from '../src/api.ts';

/** The repository root: `packages/sponsoredtokens-cli/tests` → three levels up. */
const REPO = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

// ── The two mirrors ───────────────────────────────────────────────────────────────────────────

test('TERMS_VERSION matches the site’s, which matches terms.md', () => {
  // `registry.ts` since 2026-09-09: the constant moved out of `index.ts` with the build-time
  // pre-render, which imports the registry and nothing else. This file is the only guard on the
  // mirror, so it names the file the constant actually lives in.
  const site = readFileSync(join(REPO, 'sponsoredtokens-site', 'src', 'content', 'registry.ts'), 'utf8');
  const declared = /TERMS_VERSION\s*=\s*'([^']+)'/.exec(site);
  assert.ok(declared, "sponsoredtokens-site/src/content/registry.ts should export a TERMS_VERSION string literal");
  assert.equal(TERMS_VERSION, declared[1], 'the CLI would record the wrong terms version against a real payment');

  // And the site's own constant is only as good as the document it names.
  const terms = readFileSync(join(REPO, 'sponsoredtokens-site', 'src', 'content', 'terms.md'), 'utf8');
  assert.equal(TERMS_VERSION, /^Version:\s*(.+)$/m.exec(terms)![1]!.trim());
});

test('PLATFORM_IDS matches the worker’s OFFERED platforms, in the same order', () => {
  // The worker keeps three more in its full table for sponsors already carrying them (Instagram,
  // Threads, LinkedIn — unreadable from a server, so no longer sold); the CLI offers what is sold.
  const source = readFileSync(join(REPO, 'worker', 'src', 'sponsored', 'platforms.ts'), 'utf8');
  const block = /export const OFFERED_PLATFORM_IDS = \[([^\]]+)\]/.exec(source);
  assert.ok(block, 'worker/src/sponsored/platforms.ts should export an OFFERED_PLATFORM_IDS array');
  const ids = [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...PLATFORM_IDS], ids);
});

test('the default platform is the one a bare @handle has always meant', () => {
  const source = readFileSync(join(REPO, 'worker', 'src', 'sponsored', 'platforms.ts'), 'utf8');
  assert.equal(DEFAULT_PLATFORM, /DEFAULT_PLATFORM: PlatformId = '([^']+)'/.exec(source)![1]);
});

// ── Targets ───────────────────────────────────────────────────────────────────────────────────

test('a bare domain gets https, and a URL is left as typed', () => {
  assert.deepEqual(parseTarget('acme.com', null), { value: 'https://acme.com', platform: null });
  assert.deepEqual(parseTarget('http://acme.com/team', null), { value: 'http://acme.com/team', platform: null });
  assert.deepEqual(parseTarget('  acme.com  ', null), { value: 'https://acme.com', platform: null });
});

test('a handle carries a platform, X unless one was named', () => {
  assert.deepEqual(parseTarget('@acme', null), { value: '@acme', platform: 'x' });
  assert.deepEqual(parseTarget('@acme', 'github'), { value: '@acme', platform: 'github' });
});

test('a platform the worker has never heard of is refused here, before the request', () => {
  const refusal = parseTarget('@acme', 'mastodon');
  assert.ok(isRefusal(refusal));
  assert.equal(refusal.code, 'unknown_platform');
  assert.match(refusal.message, /bluesky/);
});

test('an empty target is a usage error, not a request', () => {
  const refusal = parseTarget('', null);
  assert.ok(isRefusal(refusal) && refusal.code === 'missing_target');
  assert.ok(isRefusal(parseTarget(undefined, null)));
});

test('a platform is ignored for a URL, which says where it lives', () => {
  assert.deepEqual(parseTarget('acme.com', 'github'), { value: 'https://acme.com', platform: null });
});

// ── The amount ────────────────────────────────────────────────────────────────────────────────

const BOARD: SponsorBoard = {
  balances: [48_200, 31_500, 22_750],
  total: 13,
  suggestedCents: 48_700,
  minimumCents: MIN_GLOBAL_CENTS,
};

test('the default is the pool’s suggestion, rounded UP to a whole dollar', () => {
  assert.equal(resolveAmountCents({ dollars: null, board: { ...BOARD, suggestedCents: 48_712 }, audience: 'global' }), 48_800);
  assert.equal(wholeDollars(48_700), 48_700);
});

test('the default still takes #1 after the rounding, which is the point of rounding up', () => {
  const board = { ...BOARD, suggestedCents: 48_712 };
  const cents = resolveAmountCents({ dollars: null, board, audience: 'global' }) as number;
  assert.equal(rankFor(board, cents).position, 1);
});

test('--amount is whole dollars', () => {
  assert.equal(resolveAmountCents({ dollars: 500, board: BOARD, audience: 'global' }), 50_000);
  const refusal = resolveAmountCents({ dollars: 12.5, board: BOARD, audience: 'global' });
  assert.ok(isRefusal(refusal) && refusal.code === 'invalid_amount');
});

test('below the minimum and above the ceiling are named refusals, before any request', () => {
  const low = resolveAmountCents({ dollars: 1, board: BOARD, audience: 'global' });
  assert.ok(isRefusal(low) && low.code === 'amount_below_minimum');
  assert.match(low.message, /\$2\b/);

  const high = resolveAmountCents({ dollars: 100_001, board: BOARD, audience: 'global' });
  assert.ok(isRefusal(high) && high.code === 'amount_above_maximum');
  assert.equal(resolveAmountCents({ dollars: 100_000, board: BOARD, audience: 'global' }), MAX_SPONSOR_CENTS);
});

test('an unreachable board still takes --amount, against the audience’s own floor', () => {
  assert.equal(resolveAmountCents({ dollars: 500, board: null, audience: 'global' }), 50_000);
  assert.equal(resolveAmountCents({ dollars: 2, board: null, audience: 'global' }), MIN_GLOBAL_CENTS);
  const low = resolveAmountCents({ dollars: 1, board: null, audience: 'global' });
  assert.ok(isRefusal(low) && low.code === 'amount_below_minimum');
  assert.equal(resolveAmountCents({ dollars: 2, board: null, audience: ['PT'] }), MIN_LOCAL_CENTS);
});

test('an unreachable board with no --amount says so rather than guessing an amount', () => {
  const refusal = resolveAmountCents({ dollars: null, board: null, audience: 'global' });
  assert.ok(isRefusal(refusal) && refusal.code === 'leaderboard_unreachable');
});

// ── The rank ──────────────────────────────────────────────────────────────────────────────────

test('the rank is counted the way the site counts it, ties going to whoever is already there', () => {
  assert.equal(rankFor(BOARD, 48_700).position, 1);
  assert.equal(rankFor(BOARD, 48_200).position, 2, 'matching the leader exactly does not displace them');
  assert.equal(rankFor(BOARD, 30_000).position, 3);
  assert.equal(rankFor(BOARD, 1_000).position, 4);
});

test('the label reads as a sentence, and admits when the top ten cannot answer', () => {
  assert.equal(rankLabel(rankFor(BOARD, 48_700)), '#1 — the top spot');
  assert.equal(rankLabel(rankFor(BOARD, 30_000)), '#3 of 14');
  // The endpoint returns ten sponsors; an amount under all ten could land anywhere below them.
  const wide: SponsorBoard = { balances: Array.from({ length: 10 }, (_, i) => 10_000 - i * 100), total: 40, suggestedCents: 1, minimumCents: 1_000 };
  assert.equal(rankLabel(rankFor(wide, 1_000)), '#11 or lower of 41');
  // With nothing hidden below them, the count is exact even at the bottom.
  assert.equal(rankLabel(rankFor({ ...wide, total: 10 }, 1_000)), '#11 of 11');
});

// ── The request, the refusals and the JSON ────────────────────────────────────────────────────

test('the body is exactly what the endpoint reads, with the terms accepted and the audience named', () => {
  assert.deepEqual(checkoutBody(parseTarget('acme.com', null) as never, 5_000, 'global'), {
    target: 'https://acme.com',
    amountCents: 5_000,
    audience: 'global',
    termsVersion: TERMS_VERSION,
    acceptTerms: true,
  });
  assert.deepEqual(checkoutBody(parseTarget('@acme', 'github') as never, 5_000, ['ES', 'PT']), {
    target: '@acme',
    platform: 'github',
    amountCents: 5_000,
    audience: ['ES', 'PT'],
    termsVersion: TERMS_VERSION,
    acceptTerms: true,
  });
});

test('a worker refusal keeps its code and gains a sentence', () => {
  const below = refusalFrom(400, { error: 'amount_below_minimum', minimumCents: 1_000 });
  assert.equal(below.code, 'amount_below_minimum');
  assert.match(below.message, /minimum/i);

  // The rate limiter is the one that answers with `code` rather than with `error`.
  assert.equal(refusalFrom(429, { error: 'Too many attempts — try again shortly.', code: 'rate_limited' }).code, 'rate_limited');

  // `invalid_target` carries the worker's own explanation, which is better than ours.
  assert.match(refusalFrom(400, { error: 'invalid_target', message: 'That is not a valid GitHub handle.' }).message, /GitHub handle/);

  // A LISTING RULE (Bruno, 2026-09-07) is its own code, so a terminal can tell "you typed it wrong"
  // apart from "we will not carry that", and the worker's sentence is what carries the detail.
  const chat = refusalFrom(400, {
    error: 'target_not_allowed',
    reason: 'chat_link',
    message: 'Chat and invite links cannot be listed. The board is for products and profiles.',
  });
  assert.equal(chat.code, 'target_not_allowed');
  assert.match(chat.message, /cannot be listed/);
  assert.match(chat.message, /products and profiles/);
  // The shortener refusal is the same code with the worker's other sentence, unchanged by the CLI.
  const short = refusalFrom(400, {
    error: 'target_not_allowed',
    reason: 'shortener',
    message: 'That short link did not resolve, so we cannot tell where it goes. Enter the address it points at.',
  });
  assert.equal(short.code, 'target_not_allowed');
  assert.match(short.message, /did not resolve/);

  // Anything unknown is reported as itself rather than as "something went wrong".
  const unknown = refusalFrom(503, { error: 'sponsoredtokens is not configured', variable: 'STRIPE_SECRET_KEY' });
  assert.match(unknown.message, /not configured/);
});

test('a body with no url is a refusal, not a crash', () => {
  assert.ok(isRefusal(checkoutResult({ sponsorId: 'sp_1' }, 5_000)));
  assert.ok(isRefusal(checkoutResult('<html>502</html>', 5_000)));
  const bare = checkoutResult({ url: 'https://checkout.example/x', slug: 'acme.com', sponsorId: 'sp_1', amountCents: 5_000 }, 5_000);
  assert.ok(!isRefusal(bare) && bare.shortUrl === null);
  assert.deepEqual(checkoutResult({ url: 'https://checkout.example/x', shortUrl: 'https://sponsoredtokens.com/p/abc', slug: 'acme.com', sponsorId: 'sp_1', amountCents: 5_000 }, 5_000), {
    checkoutUrl: 'https://checkout.example/x',
    shortUrl: 'https://sponsoredtokens.com/p/abc',
    sponsorId: 'sp_1',
    slug: 'acme.com',
    amountCents: 5_000,
  });
});

test('the JSON an agent reads names the operator as the payer', () => {
  const target = parseTarget('acme.com', null) as never;
  const json = sponsorJson(
    target,
    5_000,
    rankFor(BOARD, 5_000),
    {
      checkoutUrl: 'https://checkout.example/x',
      shortUrl: 'https://sponsoredtokens.com/p/abc',
      sponsorId: 'sp_1',
      slug: 'acme.com',
      amountCents: 5_000,
    },
    'global',
  );
  assert.deepEqual(json, {
    target: 'https://acme.com',
    platform: null,
    anonymous: false,
    audience: 'global',
    amountCents: 5_000,
    rank: 4,
    checkoutUrl: 'https://checkout.example/x',
    shortUrl: 'https://sponsoredtokens.com/p/abc',
    terms: { version: TERMS_VERSION, payer: 'operator' },
  });
});

// ── The leaderboard read ──────────────────────────────────────────────────────────────────────

test('the board is parsed to the four fields, balances sorted, total never below what is shown', () => {
  assert.deepEqual(
    parseSponsorBoard({
      pool: { balanceCents: 162_450 },
      sponsors: [{ balanceCents: 22_750 }, { balanceCents: 48_200 }, { displayName: 'no balance' }],
      total: 13,
      suggestedCents: 48_700,
      minimumCents: 1_000,
    }),
    { balances: [48_200, 22_750], total: 13, suggestedCents: 48_700, minimumCents: 1_000 },
  );
  assert.deepEqual(parseSponsorBoard({ sponsors: [{ balanceCents: 500 }], total: 0, suggestedCents: 1_000, minimumCents: 1_000 })!.total, 1);
});

test('a leaderboard without the two numbers is no leaderboard at all', () => {
  assert.equal(parseSponsorBoard({ sponsors: [], total: 0 }), null);
  assert.equal(parseSponsorBoard('<html>'), null);
  assert.equal(parseSponsorBoard(null), null);
});
