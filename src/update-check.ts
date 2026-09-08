/**
 * "There is a newer one" — the whole of it, and every decision in it is a pure function below.
 *
 * ── WHAT THIS IS ALLOWED TO COST ────────────────────────────────────────────────────────────────
 *
 * One unauthenticated GET of `/cli/latest.json`, fired in PARALLEL with the command's own work, on a
 * 2 second budget, at most once every 24 hours per machine. It never delays a command, never
 * reorders its output, never sends the key, and is silent on every failure. A CLI that made somebody
 * wait to be told about a release would be worse than one that never told them.
 *
 * The 24 hour throttle is a stamp file next to the stored key. It is written on every check
 * INCLUDING a failed one: a laptop with no network must not retry on every launch all day, and the
 * cost of a missed day is that a notice arrives tomorrow.
 *
 * ── WHY THE NOTICE ONLY PRINTS ON THE DAY IT CHECKED ────────────────────────────────────────────
 *
 * The stamp remembers the last version seen, so the notice COULD be reprinted from disk on every
 * command until the user upgrades. That is how an update nag becomes something people learn to
 * ignore. So the line is printed only by the run that actually did the fetch — once a day at most —
 * and the remembered version is used for the quieter thing instead: `stok --version` says
 * `latest 0.4.1` beside the running one, where somebody who wants to know has gone to look.
 *
 * ── AND ONLY WHERE A HUMAN WILL READ IT ─────────────────────────────────────────────────────────
 *
 * stderr, after everything else, only on a TTY, never under `--quiet`, and only for the commands
 * that already talk to the pool. A script capturing this CLI's output must not find a line about
 * releases in it, which is the same rule the pool block is under (`index.ts`'s stdout/stderr note).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { USER_AGENT } from './api.ts';
import type { Endpoints } from './endpoints.ts';

/** How long a check is good for. */
export const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/** The whole budget for the request. Two seconds, in parallel with work that takes longer anyway. */
export const CHECK_TIMEOUT_MS = 2000;

/** The commands that already make a network call, so this one rides along with something. */
export const CHECKED_COMMANDS: ReadonlySet<string> = new Set(['login', 'status', 'run']);

// ── The document ──────────────────────────────────────────────────────────────────────────────

export interface LatestInstall {
  sh: string;
  ps1: string;
  npm: string;
}

export interface Latest {
  version: string;
  publishedAt: string;
  note: string;
  install: LatestInstall;
}

/**
 * The install commands as this CLI knows them, used when the document omits or mangles one.
 *
 * The file in R2 is the authority so a future release can change the one-liner without every
 * installed copy printing the old one forever. These are the floor under that, and they are the same
 * three strings `scripts/release.sh` writes.
 */
export const DEFAULT_INSTALL: LatestInstall = {
  sh: 'curl -fsSL https://sponsoredtokens.com/cli/install.sh | bash',
  ps1: 'irm https://sponsoredtokens.com/cli/install.ps1 | iex',
  npm: 'npm i -g sponsoredtokens',
};

/** A string field, or the fallback. Anything that is not a non-empty string is not a field. */
function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/**
 * `latest.json` → a `Latest`, or null.
 *
 * The version is the only required field, because it is the only one a decision is made on. A
 * document with a version and nothing else still produces a correct notice, using the defaults
 * above; a document with no version is not one.
 */
export function parseLatest(body: unknown): Latest | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  if (!/^\d+\.\d+\.\d+/.test(version)) return null;
  const install = (raw.install && typeof raw.install === 'object' ? raw.install : {}) as Record<string, unknown>;
  return {
    version,
    publishedAt: str(raw.publishedAt, ''),
    note: str(raw.note, ''),
    install: {
      sh: str(install.sh, DEFAULT_INSTALL.sh),
      ps1: str(install.ps1, DEFAULT_INSTALL.ps1),
      npm: str(install.npm, DEFAULT_INSTALL.npm),
    },
  };
}

// ── Semver, only as far as this needs it ──────────────────────────────────────────────────────

/**
 * `-1`, `0` or `1` for `a` against `b`.
 *
 * Numeric parts compared as NUMBERS, which is the whole reason this is not `a > b`: `0.10.0` sorts
 * before `0.9.0` as a string and after it as a version, and the day that matters is the day nobody
 * is told about the release. A prerelease (`0.5.0-rc.1`) is LOWER than the release it precedes, per
 * the spec; that is the only prerelease rule here, because the release script never writes one and a
 * hand-uploaded oddity should err towards saying nothing.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { parts: number[]; pre: string } => {
    const [core = '', ...rest] = v.trim().replace(/^v/, '').split('-');
    return { parts: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: rest.join('-') };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const l = left.parts[i] ?? 0;
    const r = right.parts[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1; // a release beats its own prerelease
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

// ── How this copy was installed ───────────────────────────────────────────────────────────────

/** Which one-liner updates THIS copy. */
export type InstallKind = 'sh' | 'ps1' | 'npm';

export interface InstallPaths {
  /** `process.execPath` — the compiled binary, or the `node` that is running `dist/cli.js`. */
  execPath: string;
  /** `process.argv[1]` — the script, when there is one. Null for a compiled binary. */
  scriptPath: string | null;
}

/** Compare paths the way the platform does: `/` either way, and case-insensitively on Windows. */
function normalizePath(path: string, platform: NodeJS.Platform): string {
  const slashed = path.replace(/\\/g, '/');
  return platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * Which install this is, from where the running code sits.
 *
 * The installer's directory is checked FIRST, because a `node_modules` anywhere in a home directory
 * path (somebody whose home is inside a checkout, which happens in containers) must not turn a
 * binary install into an `npm -g` suggestion. `npm` second, and anything else falls back to the
 * platform's installer one-liner: a copy somebody moved onto their PATH by hand is best updated the
 * way it was first obtained, and that is the curl or irm line.
 */
export function installKind(paths: InstallPaths, platform: NodeJS.Platform, home: string): InstallKind {
  const installer: InstallKind = platform === 'win32' ? 'ps1' : 'sh';
  const candidates = [paths.execPath, paths.scriptPath ?? ''].filter(Boolean).map((p) => normalizePath(p, platform));
  const binDir = `${normalizePath(join(home, '.sponsoredtokens', 'bin'), platform)}/`;
  if (candidates.some((p) => p.startsWith(binDir))) return installer;
  if (candidates.some((p) => p.split('/').includes('node_modules'))) return 'npm';
  return installer;
}

export function installCommand(kind: InstallKind, latest: Latest | null): string {
  const install = latest?.install ?? DEFAULT_INSTALL;
  return install[kind];
}

// ── The stamp ─────────────────────────────────────────────────────────────────────────────────

export interface UpdateStamp {
  /** ISO, the last time a check was ATTEMPTED. */
  checkedAt: string;
  /** The last version the pointer named, kept for `--version` between checks. */
  latest: string | null;
}

/** `<config dir>/update.json`. No secret in it, so no mode games; the directory is already 0700. */
export function stampPath(configDir: string): string {
  return join(configDir, 'update.json');
}

/**
 * Is a stamp still inside its day?
 *
 * A `checkedAt` in the FUTURE counts as stale rather than as valid forever — a clock that moved, or
 * a home directory copied between machines, must not silence this permanently.
 */
export function stampIsFresh(checkedAt: string, now: number, ttlMs: number = CHECK_TTL_MS): boolean {
  const at = Date.parse(checkedAt);
  if (!Number.isFinite(at)) return false;
  const age = now - at;
  return age >= 0 && age < ttlMs;
}

export function readStamp(configDir: string): UpdateStamp | null {
  try {
    const parsed = JSON.parse(readFileSync(stampPath(configDir), 'utf8')) as Partial<UpdateStamp>;
    if (typeof parsed.checkedAt !== 'string') return null;
    return { checkedAt: parsed.checkedAt, latest: typeof parsed.latest === 'string' ? parsed.latest : null };
  } catch {
    return null;
  }
}

export function writeStamp(configDir: string, stamp: UpdateStamp): void {
  try {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(stampPath(configDir), `${JSON.stringify(stamp, null, 2)}\n`);
  } catch {
    // A read-only home is not a reason to fail a launch. It costs one check per command instead.
  }
}

// ── The check ─────────────────────────────────────────────────────────────────────────────────

export function latestUrl(ep: Pick<Endpoints, 'site'>): string {
  return `${ep.site}/cli/latest.json`;
}

export interface CheckDeps {
  now: number;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
  ttlMs?: number;
  readStamp: () => UpdateStamp | null;
  writeStamp: (stamp: UpdateStamp) => void;
}

export interface CheckResult {
  /** The document, only when THIS run fetched it. The notice is printed off this and nothing else. */
  fetched: Latest | null;
  /** The newest version known at all, from this fetch or from the stamp. Null when nothing is known. */
  known: string | null;
}

/**
 * Fetch the pointer, unless the stamp says today is already done. Never throws.
 *
 * No key, no cookies, no credentials of any kind: this is a public object and an update check is not
 * a place to send an API key. The 2 s abort is the whole budget, and a request that misses it is a
 * check that did not happen rather than a command that waited.
 */
export async function checkForUpdate(url: string, deps: CheckDeps): Promise<CheckResult> {
  const previous = deps.readStamp();
  if (previous && stampIsFresh(previous.checkedAt, deps.now, deps.ttlMs ?? CHECK_TTL_MS)) {
    return { fetched: null, known: previous.latest };
  }
  const checkedAt = new Date(deps.now).toISOString();
  let latest: Latest | null = null;
  try {
    const res = await deps.fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(deps.timeoutMs ?? CHECK_TIMEOUT_MS),
    });
    if (res.ok) latest = parseLatest(await res.json());
  } catch {
    // Offline, a captive portal, DNS, the 2 s budget, a body that is not JSON. All of them mean the
    // same thing here, and that thing is silence.
  }
  // Stamped even when the fetch failed: one attempt a day, not one per command on a dead network.
  deps.writeStamp({ checkedAt, latest: latest?.version ?? previous?.latest ?? null });
  return { fetched: latest, known: latest?.version ?? previous?.latest ?? null };
}

// ── What gets printed ─────────────────────────────────────────────────────────────────────────

export interface NoticeGate {
  command: string | null;
  quiet: boolean;
  stderrIsTty: boolean;
}

/**
 * Is this run allowed to check at all?
 *
 * Answered BEFORE the request rather than before the print, so a piped or `--quiet` run costs no
 * request either. `run` and every harness id are launches; `login` and `status` print the same pool
 * block. Everything else — `logout`, `reset`, `sponsor`, `update` — either does no network at all or
 * is the user already dealing with this CLI's own plumbing.
 */
export function shouldCheck(gate: NoticeGate, isHarnessId: (id: string) => boolean): boolean {
  if (!gate.stderrIsTty || gate.quiet || !gate.command) return false;
  return CHECKED_COMMANDS.has(gate.command) || isHarnessId(gate.command);
}

/** `stok 0.4.1 is out, you have 0.4.0. Update: curl … | bash` */
export function noticeLine(latestVersion: string, current: string, command: string): string {
  return `stok ${latestVersion} is out, you have ${current}. Update: ${command}`;
}

/** The line, or null when there is nothing worth saying. */
export function updateNotice(result: CheckResult, current: string, kind: InstallKind): string | null {
  const latest = result.fetched;
  if (!latest || !isNewer(latest.version, current)) return null;
  return noticeLine(latest.version, current, installCommand(kind, latest));
}

/** What `--version` prints: the running one, and the newer one when the stamp knows of it. */
export function versionLine(current: string, known: string | null): string {
  return known && isNewer(known, current) ? `${current} latest ${known}` : current;
}

// ── `stok update` ─────────────────────────────────────────────────────────────────────────────

export interface UpdateSpawn {
  file: string;
  args: string[];
}

/**
 * How to run one of the three one-liners, or null when this machine cannot.
 *
 * Each of them is a pipeline or an npm shim, so each needs a shell — this is the one place in this
 * CLI where that is true, and it is safe here for the reason it is not safe in `exec.ts`: the string
 * being run is OURS, from `latest.json` or from the constants above, never anything a user typed.
 * A `ps1` command on Linux, or an `sh` one on Windows, returns null and the caller prints it for the
 * user to run themselves.
 */
export function updateSpawn(kind: InstallKind, command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): UpdateSpawn | null {
  if (platform === 'win32') {
    if (kind === 'ps1') return { file: 'powershell.exe', args: ['-NoProfile', '-Command', command] };
    if (kind === 'npm') return { file: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', command] };
    return null; // a curl|bash line on Windows is not something to run for somebody.
  }
  if (kind === 'ps1') return null;
  return { file: '/bin/sh', args: ['-c', command] };
}
