/**
 * `src/tokens.ts` — the pool in tokens, and the copy that must not drift.
 *
 * WHAT THIS FILE IS GUARDING is that one product quotes one size. sponsoredtokens.com converts cents
 * to tokens at a named reference price in `sponsoredtokens-site/src/lib/tank.ts`, and this package
 * cannot import that module — it ships to npm on its own and the site's modules reach for the DOM —
 * so the constant and the two formatters are COPIED. A copy that drifts fails nothing at runtime:
 * the CLI would simply print a different number from the home page for the same pool, and the first
 * person to notice would be a user comparing the two.
 *
 * So the originals are read back as TEXT and compared, which is the trick the site's own
 * `test/signin-page.test.ts` uses to pin its copy of the worker's allowance constants. The same is
 * done for `tokensFigure` in `lib/pool-line.ts`, which is the rule `poolTokens` follows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  REFERENCE_CENTS_PER_MILLION,
  REFERENCE_MODEL,
  TOKENS_FOOTNOTE,
  centsToTokens,
  formatTokens,
  listTokens,
  poolTokens,
} from '../src/tokens.ts';

const source = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const TANK = '../../../sponsoredtokens-site/src/lib/tank.ts';
const POOL_LINE = '../../../sponsoredtokens-site/src/lib/pool-line.ts';
const OURS = '../src/tokens.ts';

/**
 * The text of one `export function name(…)` or `function name(…)`, from its signature to the closing
 * brace in column 0. Comments and blank lines are dropped, and the remaining lines are trimmed, so
 * that a reworded doc comment or a re-indent is not a failure and a changed EXPRESSION is.
 */
function body(text: string, name: string): string {
  const start = text.search(new RegExp(`^(export )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `expected a function ${name}`);
  const end = text.indexOf('\n}', start);
  assert.notEqual(end, -1, `expected ${name} to close`);
  return text
    .slice(start, end + 2)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))
    .join('\n');
}

// ── The copy ──────────────────────────────────────────────────────────────────────────────────

test('the reference price is the site’s, and a drift fails here', () => {
  // `sponsoredtokens-site/src/lib/tank.ts` is the authority. Sonnet 5 at POOL prices: $4 per million
  // input, $20 per million output, $24 per million blended.
  const found = /export const REFERENCE_CENTS_PER_MILLION = (\d+);/.exec(source(TANK));
  assert.ok(found, 'lib/tank.ts should export REFERENCE_CENTS_PER_MILLION');
  assert.equal(REFERENCE_CENTS_PER_MILLION, Number(found[1]), 'the CLI would quote a different size than the home page');
  assert.equal(REFERENCE_CENTS_PER_MILLION, 2400);
});

test('`formatTokens` and `centsToTokens` are the site’s, character for character', () => {
  const tank = source(TANK);
  const ours = source(OURS);
  for (const name of ['formatTokens', 'centsToTokens']) {
    assert.equal(body(ours, name), body(tank, name), `src/tokens.ts's ${name} has drifted from lib/tank.ts's`);
  }
});

test('`poolTokens` follows the hero’s rule, so one pool is not rounded two ways', () => {
  // `tokensFigure` in `lib/pool-line.ts`: two decimals below ten of a unit, one above, because the
  // two figures on that line are read against each other. `poolTokens` is the same rule inlined.
  const theirs = body(source(POOL_LINE), 'tokensFigure');
  assert.match(theirs, /tokens \/ unit < 10 \? 2 : 1/);
  assert.match(body(source(OURS), 'poolTokens'), /tokens \/ unitOf\(tokens\) < 10 \? 2 : 1/);
});

test('the footnote names the model, and the model is the one the price is for', () => {
  assert.equal(TOKENS_FOOTNOTE, 'Token figures are at Claude Sonnet 5 prices.');
  // The site's own note names the same model; a rename on one side must not leave the other quoting
  // a price for a model nobody mentioned.
  assert.match(source(TANK), /Claude Sonnet 5 at pool prices/);
  assert.ok(TOKENS_FOOTNOTE.includes(REFERENCE_MODEL));
});

// ── The conversion ────────────────────────────────────────────────────────────────────────────

test('cents become tokens at the reference price, and nothing becomes nothing', () => {
  assert.equal(centsToTokens(2400), 1_000_000);
  assert.equal(centsToTokens(0), 0);
  assert.equal(centsToTokens(-500), 0, 'a negative balance is not a negative number of tokens');
});

test('`formatTokens` scales and never prints "0.0M" for a pool that still has something in it', () => {
  assert.equal(formatTokens(67_700_000), '67.7M');
  assert.equal(formatTokens(1_200_833, 2), '1.20M');
  assert.equal(formatTokens(2_500_000_000), '2.5B');
  assert.equal(formatTokens(805_416, 0), '805K');
  assert.equal(formatTokens(412), '412');
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(Number.NaN), '0');
  // The site clamps the places to 0–2, and so must the copy.
  assert.equal(formatTokens(1_200_833, 9), '1.20M');
});

// ── The two precisions ────────────────────────────────────────────────────────────────────────

test('the pool pair keeps the decimal that tells two close figures apart', () => {
  // Bruno's own pool, 2026-09-07: $28.82 left of $30 sponsored. At one decimal these two print
  // identically, which is the whole reason for the second.
  assert.equal(poolTokens(2_882), '1.20M');
  assert.equal(poolTokens(3_000), '1.25M');
  assert.equal(poolTokens(162_450), '67.7M');
  assert.equal(poolTokens(326_200), '135.9M');
  assert.equal(poolTokens(0), '0');
});

test('a figure in a row of figures gets three significant digits, wherever it lands', () => {
  assert.equal(listTokens(1_933), '805K'); // $19.33
  assert.equal(listTokens(948), '395K'); //  $9.48
  assert.equal(listTokens(2_000), '833K'); // $20
  assert.equal(listTokens(1_000), '417K'); // $10
  assert.equal(listTokens(1_875), '781K'); // the weekly budget's remainder
  assert.equal(listTokens(48_200), '20.1M');
  assert.equal(listTokens(22_750), '9.48M');
  assert.equal(listTokens(0), '0');
});
