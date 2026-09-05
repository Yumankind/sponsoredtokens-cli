/**
 * Where the key lives, and who may read it.
 *
 * `~/.sponsoredtokens/config.json` at mode 0600, inside a directory at 0700 — the same shape `ssh`,
 * `gh` and `npm` use for the same reason. The mode is set with `mode:` on the OPEN, not with a
 * `chmod` afterwards: a chmod leaves a window in which the file exists world-readable, and on a
 * shared machine that window is the whole vulnerability. `writeFile` with a mode does not re-apply
 * the mode to a file that already exists, so an existing config is re-chmod'ed explicitly after the
 * write; on a fresh file that call is a no-op.
 *
 * Windows has no POSIX modes, so `%APPDATA%\sponsoredtokens\config.json` is protected by the fact
 * that `%APPDATA%` is already per-user. Passing a `mode` there is harmless and ignored.
 *
 * `SPONSOREDTOKENS_API_KEY` in the environment WINS over the file. CI has no browser to complete a
 * device flow in, so the env var is the only way to run this CLI from a pipeline — and a key handed
 * over explicitly should always beat one found on disk.
 */
import { mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { PLAN_TTL_MS, type CachedModelPlan, type ModelPlan } from './models.ts';

export interface StoredConfig {
  /** `sk-st-<keyId>.<secret>`. The only secret this program ever writes down. */
  token: string;
  /** The public half, so `status` and `logout` can say WHICH key without revealing it. */
  keyId: string;
  savedAt: string;
  /**
   * The tier-checked model choice, cached for an hour (`models.ts`).
   *
   * It lives HERE rather than in a second file because it is per-key: the plan is a function of the
   * account's tier, and a cache keyed to a config that a `logout` deletes can never be served to a
   * different account than the one it was fetched for.
   */
  models?: CachedModelPlan;
}

export interface ConfigLocation {
  dir: string;
  file: string;
}

/**
 * The config directory and file for a platform. Pure, so the Windows path is testable on a Mac.
 *
 * `%APPDATA%` is preferred on win32 but not required: a stripped-down environment (a service
 * account, a container) may not have it, and falling back to the home directory is better than
 * refusing to store anything.
 */
export function configLocation(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): ConfigLocation {
  const dir = platform === 'win32' && env.APPDATA ? join(env.APPDATA, 'sponsoredtokens') : join(home, '.sponsoredtokens');
  return { dir, file: join(dir, 'config.json') };
}

function here(): ConfigLocation {
  return configLocation(process.platform, process.env, homedir());
}

/** The stored config, or null when there is none or it is not readable as ours. */
export function readConfig(): StoredConfig | null {
  const { file } = here();
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredConfig>;
    if (typeof parsed.token !== 'string' || !parsed.token) return null;
    const config: StoredConfig = {
      token: parsed.token,
      keyId: typeof parsed.keyId === 'string' ? parsed.keyId : '',
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
    };
    if (parsed.models && typeof parsed.models === 'object') config.models = parsed.models;
    return config;
  } catch {
    // A corrupt config is a `login` away from fixed. Refusing to start over it would strand the user
    // with an error and no obvious next step.
    return null;
  }
}

export function writeConfig(config: StoredConfig): string {
  const { dir, file } = here();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // `writeFile`'s mode applies to a file it CREATES; an existing one keeps whatever it had.
  if (process.platform !== 'win32') chmodSync(file, 0o600);
  return file;
}

/** Returns true when there was something to remove. */
export function clearConfig(): boolean {
  const { file } = here();
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

export interface ResolvedKey {
  token: string;
  source: 'env' | 'file';
}

/** The key to use, and where it came from — the second half is what `status` prints. */
export function resolveKey(env: NodeJS.ProcessEnv = process.env): ResolvedKey | null {
  const fromEnv = env.SPONSOREDTOKENS_API_KEY;
  if (fromEnv) return { token: fromEnv, source: 'env' };
  const stored = readConfig();
  return stored ? { token: stored.token, source: 'file' } : null;
}

// ── The model cache ───────────────────────────────────────────────────────────────────────────

/**
 * Is a cached plan still worth believing?
 *
 * Pure and exported so the expiry is a test rather than a wait: an hour is the TTL, and a
 * `fetchedAt` in the FUTURE (a clock that moved, a config copied between machines) counts as stale
 * rather than as valid forever, which is the failure mode a naive `now - then < ttl` has.
 */
export function planIsFresh(fetchedAt: string, now: number, ttlMs: number = PLAN_TTL_MS): boolean {
  const at = Date.parse(fetchedAt);
  if (!Number.isFinite(at)) return false;
  const age = now - at;
  return age >= 0 && age < ttlMs;
}

/** The cached plan, or null when there is none, it is stale, or there is no config at all. */
export function readModelPlan(now: number = Date.now()): ModelPlan | null {
  const cached = readConfig()?.models;
  if (!cached || typeof cached.fetchedAt !== 'string' || !cached.plan) return null;
  return planIsFresh(cached.fetchedAt, now) ? cached.plan : null;
}

/**
 * Store the plan next to the key. A no-op when there is no config file.
 *
 * `SPONSOREDTOKENS_API_KEY` in CI has no file to write to, and CREATING one would put a cache — and
 * an implied key — on disk for a caller who deliberately passed their key in the environment. So
 * that case simply re-fetches, which costs one cached edge read per launch.
 */
export function writeModelPlan(plan: ModelPlan, now: Date = new Date()): void {
  const existing = readConfig();
  if (!existing) return;
  try {
    writeConfig({ ...existing, models: { plan, fetchedAt: now.toISOString() } });
  } catch {
    // A read-only home directory is not a reason to fail a launch.
  }
}
