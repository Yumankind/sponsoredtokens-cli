/**
 * The country codes `sponsor --audience` accepts, and the group names that stand for a list of them.
 *
 * ONE PLACE. `docs/sponsoredtokens/audience-contract.md` names twelve groups as "picker sugar,
 * expanded to ISO codes before the request" — the API takes codes and nothing else. The site expands
 * them in its picker; this file is the CLI's copy of the same expansion, and it is a copy on purpose:
 * this package publishes to npm on its own and cannot import from the site.
 *
 * ── WHY THE OPEN-ENDED GROUPS ARE WRITTEN OUT ───────────────────────────────────────────────────
 *
 * Four of the twelve have no closed definition anywhere — `latam`, `apac`, `middle-east`, `africa`.
 * The choice made here is written down rather than left to a reader's guess, because a sponsor is
 * paying for exactly these countries and "roughly Asia" is not a thing money can buy:
 *
 *   - `latam`   the Spanish- and Portuguese-speaking Americas, which is the contract's own wording:
 *               the twenty countries and territories whose official language is one of the two.
 *               Mexico is in it AND in `north-america`; that overlap is real, not a mistake.
 *   - `apac`    East, South and South-East Asia plus Australia, New Zealand and the two Pacific
 *               states big enough to have a developer market (FJ, PG). Not the Middle East, which is
 *               its own group, and not Russia, which straddles a line this list does not draw.
 *   - `middle-east`  the Arabian peninsula, the Levant, Iraq, Iran, Türkiye and Egypt. Egypt is in
 *               `africa` too, for the same honest reason Mexico is in two lists.
 *   - `africa`  all 54 member states of the African Union, which is the one list of "Africa" that
 *               somebody else maintains and everybody recognises.
 *
 * None of this is authoritative for the pool — the worker validates the CODES, never the groups. A
 * sponsor who disagrees with a group writes the codes out.
 */

/** ISO-3166-1 alpha-2, the EU's 27 member states. */
const EU = [
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU',
  'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
] as const;

/**
 * Every group name the CLI accepts, and the codes it stands for.
 *
 * The names are the contract's, lower-cased and hyphenated the way a flag value is typed. Order
 * inside a list does not matter — `parseAudience` sorts and de-duplicates whatever comes out of it.
 */
export const COUNTRY_GROUPS: Record<string, readonly string[]> = {
  /** The European Union, 27 states. */
  eu: EU,
  /** The EEA: the EU plus Iceland, Liechtenstein and Norway. */
  eea: [...EU, 'IS', 'LI', 'NO'],
  /** German-speaking Europe. */
  dach: ['DE', 'AT', 'CH'],
  /** The Nordics, including Iceland. */
  nordics: ['DK', 'FI', 'IS', 'NO', 'SE'],
  /** The Iberian peninsula. */
  iberia: ['ES', 'PT'],
  /** The United Kingdom and Ireland. */
  'uk-ie': ['GB', 'IE'],
  /** North America as the contract draws it: the three USMCA states. */
  'north-america': ['US', 'CA', 'MX'],
  /** Latin America: the Spanish- and Portuguese-speaking Americas. */
  latam: [
    'AR', 'BO', 'BR', 'CL', 'CO', 'CR', 'CU', 'DO', 'EC', 'GT',
    'HN', 'MX', 'NI', 'PA', 'PE', 'PR', 'PY', 'SV', 'UY', 'VE',
  ],
  /** Asia-Pacific: East, South and South-East Asia, Australasia, and the two larger Pacific states. */
  apac: [
    'AU', 'BD', 'BN', 'CN', 'FJ', 'HK', 'ID', 'IN', 'JP', 'KH', 'KR', 'LA', 'LK',
    'MM', 'MN', 'MO', 'MY', 'NP', 'NZ', 'PG', 'PH', 'PK', 'SG', 'TH', 'TW', 'VN',
  ],
  /** The Middle East: the peninsula, the Levant, Iraq, Iran, Türkiye and Egypt. */
  'middle-east': ['AE', 'BH', 'EG', 'IL', 'IQ', 'IR', 'JO', 'KW', 'LB', 'OM', 'PS', 'QA', 'SA', 'SY', 'TR', 'YE'],
  /** Africa: the 54 member states of the African Union. */
  africa: [
    'AO', 'BF', 'BI', 'BJ', 'BW', 'CD', 'CF', 'CG', 'CI', 'CM', 'CV', 'DJ', 'DZ', 'EG',
    'ER', 'ET', 'GA', 'GH', 'GM', 'GN', 'GQ', 'GW', 'KE', 'KM', 'LR', 'LS', 'LY', 'MA',
    'MG', 'ML', 'MR', 'MU', 'MW', 'MZ', 'NA', 'NE', 'NG', 'RW', 'SC', 'SD', 'SL', 'SN',
    'SO', 'SS', 'ST', 'SZ', 'TD', 'TG', 'TN', 'TZ', 'UG', 'ZA', 'ZM', 'ZW',
  ],
  /** The English-speaking six, exactly as the contract lists them. */
  english: ['US', 'GB', 'CA', 'AU', 'NZ', 'IE'],
};

/** The group names, in the order the help text and the refusals should list them. */
export const GROUP_NAMES = Object.keys(COUNTRY_GROUPS);

/**
 * Every ISO-3166-1 alpha-2 code. All 249 of them, and nothing else.
 *
 * COPIED FROM `sponsoredtokens-site/src/lib/countries.ts`, whose `COUNTRIES` table is the original;
 * `tests/audience.test.ts` asserts the count so a divergence shows up as a failure rather than as a
 * sponsor being refused a country the site's picker offered them. It is a copy for the same reason
 * `COUNTRY_GROUPS` is: this package publishes to npm alone and cannot import from the site.
 *
 * `T1` (Tor's exit-node pseudo-country) and `XX` ("we could not tell") are absent BY CONSTRUCTION —
 * neither is in the standard, so validating against this list refuses them without a special case,
 * and refuses `ZZ` and every other invented pair by the same rule and with the same sentence.
 */
export const ISO_COUNTRY_CODES: ReadonlySet<string> = new Set([
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT',
  'AU', 'AW', 'AX', 'AZ', 'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI',
  'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY',
  'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
  'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM',
  'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK',
  'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL',
  'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
  'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR',
  'IS', 'IT', 'JE', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN',
  'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS',
  'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
  'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW',
  'MX', 'MY', 'MZ', 'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP',
  'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM',
  'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM',
  'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF',
  'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW',
  'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
  'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
]);

/** How many countries there are. A local audience naming all of them is a global sponsorship. */
export const ISO_COUNTRY_COUNT = ISO_COUNTRY_CODES.size;

/** A real country, by the list above. Upper-case input only — the caller has already folded case. */
export const isCountryCode = (value: string): boolean => ISO_COUNTRY_CODES.has(value);

/** True when `codes` leaves no country out. The one set that is sold as `global` rather than local. */
export const coversEveryCountry = (codes: readonly string[]): boolean => {
  const seen = new Set(codes);
  for (const code of ISO_COUNTRY_CODES) if (!seen.has(code)) return false;
  return true;
};
