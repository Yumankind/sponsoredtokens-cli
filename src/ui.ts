/**
 * Colour, the wordmark, the spinner and money — every decision about how this CLI LOOKS, in one
 * pure file so all of it is testable without a terminal.
 *
 * ── WHY THE DETECTION IS A FUNCTION OF A PROBE, NOT OF `process` ────────────────────────────────
 *
 * `colorLevel` takes `{ env, isTTY, platform }` rather than reading the globals, because the two
 * bugs worth catching here are both invisible on the developer's machine: "we emitted escape codes
 * into a pipe" and "we printed nothing pretty on a terminal that could have done truecolour". Both
 * are one assertion about a plain object, and neither can be reproduced by running the CLI.
 *
 * ── WHICH STREAM'S TTY-NESS DECIDES ─────────────────────────────────────────────────────────────
 *
 * The rule is "colour only when the stream we are writing to is a terminal", which is why there are
 * two builders: `outInk()` for the two commands that print to stdout (`status`, `--help`) and
 * `errInk()` for everything else, which goes to stderr (see `index.ts`'s header for why). A single
 * stdout-based check would strip the colour off every launch banner the moment somebody ran
 * `sponsoredtokens claude -p … | jq`, even though their stderr is still a terminal — and would
 * paint escape codes into that `jq` if the streams were the other way round.
 *
 * ── ORDER OF PRECEDENCE, AND THE ONE ARGUABLE CALL ──────────────────────────────────────────────
 *
 *   1. `FORCE_COLOR=0`     → off. An explicit zero is a request.
 *   2. `NO_COLOR` non-empty → off, EVEN with `FORCE_COLOR` set. Both set is a contradiction, and
 *      the answer that never corrupts a log file is the plain one. (no-color.org's rule is
 *      "present and not empty", so `NO_COLOR=` means nothing.)
 *   3. `TERM=dumb`         → off. The terminal has told us it cannot; arguing is not an option.
 *   4. `FORCE_COLOR` set   → on, whether or not we are a TTY. This is how CI gets colour.
 *   5. a TTY               → on.
 *   6. otherwise           → off.
 *
 * Windows 10+ renders ANSI in conhost and Windows Terminal, so it is DETECTED and never enabled:
 * calling `SetConsoleMode` ourselves would mean a native addon or a `powershell` spawn, which is a
 * dependency and a subprocess for a paint job.
 */

/** 0 none · 1 bold only · 2 the 256-colour cube · 3 truecolour. */
export type ColorLevel = 0 | 1 | 2 | 3;

export interface ColorProbe {
  env: NodeJS.ProcessEnv;
  /** Is the stream we are about to write to a terminal? */
  isTTY: boolean;
  platform?: NodeJS.Platform;
}

/** The brand orange, `#D97757` (PLAN §11), and its nearest neighbour in the 256-colour cube. */
const ACCENT_RGB = '38;2;217;119;87';
const ACCENT_256 = '38;5;209';
/** A grey that is legible on paper white and on ink black, which `2m` (dim) is not everywhere. */
const MUTED_256 = '38;5;245';

export function colorLevel(probe: ColorProbe): ColorLevel {
  const env = probe.env;
  const force = env.FORCE_COLOR;

  if (force === '0' || force === 'false') return 0;
  if (typeof env.NO_COLOR === 'string' && env.NO_COLOR !== '') return 0;
  if (env.TERM === 'dumb') return 0;

  const forced = force !== undefined;
  if (!forced && !probe.isTTY) return 0;

  // An explicit level, for a CI that knows what its log viewer renders.
  if (force === '3') return 3;
  if (force === '2') return 2;
  if (force === '1') return 1;

  const colorterm = env.COLORTERM ?? '';
  if (/truecolor|24bit/i.test(colorterm)) return 3;
  // Windows Terminal does truecolour and advertises nothing; conhost on Win10+ does ANSI but sets
  // no TERM at all, so the TERM-shaped derivation below would wrongly land on plain bold.
  if (env.WT_SESSION) return 3;
  if ((probe.platform ?? process.platform) === 'win32') return 2;

  // Everything else that is a terminal at all gets bold, which every VT since 1978 renders.
  return /256(color)?/i.test(env.TERM ?? '') ? 2 : 1;
}

/**
 * The palette, already resolved to the level.
 *
 * Every helper closes with a FULL reset (`\u001b[0m`) and therefore MUST NOT be nested — `bold(accent(x))`
 * would end the bold at the inner reset and leave the rest of the line bold-less. Compose by
 * concatenating styled fragments instead, which is what every caller in this package does.
 */
export interface Ink {
  level: ColorLevel;
  /** The orange. The slash in the wordmark, and every amount of money. */
  accent(text: string): string;
  /** Labels, versions, separators — present but not competing with the numbers. */
  muted(text: string): string;
  /** A value worth reading: bold, never bright-white (invisible on a light terminal). */
  strong(text: string): string;
  /** The login code and the key id: the two strings a person retypes. */
  code(text: string): string;
  /** A URL. Underlined, because most terminals turn that into something clickable. */
  link(text: string): string;
}

function wrapper(codes: string | null): (text: string) => string {
  if (codes === null) return (text) => text;
  return (text) => `\u001b[${codes}m${text}\u001b[0m`;
}

export function inkFor(level: ColorLevel): Ink {
  if (level === 0) {
    const plain = wrapper(null);
    return { level, accent: plain, muted: plain, strong: plain, code: plain, link: plain };
  }
  const accentCodes = level === 3 ? ACCENT_RGB : level === 2 ? ACCENT_256 : '1';
  const mutedCodes = level >= 2 ? MUTED_256 : '2';
  return {
    level,
    accent: wrapper(accentCodes),
    muted: wrapper(mutedCodes),
    strong: wrapper('1'),
    code: wrapper(level >= 2 ? `1;${accentCodes}` : '1'),
    link: wrapper('4'),
  };
}

export function ink(probe: ColorProbe): Ink {
  return inkFor(colorLevel(probe));
}

/** No colour at all — the default for anything that has not been told which stream it is on. */
export function plainInk(): Ink {
  return inkFor(0);
}

export function errInk(env: NodeJS.ProcessEnv = process.env): Ink {
  return ink({ env, isTTY: process.stderr.isTTY === true });
}

export function outInk(env: NodeJS.ProcessEnv = process.env): Ink {
  return ink({ env, isTTY: process.stdout.isTTY === true });
}

// ── The wordmark ──────────────────────────────────────────────────────────────────────────────

/**
 * `sponsored/tokens`, slash in the accent, version muted — the site's wordmark (PLAN §11) spelled
 * in the one typeface a terminal has.
 */
export function banner(version: string, style: Ink): string {
  return `  ${style.strong('sponsored')}${style.accent('/')}${style.strong('tokens')}  ${style.muted(version)}`;
}

// ── Aligned blocks ────────────────────────────────────────────────────────────────────────────

/** The label column shared by the pool block and `status`. Wide enough for `Referral`. */
export const LABEL_WIDTH = 10;

/**
 * `  Pool      $1,624.50 left …`
 *
 * The padding happens BEFORE the colouring, always: pad a string that already carries escape codes
 * and the invisible bytes count towards the width, which is the classic way an aligned block stops
 * being aligned the moment colour is turned on.
 */
export function row(label: string, value: string, style: Ink, width = LABEL_WIDTH): string {
  return `  ${style.muted(label.padEnd(width))}${value}`;
}

// ── Money ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Integer cents → `$1,624.50`, `$3,262`, `$0`.
 *
 * Cents only when there are cents: a leaderboard of `$482.00 · $315.00 · $227.50` is three numbers
 * of noise carrying one number of information. Grouping is done by hand rather than with
 * `Intl.NumberFormat` so the output cannot change with the ICU build the binary was compiled
 * against — a small-icu Node would otherwise format this differently from the Bun binary.
 */
export function money(cents: number): string {
  if (!Number.isFinite(cents)) return '$0';
  const rounded = Math.round(cents);
  const abs = Math.abs(rounded);
  const whole = Math.trunc(abs / 100);
  const rest = abs % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const tail = rest === 0 ? '' : `.${String(rest).padStart(2, '0')}`;
  return `${rounded < 0 ? '-' : ''}$${grouped}${tail}`;
}

// ── The spinner ───────────────────────────────────────────────────────────────────────────────

/** Braille cycles in place and reads as motion at 80 ms; the ASCII four are for a legacy console. */
export const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
export const ASCII_FRAMES = ['-', '\\', '|', '/'] as const;

/**
 * Braille everywhere except a Windows console we have no evidence is modern: the raster fonts
 * conhost still ships with draw U+280x as a replacement box, and a column of boxes is worse than a
 * spinning slash.
 */
export function spinnerFrames(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): readonly string[] {
  const legacyWindows = platform === 'win32' && !env.WT_SESSION && !env.TERM_PROGRAM && !env.TERM;
  return legacyWindows ? ASCII_FRAMES : BRAILLE_FRAMES;
}

/** Just enough of a stream to be faked in a test. */
export interface SpinnerStream {
  write(chunk: string): unknown;
  isTTY?: boolean | undefined;
}

export interface SpinnerOptions {
  frames?: readonly string[];
  intervalMs?: number;
  style?: Ink;
}

export interface Spinner {
  start(): void;
  /** Draw the next frame. Called by the interval; called directly by the tests. */
  tick(): void;
  /** Erase the line and stop. Safe to call twice, and safe to call after a non-TTY start. */
  stop(): void;
}

/** Erase from the cursor to the end of the line — the only escape a spinner strictly needs. */
const CLEAR_LINE = '\r\u001b[K';

/**
 * A one-line spinner that never leaves anything behind.
 *
 * On a non-TTY it degrades to ONE line and then silence: a log file, a CI transcript or a `2>&1`
 * pipe must not collect three hundred carriage returns, and the dots this replaced did exactly
 * that. The timer is `unref`'d so a spinner somebody forgot to stop can never be the reason this
 * process refuses to exit.
 */
export function createSpinner(stream: SpinnerStream, label: string, options: SpinnerOptions = {}): Spinner {
  const frames = options.frames ?? BRAILLE_FRAMES;
  const intervalMs = options.intervalMs ?? 80;
  const style = options.style ?? plainInk();
  const tty = stream.isTTY === true;
  let timer: ReturnType<typeof setInterval> | null = null;
  let index = 0;
  // Whether there is a line on screen to erase. `stop()` is called twice on the happy path — once
  // where the answer arrives and once in the caller's `finally` — and a second erase would leave a
  // stray carriage return under the last thing printed.
  let drawn = false;

  const draw = (): void => {
    const frame = frames[index % frames.length] ?? '';
    index += 1;
    drawn = true;
    stream.write(`${CLEAR_LINE}  ${style.accent(frame)} ${style.muted(label)}`);
  };

  return {
    start(): void {
      if (!tty) {
        stream.write(`  ${label}\n`);
        return;
      }
      draw();
      timer = setInterval(draw, intervalMs);
      timer.unref?.();
    },
    tick(): void {
      if (tty) draw();
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (!drawn) return;
      drawn = false;
      stream.write(CLEAR_LINE);
    },
  };
}

// ── "Try: …" ──────────────────────────────────────────────────────────────────────────────────

/** The harnesses worth suggesting, most likely first. */
export const SUGGESTED_HARNESSES = ['claude', 'codex', 'opencode'] as const;

/**
 * Which harness to name in the `Try:` line.
 *
 * The one they already have installed, because a first command that ends in "not on your PATH" is
 * a worse first impression than any amount of colour can repair. `claude` when we cannot tell.
 */
export function suggestHarness(isInstalled: (bin: string) => boolean, candidates: readonly string[] = SUGGESTED_HARNESSES): string {
  for (const id of candidates) {
    try {
      if (isInstalled(id)) return id;
    } catch {
      // A PATH lookup that throws is not a reason to fail a login.
    }
  }
  return candidates[0] ?? 'claude';
}
