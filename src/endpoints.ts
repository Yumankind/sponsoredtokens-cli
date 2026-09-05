/**
 * The four addresses, and the one place they may be overridden.
 *
 * The harnesses disagree about where a base URL stops, and that disagreement is the entire reason
 * the worker's path is `/api/v1` (see `worker/src/routes/sponsored-proxy.ts`):
 *
 *   Claude Code    ANTHROPIC_BASE_URL  = <site>/api        and appends `/v1/messages`
 *   Codex          base_url            = <site>/api/v1     and appends `/responses`
 *   OpenAI-shaped  OPENAI_BASE_URL     = <site>/api/v1     and appends `/chat/completions`
 *   OpenRouter     OPENROUTER_BASE_URL = <site>/api/v1     and appends `/chat/completions`
 *
 * `SPONSOREDTOKENS_BASE_URL` exists so a `wrangler dev` on localhost can be driven by the real CLI.
 * It is read once, here, and never again — a second reader is a second place to forget the trailing
 * slash.
 */

/** The production site. Everything else is derived from it. */
export const DEFAULT_SITE = 'https://sponsoredtokens.com';

export type Region = 'eu' | 'us';
export const REGIONS: readonly Region[] = ['eu', 'us'];

export interface Endpoints {
  /** `https://sponsoredtokens.com` — the site, the account page, the `/cli/auth` page. */
  site: string;
  /** `<site>/api` — the prefix of every worker route this CLI itself calls. Never regional. */
  api: string;
  /** `<site>/api/v1` — the global OpenAI / OpenRouter / Codex base. Never regional. */
  v1: string;
  /** The region a launch is pinned to, or null for the global pool. */
  region: Region | null;
  /**
   * What a HARNESS is given: `<site>/api` and `<site>/api/v1`, or `<site>/api/eu` and
   * `<site>/api/eu/v1` when pinned. A pinned request is served only by providers hosted in that
   * region (the worker's `sponsored/region.ts`); the CLI's own calls — the leaderboard, the
   * device login — stay on `api`, which has no regional form.
   */
  proxyApi: string;
  proxyV1: string;
}

/** `eu` or `us`, from a flag or `SPONSOREDTOKENS_REGION`; anything else is null, and the caller says so. */
export function parseRegion(raw: string | null | undefined): Region | null {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'eu' || value === 'us' ? value : null;
}

/** Strip any trailing slashes so `${site}/api` never becomes `//api`. */
function normalizeSite(raw: string): string {
  return raw.replace(/\/+$/, '');
}

export function endpoints(env: NodeJS.ProcessEnv = process.env, region: Region | null = parseRegion(env.SPONSOREDTOKENS_REGION)): Endpoints {
  const site = normalizeSite(env.SPONSOREDTOKENS_BASE_URL || DEFAULT_SITE);
  const proxyApi = region ? `${site}/api/${region}` : `${site}/api`;
  return { site, api: `${site}/api`, v1: `${site}/api/v1`, region, proxyApi, proxyV1: `${proxyApi}/v1` };
}
