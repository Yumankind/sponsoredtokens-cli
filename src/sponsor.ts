import { money } from './ui.ts';
import { COUNTRY_GROUPS, GROUP_NAMES, ISO_COUNTRY_COUNT, coversEveryCountry, isCountryCode } from './countries.ts';

/**
 * `sponsoredtokens sponsor` — everything about it that is a decision, with no network in sight.
 *
 * The command exists because of one question Bruno asked on 2026-09-05: how does an AI agent that
 * just spent somebody else's tokens put money back in? The answer this file implements is the
 * plainest one available. The agent runs one command, or posts one JSON body; the pool answers with
 * an ORDINARY Stripe Checkout link; the agent hands that link to the human who operates it, and the
 * human pays. There is no agent wallet, no alternative payment rail, and nothing here signs a
 * transaction. That is why the terms line says what it says, and why `payer: 'operator'` is in the
 * JSON: the person who completes the Checkout page is the person who accepts the terms.
 *
 * ── THE TWO CONSTANTS THAT ARE MIRRORED FROM SOMEWHERE ELSE ─────────────────────────────────────
 *
 * `TERMS_VERSION` and `PLATFORM_IDS` are copies. The originals live in the site and in the worker,
 * this package ships alone on npm and cannot import from either, and the two tests that read those
 * files are what stop the copies from drifting (`tests/sponsor.test.ts`). A stale terms version
 * would record the wrong agreement against a real payment; a stale platform list would refuse a
 * platform the worker accepts.
 *
 * ── WHY THE AMOUNT IS WHOLE DOLLARS ─────────────────────────────────────────────────────────────
 *
 * The site's form takes whole dollars and rounds the suggestion UP to one (`centsToWholeDollars`).
 * `--amount` is therefore whole dollars too, and the default rounds up rather than down, because
 * rounding a "this takes #1" suggestion down is exactly the amount that does not take #1.
 */

/**
 * The version of the terms a sponsorship is recorded against.
 *
 * MIRRORS `sponsoredtokens-site/src/content/index.ts`'s `TERMS_VERSION`, which itself mirrors the
 * `Version:` line of `src/content/terms.md`. `tests/sponsor.test.ts` reads that file and fails if
 * the two disagree.
 */
export const TERMS_VERSION = '2026-09-07.2';

/**
 * The platforms a bare `@handle` can be on.
 *
 * MIRRORS `worker/src/sponsored/platforms.ts`'s `PLATFORM_IDS`, which is the authority. Order is
 * that file's, X first because a handle with no platform means X.
 */
export const PLATFORM_IDS = ['x', 'github', 'youtube', 'tiktok', 'bluesky'] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];

/** What `@name` means when nothing said otherwise. `platforms.ts`'s `DEFAULT_PLATFORM`. */
export const DEFAULT_PLATFORM: PlatformId = 'x';

/** `worker/src/routes/sponsored-checkout.ts`'s `MAX_SPONSOR_CENTS` — $100,000, a typo guard. */
export const MAX_SPONSOR_CENTS = 10_000_000;

/**
 * The minimums, from `docs/sponsoredtokens/audience-contract.md`.
 *
 * A global sponsorship is on every board there is, and it starts at $10. A local one is priced BY
 * THE COUNTRY: $10 for each board it joins — one country $10, three $30, all 248-but-one $2,480.
 * That is the whole shape of the thing. A country is a board, a board is $10, and a sponsor buying
 * thirty of them is buying thirty places rather than one cheap ticket to most of the pool.
 *
 * So $10 is the entry price everywhere, and TWO countries already cost more than the world. That is
 * deliberate, not an accident of the arithmetic: naming countries is buying boards one at a time,
 * and the global board is one board. Naming ALL of them is not an expensive local sponsorship, it is
 * the global board described the long way — "everyone" IS global whatever either costs — which is
 * why that one set collapses, and why it is the only one that does.
 *
 * `MIN_LOCAL_CENTS` is therefore a RATE, not a floor. `minimumCentsFor` is the only thing that
 * should multiply it. The worker enforces the same arithmetic; doing it here too means the refusal
 * arrives before a Checkout session exists.
 */
export const MIN_GLOBAL_CENTS = 1_000;
export const MIN_LOCAL_CENTS = 1_000;

/** A refusal this CLI makes on its own, before any request. The code is what `--json` prints. */
export interface SponsorRefusal {
  code: string;
  message: string;
}

const refuse = (code: string, message: string): SponsorRefusal => ({ code, message });

export const isRefusal = (value: unknown): value is SponsorRefusal =>
  typeof value === 'object' && value !== null && typeof (value as SponsorRefusal).code === 'string';

// ── The target ────────────────────────────────────────────────────────────────────────────────

export interface SponsorTarget {
  /** What is sent to the worker, and what is printed back. The worker parses it again, for real. */
  value: string;
  /** The platform a bare handle is on, or null for a website. */
  platform: PlatformId | null;
}

const isPlatform = (value: string): value is PlatformId => (PLATFORM_IDS as readonly string[]).includes(value);

/**
 * Normalise what the caller typed, far enough to print it back and to catch a typo early.
 *
 * DELIBERATELY THINNER THAN THE WORKER'S PARSER. `worker/src/sponsored/sponsors.ts` decides what a
 * valid handle is, which hostnames are profile links, and what the slug becomes; re-implementing
 * that here would be a second opinion that can disagree with the one that counts. So this checks
 * the two things a round trip cannot fix — an empty target and a platform id the worker has never
 * heard of — normalises a bare domain to an https URL for the printed line, and sends the rest on.
 */
export function parseTarget(raw: string | undefined, platform: string | null): SponsorTarget | SponsorRefusal {
  const target = (raw ?? '').trim();
  if (!target) return refuse('missing_target', 'sponsor needs a website or a handle: sponsoredtokens sponsor acme.com');
  if (target.length > 300) return refuse('invalid_target', 'That is too long to be a website or a handle.');

  if (platform !== null && !isPlatform(platform)) {
    return refuse('unknown_platform', `Unknown platform \`${platform}\`. One of: ${PLATFORM_IDS.join(', ')}.`);
  }

  if (target.startsWith('@')) {
    return { value: target, platform: platform !== null && isPlatform(platform) ? platform : DEFAULT_PLATFORM };
  }
  // A URL: keep it as typed for the worker, and only add the scheme people leave off.
  const value = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) ? target : `https://${target}`;
  return { value, platform: null };
}

// ── The audience ──────────────────────────────────────────────────────────────────────────────

/** What the checkout body and the `--json` output carry: `'global'`, or sorted ISO alpha-2 codes. */
export type Audience = 'global' | string[];

/**
 * Printed, verbatim, when a country list turns out to name every country there is.
 *
 * There is NO ceiling on `--audience`. A local sponsorship can name any number of countries and pays
 * $10 for each, so 84 countries is $840 and there is nothing to refuse or round off — the price is
 * the count. The single exception is the set that leaves nobody out: naming all 249 is not a very
 * long local sponsorship, it is a global one described the long way, so it is sold as global. The
 * collapse is about WHO is covered rather than what it costs — "everyone" is the global board, and
 * it would still be the global board at any price. That is the only collapse there is, and
 * `coversEveryCountry` is the only thing that decides it.
 */
export const COLLAPSED_TO_GLOBAL = 'That is every country, so this is a global sponsorship.';

export interface AudienceChoice {
  /** The value sent to the worker and printed in the JSON: sorted and de-duplicated. */
  audience: Audience;
  /**
   * The country whose LOCAL board decides the default amount and the rank; null when global.
   *
   * The FIRST country the caller named, not the first alphabetically — `--audience PT,ES` is a
   * Portuguese company that also wants Spain, and the board it is shown is Portugal's. The array
   * sent to the worker is sorted all the same, because a set has no order.
   */
  board: string | null;
  /**
   * How many distinct countries the caller named, when that was enough to make this global anyway.
   *
   * Null on every other path, including a plain `--audience global` — the caller who typed `global`
   * needs no explanation, and the one who typed `eea,africa` does. The command prints
   * `COLLAPSED_TO_GLOBAL` on exactly this field, before the board is read, so the global minimum,
   * the global suggestion and a rank with no country on it never arrive without the sentence that
   * says which board the caller ended up on.
   */
  collapsedFrom: number | null;
}

export const GLOBAL_AUDIENCE: AudienceChoice = { audience: 'global', board: null, collapsedFrom: null };

/** $10 for global, $10 per country for local. The number, without the sentence explaining it. */
export const minimumCentsFor = (audience: Audience): number =>
  audience === 'global' ? MIN_GLOBAL_CENTS : MIN_LOCAL_CENTS * audience.length;

/**
 * `--audience global | <CC,CC,…>` → the value the request carries, or a refusal.
 *
 * Everything a person might reasonably type is accepted — lower case, spaces around the commas, a
 * group name mixed in with plain codes, the same country twice — and everything else is REFUSED by
 * name rather than dropped. A silently ignored country is a sponsor paying to be seen somewhere they
 * are not, which is the one failure mode this parser exists to prevent.
 *
 * `global` is not a country and cannot be one of several: `--audience global,PT` is either "the
 * world" or "Portugal" and there is no reading of it that is both, so it is a usage error.
 *
 * A list naming EVERY country comes back as `global` with `collapsedFrom` set, not as a refusal.
 * See `COLLAPSED_TO_GLOBAL` for why that one set is different.
 */
export function parseAudience(raw: string | null | undefined): AudienceChoice | SponsorRefusal {
  const text = (raw ?? '').trim();
  if (!text) return GLOBAL_AUDIENCE;

  const tokens = text.split(',').map((token) => token.trim());
  if (tokens.some((token) => !token)) {
    return refuse('invalid_audience', `--audience has an empty entry in \`${text}\`. Write it as PT,ES — one comma between countries.`);
  }

  const sawGlobal = tokens.some((token) => token.toLowerCase() === 'global');
  if (sawGlobal && tokens.length > 1) {
    return refuse(
      'invalid_audience',
      'global means every board, so it cannot be mixed with countries. Pick one: --audience global, or --audience PT,ES.',
    );
  }
  if (sawGlobal) return GLOBAL_AUDIENCE;

  const codes: string[] = [];
  for (const token of tokens) {
    const group = COUNTRY_GROUPS[token.toLowerCase()];
    if (group) {
      codes.push(...group);
      continue;
    }
    const code = token.toUpperCase();
    if (!isCountryCode(code)) {
      return refuse(
        'invalid_audience',
          `\`${token}\` is not a country. --audience takes ISO-3166-1 alpha-2 codes (PT, ES) — there are ${ISO_COUNTRY_COUNT} of them — the word global, or a group: ${GROUP_NAMES.join(', ')}.`,
      );
    }
    codes.push(code);
  }

  const unique = [...new Set(codes)].sort();
  if (coversEveryCountry(unique)) {
    return { audience: 'global', board: null, collapsedFrom: unique.length };
  }
  return { audience: unique, board: codes[0]!, collapsedFrom: null };
}

// ── The amount ────────────────────────────────────────────────────────────────────────────────

/** What `/api/leaderboard` tells us that this command needs. Nothing here is decoration. */
export interface SponsorBoard {
  /** Remaining balances of the top sponsors, descending. The endpoint returns at most ten. */
  balances: number[];
  /** Every visible sponsor, including the ones past the top ten. */
  total: number;
  /** The top balance plus $5 — the amount that takes #1. */
  suggestedCents: number;
  /** What the worker will refuse below. */
  minimumCents: number;
}

/** Whole dollars, rounded up, in cents. The site's `centsToWholeDollars`, kept in cents. */
export const wholeDollars = (cents: number): number => Math.ceil(cents / 100) * 100;

export interface AmountRequest {
  /** `--amount`, in whole dollars, or null to take the board's suggestion. */
  dollars: number | null;
  /** The board this sponsorship is being bought on. Null when it could not be read. */
  board: SponsorBoard | null;
  /** Which minimum applies, and which board's suggestion the default takes. */
  audience: Audience;
}

/** `1 country needs`, `3 countries need`. The refusal says the count back — the count IS the price. */
const countriesNeed = (n: number): string => (n === 1 ? '1 country needs' : `${n} countries need`);

/**
 * The amount, in cents, or a refusal — decided entirely before anything is POSTed.
 *
 * The minimum is the AUDIENCE's ($10 global, $10 a country local), raised to the board's own if
 * that board asks for more: the two agree today, and if the pool ever raises one of them the CLI
 * follows the live number rather than minting a session the worker will refuse.
 *
 * The DEFAULT is floored at that minimum. The board's suggestion is "the top balance plus $5", which
 * on a quiet local board is a few dollars — below what thirty countries cost. Taking the suggestion
 * literally would refuse the amount the command itself proposed, which is no way to be told a price.
 *
 * The ceiling is checked here as well as at the worker on purpose: $100,000 is a typo guard, and a
 * typo caught after a round trip is a typo the caller has already stopped watching for.
 */
export function resolveAmountCents(request: AmountRequest): number | SponsorRefusal {
  const minimum = Math.max(minimumCentsFor(request.audience), request.board?.minimumCents ?? 0);

  let cents: number;
  if (request.dollars === null) {
    if (!request.board) {
      return refuse(
        'leaderboard_unreachable',
        'The pool could not be read, so there is no suggested amount. Name one: --amount 50.',
      );
    }
    // Never propose an amount this same function is about to refuse.
    cents = Math.max(wholeDollars(request.board.suggestedCents), minimum);
  } else {
    if (!Number.isFinite(request.dollars) || !Number.isInteger(request.dollars) || request.dollars <= 0) {
      return refuse('invalid_amount', '--amount takes whole dollars, e.g. --amount 50.');
    }
    cents = request.dollars * 100;
  }

  if (cents < minimum) {
    const why =
      request.audience === 'global'
        ? `a global sponsorship is on every board there is, and the least it can be bought for is ${money(minimum)}`
        : `${countriesNeed(request.audience.length)} at least ${money(minimum)} — a local sponsorship is ${money(MIN_LOCAL_CENTS)} for each board it joins`;
    return refuse('amount_below_minimum', `You asked for ${money(cents)} — ${why}.`);
  }
  if (cents > MAX_SPONSOR_CENTS) {
    return refuse(
      'amount_above_maximum',
      `${money(MAX_SPONSOR_CENTS)} is the most one payment can carry. Write to sponsors@sponsoredtokens.com to sponsor more.`,
    );
  }
  return cents;
}

// ── The rank ──────────────────────────────────────────────────────────────────────────────────

export interface Rank {
  /** 1-based, counting the sponsorship being bought. */
  position: number;
  /** Sponsors on the board once this one lands. */
  outOf: number;
  /**
   * False when the amount falls below every balance the endpoint returned AND there are sponsors it
   * did not return — the position is then a best case, not a fact. `/api/leaderboard` shows ten.
   */
  exact: boolean;
}

/**
 * Where this amount lands, counted the way the site counts it.
 *
 * `sponsoredtokens-site/src/lib/board-side.ts`'s `landingRank`: one more than however many sponsors
 * have at least this much left. Ties go to the sponsor who was already there, which is the same
 * rule the site's own "…takes #4" label uses, so the terminal and the page cannot disagree.
 */
export function rankFor(board: SponsorBoard, amountCents: number): Rank {
  const ahead = board.balances.filter((balance) => balance >= amountCents).length;
  return {
    position: ahead + 1,
    outOf: board.total + 1,
    exact: !(ahead === board.balances.length && board.total > board.balances.length),
  };
}

/** `#1 — the top spot` · `#4 of 13` · `#11 or lower of 40`. */
export function rankLabel(rank: Rank): string {
  if (!rank.exact) return `#${rank.position} or lower of ${rank.outOf}`;
  if (rank.position === 1) return `#1 — the top spot`;
  return `#${rank.position} of ${rank.outOf}`;
}

/**
 * The rank as the terminal prints it — and, for a local sponsorship, WHICH board it is a rank on.
 *
 * A `#1` that does not say "on the local board of PT" is the same sentence a $100,000 global
 * sponsorship earns, for $10. The board named is the first country the caller chose, which is the
 * board the amount was suggested against.
 */
export function rankLine(rank: Rank, choice: AudienceChoice): string {
  return choice.board ? `${rankLabel(rank)} on the local board of ${choice.board}` : rankLabel(rank);
}

// ── The request and the answer ────────────────────────────────────────────────────────────────

/** Exactly what `POST /api/sponsor/checkout` reads. Nothing optional is sent as `undefined`. */
export interface CheckoutBody {
  target: string;
  platform?: PlatformId;
  amountCents: number;
  /** `'global'`, or the sorted country codes. Sent always, so the stored audience is never a guess. */
  audience: Audience;
  termsVersion: string;
  acceptTerms: true;
}

export function checkoutBody(target: SponsorTarget, amountCents: number, audience: Audience): CheckoutBody {
  return {
    target: target.value,
    ...(target.platform ? { platform: target.platform } : {}),
    amountCents,
    audience,
    termsVersion: TERMS_VERSION,
    acceptTerms: true,
  };
}

/**
 * The worker's refusals, in the words a terminal should show them in.
 *
 * The codes are `routes/sponsored-checkout.ts`'s. Anything not listed is printed as the worker sent
 * it — a new refusal should read as itself rather than as "something went wrong".
 */
const WORKER_REFUSALS: Record<string, string> = {
  amount_below_minimum: 'That is below the pool’s minimum sponsorship.',
  amount_above_maximum: 'That is above the $100,000 a single payment can carry.',
  amount_must_be_integer_cents: 'The amount has to be a whole number of cents.',
  terms_not_accepted: 'The terms were not accepted. This is a bug in the CLI — please report it.',
  terms_version_required: 'The terms version was rejected. Update the CLI: npm i -g sponsoredtokens.',
  invalid_target: 'That is not a website or a handle the pool can sponsor.',
  // A LISTING RULE, not a typo (Bruno, 2026-09-07). The worker read the link perfectly and answers
  // with `reason` (`chat_link`, `shortener`) and a sentence of its own; the sentence is what a
  // person needs, so this line only says which kind of answer it is and then gets out of the way.
  // `refusalFrom` appends the worker's `message`, so a reason invented later still reads as itself.
  target_not_allowed: 'That link cannot be listed.',
  invalid_audience: 'The pool refused that audience. Give it country codes (--audience PT,ES) or --audience global.',
  invalid_email: 'That email address was refused.',
  invalid_json: 'The pool could not read the request. This is a bug in the CLI — please report it.',
  rate_limited: 'Too many attempts from this address. Wait a minute and try again.',
  checkout_failed: 'Stripe would not open a Checkout session. Try again shortly.',
};

/** A `{ error, code?, message? }` body from the worker → the pair `--json` prints. */
export function refusalFrom(status: number, body: unknown): SponsorRefusal {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const raw = typeof record.code === 'string' ? record.code : typeof record.error === 'string' ? record.error : `http_${status}`;
  const detail = typeof record.message === 'string' && record.message ? ` ${record.message}` : '';
  const known = WORKER_REFUSALS[raw];
  if (known) return refuse(raw, `${known}${detail}`);
  // `{ error: 'sponsoredtokens is not configured', variable: 'STRIPE_SECRET_KEY' }` and anything new.
  return refuse(raw, `The pool refused the sponsorship (${status}): ${raw}${detail}`);
}

/** What `POST /api/sponsor/checkout` answers with on success. */
export interface CheckoutResult {
  checkoutUrl: string;
  /** The pool's short `/p/<code>` link to the same page — what the QR is drawn from. */
  shortUrl: string | null;
  sponsorId: string | null;
  slug: string | null;
  amountCents: number;
}

/** Read the answer defensively: an edge error page must not become a `TypeError`. */
export function checkoutResult(body: unknown, amountCents: number): CheckoutResult | SponsorRefusal {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const url = typeof record.url === 'string' ? record.url : '';
  const shortUrl = typeof record.shortUrl === 'string' ? record.shortUrl : null;
  if (!url) return refuse('no_checkout_url', 'The pool accepted the sponsorship but returned no payment link.');
  return {
    checkoutUrl: url,
    shortUrl,
    sponsorId: typeof record.sponsorId === 'string' ? record.sponsorId : null,
    slug: typeof record.slug === 'string' ? record.slug : null,
    amountCents: typeof record.amountCents === 'number' ? record.amountCents : amountCents,
  };
}

// ── The JSON an agent reads ───────────────────────────────────────────────────────────────────

export interface SponsorJson {
  target: string;
  platform: PlatformId | null;
  /** `'global'`, or the sorted countries this sponsorship will be seen in. */
  audience: Audience;
  amountCents: number;
  /** Null when the leaderboard could not be read and the rank is therefore unknown. */
  rank: number | null;
  checkoutUrl: string;
  /** The same page behind a ~40-byte link on sponsoredtokens.com, good for a day; null when the worker gave none. */
  shortUrl: string | null;
  terms: { version: string; payer: 'operator' };
}

/**
 * The one object `--json` prints, and the contract the agents page documents.
 *
 * `payer: 'operator'` is the whole point of the field: the link is paid, and the terms accepted, by
 * the human the agent works for — on Stripe's own page, with their own card. No field here implies
 * the agent can settle it.
 */
export function sponsorJson(
  target: SponsorTarget,
  amountCents: number,
  rank: Rank | null,
  result: CheckoutResult,
  audience: Audience,
): SponsorJson {
  return {
    target: target.value,
    platform: target.platform,
    audience,
    amountCents: result.amountCents,
    rank: rank ? rank.position : null,
    checkoutUrl: result.checkoutUrl,
    shortUrl: result.shortUrl,
    terms: { version: TERMS_VERSION, payer: 'operator' },
  };
}
