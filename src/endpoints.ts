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

export interface Endpoints {
  /** `https://sponsoredtokens.com` — the site, the account page, the `/cli/auth` page. */
  site: string;
  /** `<site>/api` — Claude Code's base, and the prefix of every worker route. */
  api: string;
  /** `<site>/api/v1` — the OpenAI / OpenRouter / Codex base. */
  v1: string;
}

/** Strip any trailing slashes so `${site}/api` never becomes `//api`. */
function normalizeSite(raw: string): string {
  return raw.replace(/\/+$/, '');
}

export function endpoints(env: NodeJS.ProcessEnv = process.env): Endpoints {
  const site = normalizeSite(env.SPONSOREDTOKENS_BASE_URL || DEFAULT_SITE);
  return { site, api: `${site}/api`, v1: `${site}/api/v1` };
}
