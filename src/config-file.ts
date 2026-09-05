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

export interface StoredConfig {
  /** `sk-st-<keyId>.<secret>`. The only secret this program ever writes down. */
  token: string;
  /** The public half, so `status` and `logout` can say WHICH key without revealing it. */
  keyId: string;
  savedAt: string;
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
    return { token: parsed.token, keyId: typeof parsed.keyId === 'string' ? parsed.keyId : '', savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '' };
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
