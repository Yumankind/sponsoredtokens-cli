/**
 * Finding a harness on PATH and running it, with `shell: false` on every platform.
 *
 * ── WHY NOT `shell: true` ───────────────────────────────────────────────────────────────────────
 *
 * Because the arguments are the user's and they are going to contain quotes, spaces, `$`, `&&` and
 * backticks — `sponsoredtokens claude -p "fix the bug in foo && bar"` is an ordinary thing to type.
 * With a shell in the middle, that prompt becomes two commands. `shell: false` hands the argv to the
 * OS as an array and there is nothing left to quote.
 *
 * ── THE WINDOWS PROBLEM, WHICH IS REAL AND NOT A STYLE CHOICE ───────────────────────────────────
 *
 * Every npm-installed CLI is a `.cmd` shim on Windows, and since the CVE-2024-27980 fix Node REFUSES
 * to `spawn` a `.cmd` without a shell — it throws `EINVAL`. So the only way to launch `claude` on
 * Windows is to run `cmd.exe /d /s /c "…"` ourselves, with `windowsVerbatimArguments: true` so Node
 * does not re-quote the command line we just built. That is what `spawnPlan` produces: still
 * `shell: false` to Node, still no shell interpreting the arguments on macOS or Linux, and on
 * Windows exactly one `cmd.exe` whose command line we wrote character by character.
 *
 * `cmd.exe` expands `%VAR%` inside double quotes and there is no escape for it — that is a
 * documented hole in `cmd.exe`, not in this code. An argument containing a literal `%FOO%` will be
 * substituted on Windows. Nothing short of not using `cmd.exe` fixes it, and not using `cmd.exe`
 * means not launching `.cmd` shims, which means not launching any npm-installed harness.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/** The default Windows executable extensions, when `PATHEXT` is not set. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

export interface ResolveOptions {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Injected so the resolver is testable without a filesystem. */
  exists?: (path: string) => boolean;
}

/**
 * The full path to `name` on PATH, or null.
 *
 * Windows needs the extension resolved HERE rather than left to the OS, because `spawnPlan` has to
 * know whether it ended up with a `.cmd` (which needs `cmd.exe`) or an `.exe` (which does not).
 */
export function resolveExecutable(name: string, opts: ResolveOptions): string | null {
  const exists = opts.exists ?? existsSync;
  const isWindows = opts.platform === 'win32';
  const extensions = isWindows ? [...(opts.env.PATHEXT ?? DEFAULT_PATHEXT).split(';').filter(Boolean), ''] : [''];

  // The separator and the PATH delimiter come from the TARGET platform, never from `node:path` —
  // that module reports the HOST's, so a Windows lookup unit-tested on a Mac would join with `/`
  // and quietly never match. The whole point of taking `platform` as a parameter is that this
  // function can be wrong on a machine that would never notice.
  const separator = isWindows ? '\\' : '/';
  const pathDelimiter = isWindows ? ';' : ':';

  // A name with a separator in it is a path, not something to look up.
  if (name.includes('/') || name.includes('\\')) {
    for (const ext of extensions) if (exists(`${name}${ext}`)) return `${name}${ext}`;
    return null;
  }

  const pathValue = opts.env.PATH ?? opts.env.Path ?? '';
  for (const dir of pathValue.split(pathDelimiter)) {
    if (!dir) continue;
    const prefix = dir.endsWith(separator) ? dir : `${dir}${separator}`;
    for (const ext of extensions) {
      const candidate = `${prefix}${name}${ext}`;
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export interface SpawnPlan {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/**
 * Quote one argument for a `cmd.exe` command line.
 *
 * Two escaping languages are in play. The C runtime parses `"` and `\"` back out of the command
 * line, so backslashes immediately before a quote (and at the end of the argument, where the closing
 * quote lands next to them) must be doubled — that is what the two replaces do, and they are the
 * only correct way to write `C:\path\` inside quotes. `cmd.exe` gets there first and eats
 * `& | < > ( ) ^`, but it does NOT do so inside a quoted string, and EVERY argument here is quoted
 * unconditionally — including ones that need no quoting — precisely so nothing is ever left outside
 * for `cmd` to interpret. `%` is the one exception, and it has no escape (see the file header).
 */
export function cmdQuote(arg: string): string {
  // Escape backslashes only where they precede a quote (CRT rule), then the quotes themselves.
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * How to actually spawn `file` with `args`, per platform.
 *
 * On win32 for a `.cmd`/`.bat`: `cmd.exe /d /s /c "<file> <args…>"`. `/d` skips AutoRun registry
 * commands (someone else's `cmd` customisation must not run inside our launch), `/s` tells cmd to
 * strip exactly the outer quote pair and take the rest literally, `/c` runs and exits.
 */
export function spawnPlan(platform: NodeJS.Platform, file: string, args: string[], env: NodeJS.ProcessEnv = process.env): SpawnPlan {
  const isBatch = platform === 'win32' && /\.(cmd|bat)$/i.test(file);
  if (!isBatch) return { file, args, windowsVerbatimArguments: false };

  const comspec = env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
  const line = [file, ...args].map(cmdQuote).join(' ');
  return { file: comspec, args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
}

/**
 * Run it, inherit stdio, and resolve with the code THIS process should exit with.
 *
 * A child killed by a signal has no exit code, and the shell convention for that is `128 + signum`
 * — a harness that segfaults or is Ctrl-C'd must not look to a script like it succeeded.
 */
export function runChild(file: string, args: string[], env: NodeJS.ProcessEnv, stdio: 'inherit' | 'ignore' = 'inherit'): Promise<number> {
  const plan = spawnPlan(process.platform, file, args, env);
  return new Promise((resolve, reject) => {
    const child = spawn(plan.file, plan.args, {
      stdio,
      shell: false,
      env,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (typeof code === 'number') return resolve(code);
      resolve(signal ? 128 + (SIGNALS[signal] ?? 0) : 1);
    });
  });
}

/** Just the signals a harness realistically dies from; anything else lands on 128. */
const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
