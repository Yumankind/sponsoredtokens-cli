/**
 * The tier-checked default: the fix for a new account's first `sponsoredtokens claude` answering 402.
 *
 * The fixture is a trimmed `GET /api/v1/models` body in the shape
 * `worker/src/sponsored/models-listing.ts` returns — sponsored rows with a `tier` and a
 * `pool_price_usd`, the caller's own-credit rows alongside them, the caller's tier, their referral
 * count and the bands. Everything asserted here is a property of the SELECTION, so none of it needs
 * a network:
 *
 *   · never above the caller's tier — the 402 this file exists to prevent;
 *   · the dearest the tier allows, because a tier IS a price band;
 *   · the harness's own vendor first, because a harness talks to a wire format;
 *   · a failed fetch lands on tier 0, never on a tier-1 id.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseModel, fetchModelPlan, parseModelPlan, SAFE_MODEL, unlockNote } from '../src/models.ts';
import { planIsFresh } from '../src/config-file.ts';
import { endpoints } from '../src/endpoints.ts';

const EP = endpoints({} as NodeJS.ProcessEnv);

const sponsored = (id: string, tier: number, blended: number) => ({
  id: `sponsored/${id}`,
  object: 'model',
  sponsored: true,
  sponsored_source: id,
  tier,
  pricing: { prompt: '0', completion: '0' },
  pool_price_usd: { input_per_million: blended, output_per_million: blended, blended_per_million: blended },
});

/** The caller's own-credit half of the same list: same ids, no `sponsored` flag, must be ignored. */
const own = (id: string, tier: number, blended: number) => ({
  id,
  object: 'model',
  sponsored: false,
  tier,
  price_usd: { blended_per_million: blended },
});

function body(tier: number, referralCount = 0) {
  return {
    object: 'list',
    data: [
      sponsored('anthropic/claude-haiku-4.5', 0, 1.6),
      sponsored('openai/gpt-5.1-mini', 0, 1.1),
      sponsored('anthropic/claude-sonnet-5', 1, 9),
      sponsored('openai/gpt-5.1-codex', 1, 7.5),
      sponsored('google/gemini-3-pro', 2, 14),
      own('anthropic/claude-opus-4.6', 3, 45),
    ].filter((row) => row.tier <= 3),
    tier,
    referralCount,
    weeklyRemainingCents: 1_234,
    tiers: [
      { tier: 0, minReferrals: 0, maxBlendedUsdPerMillion: 2, models: 2, current: tier === 0 },
      { tier: 1, minReferrals: 2, maxBlendedUsdPerMillion: 10, models: 2, current: tier === 1 },
      { tier: 2, minReferrals: 5, maxBlendedUsdPerMillion: null, models: 1, current: tier === 2 },
    ],
  };
}

// ── The selection ─────────────────────────────────────────────────────────────────────────────

test('tier 0 never sees a tier-1 model, whatever the list contains', () => {
  const plan = parseModelPlan(body(0))!;
  assert.equal(plan.anthropic, 'anthropic/claude-haiku-4.5');
  assert.equal(plan.openai, 'openai/gpt-5.1-mini');
  assert.equal(plan.any, 'anthropic/claude-haiku-4.5'); // the dearest of the two tier-0 rows
});

test('the pick is the DEAREST the band allows — the pool’s money is there to be spent', () => {
  const plan = parseModelPlan(body(1))!;
  assert.equal(plan.anthropic, 'anthropic/claude-sonnet-5');
  assert.equal(plan.openai, 'openai/gpt-5.1-codex');
  assert.equal(plan.any, 'anthropic/claude-sonnet-5');
});

test('the small model is the cheapest Anthropic in the band, not the cheapest of anything', () => {
  const plan = parseModelPlan(body(1))!;
  assert.equal(plan.small, 'anthropic/claude-haiku-4.5'); // gpt-5.1-mini is cheaper, and is not it
});

test('Claude Code gets Anthropic, Codex gets OpenAI, everyone else gets the dearest', () => {
  const plan = parseModelPlan(body(1))!;
  assert.equal(chooseModel(plan, 'claude').model, 'anthropic/claude-sonnet-5');
  assert.equal(chooseModel(plan, 't3').model, 'anthropic/claude-sonnet-5');
  assert.equal(chooseModel(plan, 'codex').model, 'openai/gpt-5.1-codex');
  assert.equal(chooseModel(plan, 'opencode').model, 'anthropic/claude-sonnet-5');
  assert.equal(chooseModel(plan, 'run').model, 'anthropic/claude-sonnet-5');
});

test('a vendor the band does not contain falls back to the dearest rather than to nothing', () => {
  const noOpenAI = parseModelPlan({ ...body(0), data: [sponsored('anthropic/claude-haiku-4.5', 0, 1.6)] })!;
  assert.equal(noOpenAI.openai, null);
  assert.equal(chooseModel(noOpenAI, 'codex').model, 'anthropic/claude-haiku-4.5');
});

test('the own-credit half of the list is not a source of pool defaults', () => {
  const plan = parseModelPlan({ ...body(3), data: [sponsored('anthropic/claude-haiku-4.5', 0, 1.6), own('anthropic/claude-opus-4.6', 0, 45)] })!;
  assert.equal(plan.any, 'anthropic/claude-haiku-4.5');
});

test('a row missing its tier or its price is dropped, never defaulted into the band', () => {
  const plan = parseModelPlan({
    ...body(0),
    data: [
      sponsored('anthropic/claude-haiku-4.5', 0, 1.6),
      { id: 'sponsored/mystery/model', sponsored: true, sponsored_source: 'mystery/model', pool_price_usd: { blended_per_million: 99 } },
      { id: 'sponsored/other/model', sponsored: true, sponsored_source: 'other/model', tier: 0 },
    ],
  })!;
  assert.equal(plan.any, 'anthropic/claude-haiku-4.5');
});

// ── What it says out loud ─────────────────────────────────────────────────────────────────────

test('the note names the model, the tier, and what the next referral buys', () => {
  assert.equal(
    chooseModel(parseModelPlan(body(0))!, 'claude').reason,
    'sponsored/anthropic/claude-haiku-4.5 — the best at tier 0; 2 referrals unlock anthropic/claude-sonnet-5',
  );
});

test('referrals already banked count towards the next rung, and one is singular', () => {
  assert.equal(unlockNote(parseModelPlan(body(0, 1))!), '1 referral unlocks anthropic/claude-sonnet-5');
  assert.equal(unlockNote(parseModelPlan(body(1, 2))!), '3 referrals unlock google/gemini-3-pro');
});

test('the top band has nothing to sell you', () => {
  assert.equal(unlockNote(parseModelPlan(body(2))!), null);
  assert.equal(chooseModel(parseModelPlan(body(2))!, 'claude').reason, 'sponsored/anthropic/claude-sonnet-5 — the best at tier 2');
});

// ── When the pool cannot be reached ───────────────────────────────────────────────────────────

test('no plan means the tier-0 id and a line saying why — never a tier-1 guess', () => {
  const choice = chooseModel(null, 'claude');
  assert.equal(choice.model, SAFE_MODEL);
  assert.equal(choice.small, SAFE_MODEL);
  assert.match(choice.reason, /unreachable/);
  assert.ok(!choice.model.includes('sonnet'));
});

test('a body that is not a model list is no plan at all', () => {
  assert.equal(parseModelPlan(null), null);
  assert.equal(parseModelPlan('<html>captive portal</html>'), null);
  assert.equal(parseModelPlan({ object: 'list', data: [] }), null);
});

test('the fetch sends the key as a bearer, and every failure is a null', async () => {
  let seen = '';
  const plan = await fetchModelPlan(EP, 'sk-st-abc.SECRET', {
    fetchImpl: async (input, init) => {
      seen = String(input);
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer sk-st-abc.SECRET');
      return new Response(JSON.stringify(body(1)), { headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(seen, 'https://sponsoredtokens.com/api/v1/models');
  assert.equal(plan?.anthropic, 'anthropic/claude-sonnet-5');

  assert.equal(await fetchModelPlan(EP, 'k', { fetchImpl: async () => new Response('nope', { status: 500 }) }), null);
  assert.equal(
    await fetchModelPlan(EP, 'k', {
      fetchImpl: () => {
        throw new Error('offline');
      },
    }),
    null,
  );
});

// ── The hour ──────────────────────────────────────────────────────────────────────────────────

test('a cached plan is believed for an hour, and a clock that moved backwards is not', () => {
  const now = Date.parse('2026-09-05T12:00:00.000Z');
  assert.equal(planIsFresh('2026-09-05T11:59:00.000Z', now), true);
  assert.equal(planIsFresh('2026-09-05T11:00:01.000Z', now), true);
  assert.equal(planIsFresh('2026-09-05T10:59:59.000Z', now), false);
  assert.equal(planIsFresh('2026-09-05T12:30:00.000Z', now), false, 'a future timestamp is stale, not eternal');
  assert.equal(planIsFresh('not a date', now), false);
});
