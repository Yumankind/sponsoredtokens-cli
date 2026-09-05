/**
 * The three lines about the pool, and the two public reads behind them.
 *
 *   Pool      $1,624.50 left of $3,262 sponsored · 13 sponsors
 *   Top       Northwind Labs $482 · Ferrite $315 · Papertrail Books $227.50
 *   Recent    Kestrel Analytics $280 · Northwind Labs $1,200 · Muswell Coffee $90
 *
 * `GET /api/leaderboard?sort=remaining` and `GET /api/sponsors/recent?limit=3`, both unauthenticated
 * and both edge-cached for 30 s, so this costs the worker nothing per launch.
 *
 * ── THIS FILE MUST NEVER BE THE REASON A COMMAND FAILS ──────────────────────────────────────────
 *
 * It is decoration on top of a login and a launch. So: a 3 s timeout on each call, the two calls
 * independent (a dead `recent` still leaves us a `Pool` and a `Top` line), every error swallowed,
 * and a board we could not read renders as NOTHING — no "board unavailable" line, because a person
 * launching a harness did not ask about the board and does not need our apology for it.
 *
 * ── WHY THE NAMES ARE SCRUBBED ──────────────────────────────────────────────────────────────────
 *
 * `displayName` is a string a stranger on the internet typed into a checkout form and it is about to
 * be written to a terminal. A name containing `\x1b]0;…\x07` would retitle the user's window; one
 * containing `\r` would overwrite the line above it. So every name loses its control characters and
 * is truncated before it is printed. The worker screens sponsors, but "the server validated it" is
 * not a thing a terminal writer gets to assume.
 *
 * ── WHAT "RECENT" SHOWS ─────────────────────────────────────────────────────────────────────────
 *
 * `lifetimeCents` — everything that sponsor has ever put in. The public shape has no per-payment
 * amount (`/api/sponsors/recent` returns sponsor rows ordered by `last_recharge_at`), so the honest
 * number available is the total they have paid, and that is the one printed.
 */
import { USER_AGENT } from './api.ts';
import type { Endpoints } from './endpoints.ts';
import { money, row, type Ink } from './ui.ts';

/** How many names fit on one terminal line without wrapping on an 80-column window. */
const SHOWN = 3;

/** A name longer than this is a paragraph, not a name. */
const MAX_NAME = 28;

export interface PoolSponsor {
  displayName: string;
  balanceCents: number;
  lifetimeCents: number;
}

export interface Board {
  /** Null when `/api/leaderboard` could not be read. */
  pool: { balanceCents: number; lifetimeCents: number; activeCount: number } | null;
  /** By remaining balance, already trimmed to what we print. */
  top: PoolSponsor[];
  /** By last payment. */
  recent: PoolSponsor[];
}

export const EMPTY_BOARD: Board = { pool: null, top: [], recent: [] };

// ── Parsing ───────────────────────────────────────────────────────────────────────────────────

function cents(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

/** Control characters out, whitespace collapsed, length capped. See the header. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const flat = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > MAX_NAME ? `${flat.slice(0, MAX_NAME - 1)}…` : flat;
}

function sponsors(raw: unknown, limit: number): PoolSponsor[] {
  if (!Array.isArray(raw)) return [];
  const out: PoolSponsor[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const displayName = cleanName(record.displayName);
    if (!displayName) continue;
    out.push({ displayName, balanceCents: cents(record.balanceCents), lifetimeCents: cents(record.lifetimeCents) });
    if (out.length === limit) break;
  }
  return out;
}

/** The two bodies → a board. Pure, so every line below is a fixture test. */
export function parseBoard(leaderboard: unknown, recent: unknown): Board {
  const board: Board = { pool: null, top: [], recent: [] };

  if (typeof leaderboard === 'object' && leaderboard !== null) {
    const record = leaderboard as Record<string, unknown>;
    const pool = record.pool;
    if (typeof pool === 'object' && pool !== null) {
      const p = pool as Record<string, unknown>;
      board.pool = { balanceCents: cents(p.balanceCents), lifetimeCents: cents(p.lifetimeCents), activeCount: cents(p.activeCount) };
    }
    board.top = sponsors(record.sponsors, SHOWN);
  }
  if (typeof recent === 'object' && recent !== null) {
    board.recent = sponsors((recent as Record<string, unknown>).sponsors, SHOWN);
  }
  return board;
}

// ── Fetching ──────────────────────────────────────────────────────────────────────────────────

export interface FetchOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

async function readJson(url: string, timeoutMs: number, doFetch: typeof fetch): Promise<unknown> {
  try {
    const res = await doFetch(url, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // Offline, captive portal, DNS, a 3 s timeout. All of them mean "no board", none of them mean
    // "stop what you were doing".
    return null;
  }
}

/** Both public reads, in parallel, each allowed to fail on its own. */
export async function fetchBoard(ep: Endpoints, options: FetchOptions = {}): Promise<Board> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const doFetch = options.fetchImpl ?? fetch;
  const [leaderboard, recent] = await Promise.all([
    readJson(`${ep.api}/leaderboard?sort=remaining`, timeoutMs, doFetch),
    readJson(`${ep.api}/sponsors/recent?limit=${SHOWN}`, timeoutMs, doFetch),
  ]);
  return parseBoard(leaderboard, recent);
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────

function list(entries: PoolSponsor[], amount: (sponsor: PoolSponsor) => number, style: Ink): string {
  return entries.map((sponsor) => `${sponsor.displayName} ${style.accent(money(amount(sponsor)))}`).join(style.muted(' · '));
}

/**
 * The block, one string per line, ready to print. Empty when there is nothing true to say.
 *
 * The three lines are independent on purpose: `Top` and `Recent` are omitted when their fetch
 * failed rather than rendered empty, so a line that IS printed is always a line that is accurate.
 */
export function boardLines(board: Board, style: Ink): string[] {
  const lines: string[] = [];
  const pool = board.pool;

  if (pool) {
    if (pool.lifetimeCents <= 0 && pool.balanceCents <= 0) {
      lines.push(row('Pool', `${style.accent('$0')} left — nobody has sponsored yet`, style));
    } else {
      const sponsorCount = pool.activeCount === 1 ? '1 sponsor' : `${pool.activeCount} sponsors`;
      lines.push(
        row(
          'Pool',
          `${style.accent(money(pool.balanceCents))} left of ${style.strong(money(pool.lifetimeCents))} sponsored${style.muted(' · ')}${sponsorCount}`,
          style,
        ),
      );
    }
  }
  if (board.top.length > 0) lines.push(row('Top', list(board.top, (s) => s.balanceCents, style), style));
  if (board.recent.length > 0) lines.push(row('Recent', list(board.recent, (s) => s.lifetimeCents, style), style));
  return lines;
}
