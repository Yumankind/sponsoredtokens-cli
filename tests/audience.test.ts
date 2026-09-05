/**
 * `--audience`: the countries a sponsorship is bought in, and the two minimums that follow from it.
 *
 * `docs/sponsoredtokens/audience-contract.md` is what this is built against. Two things in it have
 * money attached and are therefore tested hardest: a country that is silently dropped is a sponsor
 * paying to be seen somewhere they are not, and the minimum ($100 global, $10 local) is the price
 * difference between the two boards.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_AUDIENCE_COUNTRIES,
  MIN_GLOBAL_CENTS,
  MIN_LOCAL_CENTS,
  checkoutBody,
  isRefusal,
  minimumCentsFor,
  parseAudience,
  parseTarget,
  rankFor,
  rankLine,
  resolveAmountCents,
  sponsorJson,
  type AudienceChoice,
  type SponsorBoard,
} from '../src/sponsor.ts';
import { COUNTRY_GROUPS, GROUP_NAMES, isCountryCode } from '../src/countries.ts';

const choice = (raw: string | null): AudienceChoice => {
  const parsed = parseAudience(raw);
  assert.ok(!isRefusal(parsed), `expected \`${raw}\` to parse, got ${JSON.stringify(parsed)}`);
  return parsed;
};

// ── Parsing ───────────────────────────────────────────────────────────────────────────────────

test('no --audience at all is global, and so is the word itself', () => {
  assert.deepEqual(parseAudience(null), { audience: 'global', board: null });
  assert.deepEqual(parseAudience(undefined), { audience: 'global', board: null });
  assert.deepEqual(parseAudience('  '), { audience: 'global', board: null });
  assert.deepEqual(parseAudience('global'), { audience: 'global', board: null });
  assert.deepEqual(parseAudience('GLOBAL'), { audience: 'global', board: null });
});

test('plain codes are upper-cased, de-duplicated and sorted', () => {
  assert.deepEqual(choice('pt,es').audience, ['ES', 'PT']);
  assert.deepEqual(choice('PT, es , Pt').audience, ['ES', 'PT']);
  assert.deepEqual(choice('us,gb,de,fr').audience, ['DE', 'FR', 'GB', 'US']);
});

test('the board is the FIRST country named, not the first alphabetically', () => {
  const pt = choice('pt,es');
  assert.deepEqual(pt.audience, ['ES', 'PT'], 'the wire carries a sorted set');
  assert.equal(pt.board, 'PT', 'the board is the one the sponsor chose first');
  assert.equal(choice('es,pt').board, 'ES');
  assert.equal(choice('global').board, null);
});

test('a group name stands for its countries, and the contract’s twelve are all there', () => {
  assert.deepEqual(GROUP_NAMES, [
    'eu', 'eea', 'dach', 'nordics', 'iberia', 'uk-ie',
    'north-america', 'latam', 'apac', 'middle-east', 'africa', 'english',
  ]);
  assert.deepEqual(choice('dach').audience, ['AT', 'CH', 'DE']);
  assert.deepEqual(choice('nordics').audience, ['DK', 'FI', 'IS', 'NO', 'SE']);
  assert.deepEqual(choice('iberia').audience, ['ES', 'PT']);
  assert.deepEqual(choice('uk-ie').audience, ['GB', 'IE']);
  assert.deepEqual(choice('north-america').audience, ['CA', 'MX', 'US']);
  assert.deepEqual(choice('english').audience, ['AU', 'CA', 'GB', 'IE', 'NZ', 'US']);
  assert.equal(choice('eu').audience.length, 27, 'the EU has 27 member states');
  assert.equal(choice('eea').audience.length, 30, 'the EEA is the EU plus IS, LI, NO');
  for (const added of ['IS', 'LI', 'NO']) assert.ok((choice('eea').audience as string[]).includes(added));
  assert.equal(choice('africa').audience.length, 54, 'the African Union’s member states');
});

test('a group name is case-insensitive, like a country code', () => {
  assert.deepEqual(choice('DACH').audience, choice('dach').audience);
  assert.deepEqual(choice('Uk-Ie').audience, ['GB', 'IE']);
});

test('groups and codes mix in one list, and the overlap between them collapses', () => {
  assert.deepEqual(choice('dach,PT').audience, ['AT', 'CH', 'DE', 'PT']);
  assert.deepEqual(choice('iberia,pt,es').audience, ['ES', 'PT'], 'a country named twice is one country');
  assert.deepEqual(choice('uk-ie,english').audience, ['AU', 'CA', 'GB', 'IE', 'NZ', 'US']);
  assert.equal(choice('dach,PT').board, 'DE', 'the first country of the first token — DACH leads with Germany');
});

test('every code in every group is a code the parser itself would accept', () => {
  for (const [name, codes] of Object.entries(COUNTRY_GROUPS)) {
    for (const code of codes) assert.ok(isCountryCode(code), `${name} carries ${code}, which is not an ISO alpha-2 country`);
  }
});

test('something that is not a country is refused by name, not dropped', () => {
  for (const bad of ['ZZZ', 'PRT', 'p', '12', 'portugal', 'eu-27']) {
    const refusal = parseAudience(bad);
    assert.ok(isRefusal(refusal) && refusal.code === 'invalid_audience', `${bad} should be refused`);
    assert.match(refusal.message, new RegExp(bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the refusal quotes what was typed');
  }
  const partial = parseAudience('PT,portugal');
  assert.ok(isRefusal(partial), 'one bad entry refuses the whole list rather than sponsoring half of it');
});

test('T1 and XX look like countries and are not', () => {
  for (const pseudo of ['T1', 'xx']) {
    const refusal = parseAudience(pseudo);
    assert.ok(isRefusal(refusal) && refusal.code === 'invalid_audience');
  }
  assert.equal(isCountryCode('T1'), false);
  assert.equal(isCountryCode('XX'), false);
});

test('an empty entry is a typo worth naming', () => {
  for (const bad of ['PT,', ',PT', 'PT,,ES']) {
    const refusal = parseAudience(bad);
    assert.ok(isRefusal(refusal) && refusal.code === 'invalid_audience', `${bad} should be refused`);
    assert.match(refusal.message, /empty entry/);
  }
});

test('global cannot be one of several — it is either the world or a list', () => {
  const refusal = parseAudience('global,PT');
  assert.ok(isRefusal(refusal) && refusal.code === 'invalid_audience');
  assert.match(refusal.message, /cannot be mixed with countries/);
  assert.ok(isRefusal(parseAudience('PT,global')));
  assert.ok(isRefusal(parseAudience('eu,global')));
});

test('past the contract’s 80 countries the sponsorship is global, and says so', () => {
  const refusal = parseAudience('eea,africa'); // 30 + 54, and nothing in both
  assert.ok(isRefusal(refusal) && refusal.code === 'invalid_audience');
  assert.match(refusal.message, /84 countries/);
  assert.match(refusal.message, /--audience global/);
  assert.equal(MAX_AUDIENCE_COUNTRIES, 80);
  assert.equal(choice('africa').audience.length <= MAX_AUDIENCE_COUNTRIES, true);
});

// ── The minimum ───────────────────────────────────────────────────────────────────────────────

const GLOBAL_BOARD: SponsorBoard = { balances: [48_200, 31_500], total: 13, suggestedCents: 48_700, minimumCents: MIN_GLOBAL_CENTS };
const LOCAL_BOARD: SponsorBoard = { balances: [4_000, 1_500], total: 2, suggestedCents: 4_500, minimumCents: MIN_LOCAL_CENTS };

test('the two minimums are the contract’s: $100 everywhere, $10 in the countries you name', () => {
  assert.equal(MIN_GLOBAL_CENTS, 10_000);
  assert.equal(MIN_LOCAL_CENTS, 1_000);
  assert.equal(minimumCentsFor('global'), 10_000);
  assert.equal(minimumCentsFor(['PT']), 1_000);
});

test('$50 is below the global minimum and the refusal says which minimum, and why', () => {
  const refusal = resolveAmountCents({ dollars: 50, board: GLOBAL_BOARD, audience: 'global' });
  assert.ok(isRefusal(refusal) && refusal.code === 'amount_below_minimum');
  assert.match(refusal.message, /global/);
  assert.match(refusal.message, /\$100\b/);
  assert.match(refusal.message, /--audience/, 'and it names the cheaper way to be seen somewhere');
});

test('the same $50 is fine locally, and $5 is not', () => {
  assert.equal(resolveAmountCents({ dollars: 50, board: LOCAL_BOARD, audience: ['PT'] }), 5_000);
  assert.equal(resolveAmountCents({ dollars: 10, board: LOCAL_BOARD, audience: ['ES', 'PT'] }), 1_000);
  const refusal = resolveAmountCents({ dollars: 5, board: LOCAL_BOARD, audience: ['PT'] });
  assert.ok(isRefusal(refusal) && refusal.code === 'amount_below_minimum');
  assert.match(refusal.message, /local/);
  assert.match(refusal.message, /\$10\b/);
});

test('a board asking for more than its audience’s floor wins, so nothing is minted to be refused', () => {
  const strict: SponsorBoard = { ...LOCAL_BOARD, minimumCents: 2_500 };
  const refusal = resolveAmountCents({ dollars: 20, board: strict, audience: ['PT'] });
  assert.ok(isRefusal(refusal) && refusal.code === 'amount_below_minimum');
  assert.match(refusal.message, /\$25/);
});

test('the default amount is the board’s own suggestion — the local one for a local audience', () => {
  assert.equal(resolveAmountCents({ dollars: null, board: LOCAL_BOARD, audience: ['PT'] }), 4_500);
  assert.equal(rankFor(LOCAL_BOARD, 4_500).position, 1, 'which is the amount that takes #1 on THAT board');
  assert.equal(resolveAmountCents({ dollars: null, board: GLOBAL_BOARD, audience: 'global' }), 48_700);
});

// ── What the rank line and the request carry ──────────────────────────────────────────────────

test('the rank line names the local board, and is unchanged for a global sponsorship', () => {
  const rank = rankFor(LOCAL_BOARD, 4_500);
  assert.equal(rankLine(rank, choice('pt,es')), '#1 — the top spot on the local board of PT');
  assert.equal(rankLine(rankFor(LOCAL_BOARD, 2_000), choice('pt')), '#2 of 3 on the local board of PT');
  assert.equal(rankLine(rank, choice('global')), '#1 — the top spot');
});

test('the audience rides on the request and on the JSON an agent reads', () => {
  const target = parseTarget('acme.com', null) as never;
  const local = choice('pt,es');
  assert.deepEqual(checkoutBody(target, 1_000, local.audience).audience, ['ES', 'PT']);
  assert.equal(checkoutBody(target, 10_000, 'global').audience, 'global');

  const result = { checkoutUrl: 'https://checkout.example/x', shortUrl: null, sponsorId: 'sp_1', slug: 'acme.com', amountCents: 1_000 };
  assert.deepEqual(sponsorJson(target, 1_000, rankFor(LOCAL_BOARD, 1_000), result, local.audience).audience, ['ES', 'PT']);
  assert.equal(sponsorJson(target, 10_000, null, result, 'global').audience, 'global');
});
