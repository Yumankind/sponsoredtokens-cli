/**
 * Which model a launch actually gets, decided against the CALLER'S TIER rather than a constant.
 *
 * ── THE BUG THIS FILE EXISTS TO FIX ─────────────────────────────────────────────────────────────
 *
 * The built-in default was `sponsored/anthropic/claude-sonnet-5`, which the pool only unlocks at
 * tier 1 (two referrals). A brand-new account's very first `sponsoredtokens claude` therefore met a
 * 402 — the single worst possible first run, and one nobody could debug from the harness's error.
 * So the default is now READ from the pool: `GET <site>/api/v1/models` with the key returns the
 * caller's `tier`, their `referralCount`, the four `tiers` bands, and a `data[]` in which every
 * `sponsored/…` row carries the `tier` that unlocks it and `pool_price_usd.blended_per_million`,
 * the price the sponsors pay for it.
 *
 * ── THE CHOICE ──────────────────────────────────────────────────────────────────────────────────
 *
 * The DEAREST sponsored model at or below the caller's tier: a tier is a price band (PLAN §5), so
 * the dearest one the band allows is by construction the best model the pool will pay for, and
 * spending less than the tier permits helps nobody — the pool's money is there to be spent. Vendor
 * preference is per harness, because a harness talks to a shape of API and not to a price:
 * Anthropic for Claude Code (`/v1/messages`), OpenAI for Codex (`/v1/responses`), the dearest of
 * anything for everyone else. The small/fast model is the mirror image — the CHEAPEST Anthropic
 * model in the band — because Claude Code spends it on file summaries and title generation, and
 * paying Sonnet prices for those is the pool's money burned on nothing.
 *
 * ── FAILING SOFT, AND THE ONE DIRECTION IT FAILS IN ─────────────────────────────────────────────
 *
 * Every call here has a timeout and returns `null` rather than throwing: the board being unreachable
 * must never be the reason a harness does not start. The fallback is `anthropic/claude-haiku-4.5`,
 * which is tier 0 — NEVER a tier-1 id. A guess that is too cheap costs the user a better model for
 * one session; a guess that is too dear costs them a 402 they cannot explain, and that asymmetry is
 * the whole design.
 *
 * The answer is cached in the config file for an hour (`config-file.ts`), so the common case — a
 * person launching a harness ten times an afternoon — pays for this once.
 */
import { USER_AGENT } from './api.ts';
import type { Endpoints } from './endpoints.ts';

/** Tier 0, always available, and the only id this file will invent when it knows nothing. */
export const SAFE_MODEL = 'anthropic/claude-haiku-4.5';

/** How long a fetched plan stays fresh in the config file. */
export const PLAN_TTL_MS = 60 * 60 * 1000;

/** The prefix that means "the pool pays" — mirrors `harnesses.ts`. */
const SPONSORED_PREFIX = 'sponsored/';

/**
 * The distilled answer, small enough to sit in a config file next to a secret.
 *
 * The full listing is a few hundred rows and every one of them would be cached, re-read and
 * re-parsed on every launch for the sake of three ids. So the SELECTION happens once, at fetch
 * time, and what is stored is the outcome: the dearest id per vendor bucket, the cheap one, and the
 * next rung of the ladder so `status` can say what is one referral away.
 */
export interface ModelPlan {
  tier: number;
  referralCount: number;
  /** Bare ids (no `sponsored/`), or null when the band holds no model from that vendor. */
  anthropic: string | null;
  openai: string | null;
  any: string | null;
  /** The cheapest model in the band, Anthropic for preference — Claude Code's background chores. */
  small: string | null;
  /** The next band up, when the caller is not already on the top rung. */
  next: { tier: number; minReferrals: number; model: string | null } | null;
}

export interface CachedModelPlan {
  plan: ModelPlan;
  /** ISO 8601, written by us, believed only as far as `PLAN_TTL_MS`. */
  fetchedAt: string;
}

// ── Parsing ───────────────────────────────────────────────────────────────────────────────────

interface Candidate {
  /** Bare id: `anthropic/claude-sonnet-5`. */
  id: string;
  vendor: string;
  tier: number;
  blended: number;
}

function bare(id: string): string {
  return id.startsWith(SPONSORED_PREFIX) ? id.slice(SPONSORED_PREFIX.length) : id;
}

function vendorOf(id: string): string {
  const slash = id.indexOf('/');
  return (slash === -1 ? id : id.slice(0, slash)).toLowerCase();
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * The `sponsored/` rows of a `/v1/models` body, as candidates.
 *
 * Every field is read defensively and a row that is missing one is DROPPED rather than defaulted:
 * a row whose tier we had to guess is a row that could send a tier-0 account at a tier-2 model, and
 * the whole point of this file is that this cannot happen.
 */
function candidates(data: unknown): Candidate[] {
  if (!Array.isArray(data)) return [];
  const out: Candidate[] = [];
  for (const row of data) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const rawId = typeof record.sponsored_source === 'string' ? record.sponsored_source : typeof record.id === 'string' ? record.id : null;
    if (!rawId) continue;
    // Only the pool's own half of the list: the plain ids in the same body are billed to the
    // caller's own credits and say nothing about what the pool will pay for.
    if (record.sponsored !== true && !(typeof record.id === 'string' && record.id.startsWith(SPONSORED_PREFIX))) continue;
    if (typeof record.tier !== 'number' || !Number.isFinite(record.tier)) continue;
    const price = record.pool_price_usd;
    const blended = typeof price === 'object' && price !== null ? asNumber((price as Record<string, unknown>).blended_per_million, -1) : -1;
    if (blended < 0) continue;
    const id = bare(rawId);
    out.push({ id, vendor: vendorOf(id), tier: record.tier, blended });
  }
  return out;
}

/** Dearest first, then by id so two models at the same price always resolve the same way. */
function dearest(rows: Candidate[]): string | null {
  let best: Candidate | null = null;
  for (const row of rows) {
    if (!best || row.blended > best.blended || (row.blended === best.blended && row.id < best.id)) best = row;
  }
  return best?.id ?? null;
}

function cheapest(rows: Candidate[]): string | null {
  let best: Candidate | null = null;
  for (const row of rows) {
    if (!best || row.blended < best.blended || (row.blended === best.blended && row.id < best.id)) best = row;
  }
  return best?.id ?? null;
}

interface Band {
  tier: number;
  minReferrals: number;
}

function bands(raw: unknown): Band[] {
  if (!Array.isArray(raw)) return [];
  const out: Band[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.tier !== 'number') continue;
    out.push({ tier: record.tier, minReferrals: asNumber(record.minReferrals, 0) });
  }
  return out.sort((a, b) => a.tier - b.tier);
}

/**
 * A `/v1/models` body → the plan, or null when the body is not one.
 *
 * Pure, so the whole selection is a fixture test: the interesting failures here are "we picked a
 * model above the tier" and "we picked the cheapest when we meant the dearest", and neither needs a
 * network to catch.
 */
export function parseModelPlan(body: unknown): ModelPlan | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const all = candidates(record.data);
  if (all.length === 0) return null;

  const tier = asNumber(record.tier, 0);
  const affordable = all.filter((row) => row.tier <= tier);
  const anthropic = affordable.filter((row) => row.vendor === 'anthropic');

  const nextBand = bands(record.tiers).find((band) => band.tier > tier) ?? null;
  const nextModels = nextBand ? all.filter((row) => row.tier === nextBand.tier) : [];

  return {
    tier,
    referralCount: asNumber(record.referralCount, 0),
    anthropic: dearest(anthropic),
    openai: dearest(affordable.filter((row) => row.vendor === 'openai')),
    any: dearest(affordable),
    // Anthropic for preference because it is Claude Code's background model that spends this; the
    // cheapest of anything is still better than a Sonnet-priced file summary.
    small: cheapest(anthropic.length > 0 ? anthropic : affordable),
    next: nextBand ? { tier: nextBand.tier, minReferrals: nextBand.minReferrals, model: dearest(nextModels) } : null,
  };
}

// ── Fetching ──────────────────────────────────────────────────────────────────────────────────

export interface FetchOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** `GET <v1>/models` with the key. Never throws; `null` means "we learned nothing". */
export async function fetchModelPlan(ep: Endpoints, token: string, options: FetchOptions = {}): Promise<ModelPlan | null> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3000;
  try {
    const res = await doFetch(`${ep.v1}/models`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return parseModelPlan(await res.json());
  } catch {
    // A timeout, a captive portal, an offline laptop. The caller has a tier-0 fallback.
    return null;
  }
}

// ── Choosing ──────────────────────────────────────────────────────────────────────────────────

/** The harnesses whose wire format decides which vendor to prefer. */
const ANTHROPIC_HARNESSES = new Set(['claude', 't3']);
const OPENAI_HARNESSES = new Set(['codex']);

export interface ModelChoice {
  /** Bare id, ready for `resolveModel`. */
  model: string;
  /** Bare id for Claude Code's background chores, or null to leave the built-in alone. */
  small: string | null;
  /**
   * One line, already phrased: the id AS THE LAUNCH WILL SET IT (prefixed — the pool pays), the
   * tier, and what the next tier would add. The unlock is named bare because that is the shorter
   * half of a `--model` argument and both spellings are accepted.
   */
  reason: string;
}

/**
 * "2 referrals unlock anthropic/claude-sonnet-5", or null when there is nothing to unlock.
 *
 * The model is named by its ID rather than by a prettified product name, because the id is the
 * thing the reader can paste after `--model` and a name we invented is a name they would then have
 * to translate back.
 */
export function unlockNote(plan: ModelPlan | null): string | null {
  const next = plan?.next;
  if (!plan || !next || !next.model || next.minReferrals <= plan.referralCount) return null;
  const needed = next.minReferrals - plan.referralCount;
  return `${needed === 1 ? '1 referral unlocks' : `${needed} referrals unlock`} ${next.model}`;
}

/**
 * The model for `harness`, and the sentence explaining it.
 *
 * A null plan is the offline case and gets `SAFE_MODEL` with a reason that says so, because a user
 * who was silently dropped to Haiku and told nothing would reasonably conclude the pool is bad
 * rather than that their DNS is.
 */
export function chooseModel(plan: ModelPlan | null, harness: string): ModelChoice {
  if (!plan) {
    return {
      model: SAFE_MODEL,
      small: SAFE_MODEL,
      reason: `${SPONSORED_PREFIX}${SAFE_MODEL} — the pool's model list is unreachable, so the tier-0 default`,
    };
  }

  const preferred = ANTHROPIC_HARNESSES.has(harness) ? plan.anthropic : OPENAI_HARNESSES.has(harness) ? plan.openai : null;
  const model = preferred ?? plan.any ?? SAFE_MODEL;
  const small = plan.small ?? SAFE_MODEL;

  const unlock = unlockNote(plan);
  return { model, small, reason: `${SPONSORED_PREFIX}${model} — the best at tier ${plan.tier}${unlock ? `; ${unlock}` : ''}` };
}
