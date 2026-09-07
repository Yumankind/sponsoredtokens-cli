/**
 * THE POOL, IN TOKENS — the site's number, in a terminal.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────────
 *
 * sponsoredtokens.com says tokens everywhere: the hero's tank, the sign-in tank, the sponsor cards
 * and the footer's note are all `sponsoredtokens-site/src/lib/tank.ts` converting cents at one named
 * reference price. Until 0.3.7 this CLI said DOLLARS — "Pool $28.82 left of $30 sponsored" beside a
 * home page saying "1.20M free AI tokens available" — so the two halves of one product quoted two
 * different units for the same fact, and a reader had to do the division themselves to see they
 * agreed. They now say the same thing.
 *
 * `sponsor` is the deliberate exception and stays in dollars, because the checkout amount is a
 * PRICE: it is what the card is charged, and quoting a price in tokens would be a conversion nobody
 * asked for on the one number that has to be exact.
 *
 * ── THE CONVERSION IS A SIZE, NOT A QUOTE ───────────────────────────────────────────────────────
 *
 * The pool spends on whatever model each task picks, so there is no single true rate. The reference
 * price is Claude Sonnet 5 at POOL prices — $4 per million input, $20 per million output, $24 per
 * million blended — which is what `REFERENCE_CENTS_PER_MILLION` is. Every screen that prints one of
 * these figures also prints `TOKENS_FOOTNOTE`, because a token figure with no price attached to it
 * means nothing.
 *
 * ── THE COPY IS CHECKED, NOT TRUSTED ────────────────────────────────────────────────────────────
 *
 * This package cannot import from the site (it ships to npm on its own and the site's modules reach
 * for the DOM), so the constant and the two formatters are COPIED. `tests/tokens.test.ts` reads
 * `tank.ts` as TEXT and fails if either copy has drifted — the same trick the site's own
 * `test/signin-page.test.ts` uses to pin its copy of the worker's allowance constants. A silent
 * drift here would have the CLI and the home page quoting different sizes for the same pool, which
 * is the exact bug this file was written to end.
 *
 * ── TWO PRECISIONS, AND WHY THEY DIFFER ─────────────────────────────────────────────────────────
 *
 *   `poolTokens` — THE SITE'S OWN RULE, copied from `tokensFigure` in `lib/pool-line.ts`: two
 *   decimals below ten of a unit, one above. The two figures on the `Pool` line are read AGAINST
 *   each other ("1.20M left of 1.25M sponsored"), and at one decimal a pool four percent down
 *   prints as "1.2M of 1.3M", which looks like a rounding error rather than a pool. Using the
 *   hero's rule means the CLI's pool line and the home page's cannot round the same pool
 *   differently.
 *
 *   `listTokens` — THREE SIGNIFICANT FIGURES, for the leaderboard names and the budget's size.
 *   Those are read one against the next in a row that must fit on eighty columns, and a fixed
 *   decimal is wrong at both ends of the range: "805.4K" carries a digit nobody reads, and "20M"
 *   for 20.08M throws away one they do. Three figures is what `money` gives ("$482", "$1,200") and
 *   the same amount of information, in the other unit.
 */

/** Named on every screen that prints one of these figures. See `TOKENS_FOOTNOTE`. */
export const REFERENCE_MODEL = 'Claude Sonnet 5';

/**
 * $24 per million blended, in cents — `REFERENCE_CENTS_PER_MILLION` in the site's `lib/tank.ts`,
 * copied verbatim and pinned by `tests/tokens.test.ts`.
 */
export const REFERENCE_CENTS_PER_MILLION = 2400;

/** The one line that has to accompany a token figure. Printed once per block, never per number. */
export const TOKENS_FOOTNOTE = `Token figures are at ${REFERENCE_MODEL} prices.`;

/**
 * `67_700_000` → `67.7M`. One decimal, and never "0.0M" for a pool that still has something in it.
 *
 * COPIED VERBATIM from `sponsoredtokens-site/src/lib/tank.ts`; `tests/tokens.test.ts` compares the
 * two texts. Do not "improve" it here — improve it there and copy it back, or the CLI and the home
 * page will round the same pool to two different sizes.
 */
export function formatTokens(tokens: number, decimals = 1): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  const places = Math.max(0, Math.min(2, Math.round(decimals)));
  if (tokens >= 1e9) return `${(tokens / 1e9).toFixed(places)}B`;
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(places)}M`;
  if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(places)}K`;
  return String(Math.round(tokens));
}

/** Cents of pool balance as tokens at the reference price. Copied verbatim; see above. */
export function centsToTokens(cents: number): number {
  return cents > 0 ? (cents / REFERENCE_CENTS_PER_MILLION) * 1_000_000 : 0;
}

/** Which power of ten `formatTokens` will divide by, so a caller can choose its own precision. */
function unitOf(tokens: number): number {
  return tokens >= 1e9 ? 1e9 : tokens >= 1e6 ? 1e6 : tokens >= 1e3 ? 1e3 : 1;
}

/**
 * A figure that is read against another figure: `1.20M left of 1.25M`.
 *
 * The rule is `tokensFigure` in the site's `lib/pool-line.ts`, copied so the CLI's pool line and the
 * home page's hero cannot round one pool two ways. `tests/tokens.test.ts` pins the copy.
 */
export function poolTokens(cents: number): string {
  const tokens = centsToTokens(Math.max(0, cents));
  return formatTokens(tokens, tokens / unitOf(tokens) < 10 ? 2 : 1);
}

/** A figure in a row of figures, at three significant digits: `9.48M`, `20.1M`, `805K`. */
export function listTokens(cents: number): string {
  const tokens = centsToTokens(Math.max(0, cents));
  const scaled = tokens / unitOf(tokens);
  return formatTokens(tokens, scaled < 10 ? 2 : scaled < 100 ? 1 : 0);
}
