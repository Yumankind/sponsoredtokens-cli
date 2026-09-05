/**
 * Argument parsing, and the one genuinely awkward decision in this CLI.
 *
 * Every launch command is `sponsoredtokens <harness> [the harness's own arguments…]`, so OUR flags
 * and THEIRS share one argv and there is no separator either side has agreed to. Three rules, and
 * the third is the escape hatch that makes the first two safe:
 *
 *   1. Flags BEFORE the command word are always ours.
 *   2. For a harness command, `--paid`, `--model`, `--yes`, `--quiet` are also recognized AFTER it —
 *      because
 *      `sponsoredtokens claude --paid` is what a person will actually type, and refusing it in
 *      favour of `sponsoredtokens --paid claude` would be a rule nobody remembers. A harness that
 *      has its own `--model` therefore loses it to us, which is the right way round: choosing the
 *      model is this CLI's whole job, and a `sponsored/` id the harness picked for itself would be
 *      billed to a pool that never agreed to it.
 *   3. `--` ends our parsing. Everything after it is forwarded verbatim, `--model` included. That is
 *      the answer to every "but I need to pass that flag through".
 *
 * `run` is the exception to rule 2: `sponsoredtokens run npm test --yes` is a command the user
 * composed, and swallowing a flag out of the middle of it would be a bug we could not explain. So
 * for `run`, parsing stops at the command word.
 */
import { VERSION } from './version.ts';
import { banner, plainInk, type Ink } from './ui.ts';

export interface ParsedArgs {
  /** `login` | `logout` | `status` | a harness id | `run` | null when nothing was given. */
  command: string | null;
  /** Arguments to forward to the harness, verbatim. */
  rest: string[];
  /** Drop the `sponsored/` prefix: spend the caller's own credits instead of the pool. */
  paid: boolean;
  /** Override the model id. Prefixed for us by `harnesses.ts` unless `--paid`. */
  model: string | null;
  /** Do not ask before installing a missing harness. */
  yes: boolean;
  /** Skip the pool block and the model note before a launch: output only the harness's own. */
  quiet: boolean;
  help: boolean;
  version: boolean;
  /** A usage error, phrased for a terminal. `null` when the argv is fine. */
  error: string | null;
}

const EMPTY: ParsedArgs = {
  command: null,
  rest: [],
  paid: false,
  model: null,
  yes: false,
  quiet: false,
  help: false,
  version: false,
  error: null,
};

/** Commands whose remaining arguments belong to a program the USER named, not to a harness we know. */
const VERBATIM_COMMANDS = new Set(['run']);

/**
 * Consume one of our flags at `argv[i]`, or report that this token is not ours.
 *
 * Returns the number of tokens consumed (0 = not ours), and mutates `out`. Handling `--model=x` and
 * `--model x` in one place is the point: two call sites for the same flag is how the two spellings
 * drift apart.
 */
function takeFlag(argv: string[], i: number, out: ParsedArgs): number {
  const token = argv[i];
  if (token === undefined) return 0;

  switch (token) {
    case '--paid':
      out.paid = true;
      return 1;
    case '--yes':
    case '-y':
      out.yes = true;
      return 1;
    case '--quiet':
    case '-q':
      out.quiet = true;
      return 1;
    case '--help':
    case '-h':
      out.help = true;
      return 1;
    case '--version':
    case '-V':
      out.version = true;
      return 1;
    case '--model': {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        out.error = '--model needs a model id, e.g. --model sponsored/anthropic/claude-sonnet-5';
        return 1;
      }
      out.model = value;
      return 2;
    }
    default:
      if (token.startsWith('--model=')) {
        const value = token.slice('--model='.length);
        if (!value) {
          out.error = '--model needs a model id, e.g. --model sponsored/anthropic/claude-sonnet-5';
          return 1;
        }
        out.model = value;
        return 1;
      }
      return 0;
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { ...EMPTY, rest: [] };

  // ── Before the command word: everything is ours, and an unknown flag is a typo worth naming.
  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === '--') {
      out.error = 'Nothing to run. Try `sponsoredtokens --help`.';
      return out;
    }
    const taken = takeFlag(argv, i, out);
    if (taken > 0) {
      if (out.error) return out;
      i += taken;
      continue;
    }
    if (token.startsWith('-')) {
      out.error = `Unknown option ${token}. Try \`sponsoredtokens --help\`.`;
      return out;
    }
    break;
  }

  if (i >= argv.length) return out; // flags only: `--help`, `--version`, or nothing at all.

  out.command = argv[i]!;
  const tail = argv.slice(i + 1);

  if (VERBATIM_COMMANDS.has(out.command)) {
    out.rest = tail;
    return out;
  }

  // ── After the command word: our three launch flags, until `--`.
  let j = 0;
  while (j < tail.length) {
    if (tail[j] === '--') {
      out.rest.push(...tail.slice(j + 1));
      return out;
    }
    const taken = takeFlag(tail, j, out);
    if (taken > 0) {
      if (out.error) return out;
      j += taken;
      continue;
    }
    out.rest.push(tail[j]!);
    j += 1;
  }
  return out;
}

export function helpText(harnessIds: readonly string[], style: Ink = plainInk()): string {
  const command = (text: string): string => style.code(text);
  const name = style.muted('sponsoredtokens');
  return `${banner(VERSION, style)}
  ${style.muted('run your coding agent on tokens somebody else paid for.')}

  ${name} ${command('login')}                 sign in and store your API key
  ${name} ${command('status')}                the pool, your budget, your tier, your model
  ${name} ${command('logout')}                forget the stored key

  ${name} ${command('<harness>')} [args…]     launch a harness against the pool
  ${name} ${command('run')} <cmd…>            export the variables and run anything

Harnesses: ${harnessIds.map((id) => style.strong(id)).join(', ')}

Options:
  ${command('--paid')}            spend your own credits instead of the pool (drops the sponsored/ prefix)
  ${command('--model <id>')}      override the model, with or without the sponsored/ prefix —
                    sponsored/ is added for you unless --paid. A 402 from the pool means
                    the model is above your tier: ${style.strong('--model anthropic/claude-haiku-4.5')}
  ${command('--yes, -y')}         install a missing harness without asking
  ${command('--quiet, -q')}       no pool block and no model note before the harness starts
  ${command('--')}                stop reading options; everything after is passed through
  ${command('--help, -h')}        this
  ${command('--version, -V')}     ${VERSION}

The model is chosen for your tier: the dearest one the pool will pay for, named before every launch.
Every task run through the pool ends with a line naming the sponsor who paid for it.
`;
}
