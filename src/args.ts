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
import { banner, money, plainInk, type Ink } from './ui.ts';
import { GROUP_NAMES } from './countries.ts';
import { MIN_GLOBAL_CENTS, MIN_LOCAL_CENTS } from './sponsor.ts';

export interface ParsedArgs {
  /** `login` | `logout` | `status` | a harness id | `run` | null when nothing was given. */
  command: string | null;
  /** Arguments to forward to the harness, verbatim. */
  rest: string[];
  /** Drop the `sponsored/` prefix: spend the caller's own credits instead of the pool. */
  paid: boolean;
  /** Override the model id. Prefixed for us by `harnesses.ts` unless `--paid`. */
  model: string | null;
  /** `--region eu|us`: pin the launch to providers hosted in one region. Null is the global pool. */
  region: string | null;
  /** Do not ask before installing a missing harness. */
  yes: boolean;
  /** Skip the pool block and the model note before a launch: output only the harness's own. */
  quiet: boolean;
  help: boolean;
  version: boolean;
  /** `sponsor --amount`, in whole dollars. Null means "take the pool's suggestion". */
  amount: number | null;
  /** `sponsor --platform`, for a bare `@handle`. Validated in `sponsor.ts`, not here. */
  platform: string | null;
  /** `sponsor --audience`, raw: `global`, or a comma list of codes and group names. Validated in `sponsor.ts`. */
  audience: string | null;
  /** `sponsor --json`: one object on stdout and nothing else. */
  json: boolean;
  /** False under `--no-open`: print the link and leave the browser alone. */
  open: boolean;
  /** A usage error, phrased for a terminal. `null` when the argv is fine. */
  error: string | null;
}

const EMPTY: ParsedArgs = {
  command: null,
  rest: [],
  paid: false,
  model: null,
  region: null,
  yes: false,
  quiet: false,
  help: false,
  version: false,
  amount: null,
  platform: null,
  audience: null,
  json: false,
  open: true,
  error: null,
};

/** Commands whose remaining arguments belong to a program the USER named, not to a harness we know. */
const VERBATIM_COMMANDS = new Set(['run']);

/** The command whose five extra flags are recognised after the command word. See `takeFlag`. */
const SPONSOR_COMMAND = 'sponsor';

/**
 * Consume one of our flags at `argv[i]`, or report that this token is not ours.
 *
 * Returns the number of tokens consumed (0 = not ours), and mutates `out`. Handling `--model=x` and
 * `--model x` in one place is the point: two call sites for the same flag is how the two spellings
 * drift apart.
 *
 * `sponsorFlags` is false after a HARNESS name, and that is deliberate rather than tidy. `--json`
 * and `--amount` belong to `sponsor` alone; recognising them everywhere would quietly swallow a
 * `--json` that Codex or a `run` command meant for itself, and rule 3 (`--`) would be the only way
 * to get it back. Before the command word, and after `sponsor`, they are ours; after `claude`, they
 * are the harness's.
 */
function takeFlag(argv: string[], i: number, out: ParsedArgs, sponsorFlags: boolean): number {
  const token = argv[i];
  if (token === undefined) return 0;

  if (sponsorFlags) {
    switch (token) {
      case '--json':
        out.json = true;
        return 1;
      case '--no-open':
        out.open = false;
        return 1;
      case '--amount': {
        const value = argv[i + 1];
        if (value === undefined || !/^\d+$/.test(value)) {
          out.error = '--amount needs a whole number of dollars, e.g. --amount 50';
          return 1;
        }
        out.amount = Number(value);
        return 2;
      }
      case '--platform': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('-')) {
          out.error = '--platform needs a platform id, e.g. --platform github';
          return 1;
        }
        out.platform = value;
        return 2;
      }
      case '--audience': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('-')) {
          out.error = '--audience needs global or a country list, e.g. --audience PT,ES';
          return 1;
        }
        out.audience = value;
        return 2;
      }
      default:
        if (token.startsWith('--amount=')) {
          const value = token.slice('--amount='.length);
          if (!/^\d+$/.test(value)) {
            out.error = '--amount needs a whole number of dollars, e.g. --amount 50';
            return 1;
          }
          out.amount = Number(value);
          return 1;
        }
        if (token.startsWith('--platform=')) {
          const value = token.slice('--platform='.length);
          if (!value) {
            out.error = '--platform needs a platform id, e.g. --platform github';
            return 1;
          }
          out.platform = value;
          return 1;
        }
        if (token.startsWith('--audience=')) {
          const value = token.slice('--audience='.length);
          if (!value) {
            out.error = '--audience needs global or a country list, e.g. --audience PT,ES';
            return 1;
          }
          out.audience = value;
          return 1;
        }
    }
  }

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
        out.error = '--model needs a model id, e.g. --model sponsored/anthropic/claude-haiku-4.5';
        return 1;
      }
      out.model = value;
      return 2;
    }
    case '--region': {
      const value = argv[i + 1];
      if (value === undefined || !/^(eu|us)$/i.test(value)) {
        out.error = '--region needs eu or us, e.g. --region eu';
        return 1;
      }
      out.region = value.toLowerCase();
      return 2;
    }
    default:
      if (token.startsWith('--model=')) {
        const value = token.slice('--model='.length);
        if (!value) {
          out.error = '--model needs a model id, e.g. --model sponsored/anthropic/claude-haiku-4.5';
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
    const taken = takeFlag(argv, i, out, true);
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

  // ── After the command word: our launch flags, until `--`; `sponsor`'s five as well, for it.
  const sponsorFlags = out.command === SPONSOR_COMMAND;
  let j = 0;
  while (j < tail.length) {
    if (tail[j] === '--') {
      out.rest.push(...tail.slice(j + 1));
      return out;
    }
    const taken = takeFlag(tail, j, out, sponsorFlags);
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
  ${name} ${command('reset')} [harness]       take the pool out of a harness's own config files

  ${name} ${command('<harness>')} [args…]     launch a harness against the pool
  ${name} ${command('run')} <cmd…>            export the variables and run anything

  ${name} ${command('sponsor')} <target>      put money in: a payment link for whoever pays

Harnesses: ${harnessIds.map((id) => style.strong(id)).join(', ')}

Options:
  ${command('--paid')}            spend your own credits instead of the pool (drops the sponsored/ prefix)
  ${command('--model <id>')}      override the model, with or without the sponsored/ prefix —
                    sponsored/ is added for you unless --paid. A 402 from the pool means
                    the model is above your tier: ${style.strong('--model anthropic/claude-haiku-4.5')}
  ${command('--region <eu|us>')}  serve this launch only from providers hosted in that region
                    (the base URL gains the region: …/api/eu/v1). Some models exist in one region only
  ${command('--yes, -y')}         install a missing harness without asking
  ${command('--quiet, -q')}       no pool block and no model note before the harness starts
  ${command('--')}                stop reading options; everything after is passed through
  ${command('--help, -h')}        this
  ${command('--version, -V')}     ${VERSION}

sponsor: ${command('sponsoredtokens sponsor <url | @handle>')}
  ${command('--amount <n>')}      whole dollars. Default: the amount that takes #1 on your board today
  ${command('--audience <a>')}    ${style.strong('global')} (the default, every board, ${money(MIN_GLOBAL_CENTS)} minimum), or the countries
                    you want to be seen in: ${style.strong('--audience PT,ES')} — those local boards
                    only, and ${money(MIN_LOCAL_CENTS)} for each (PT,ES is ${money(MIN_LOCAL_CENTS * 2)}). Groups count as
                    countries and mix with them:
                    ${GROUP_NAMES.slice(0, 7).join(', ')},
                    ${GROUP_NAMES.slice(7).join(', ')}
                    Any number of countries; naming every one of them is a
                    global sponsorship, at the global minimum, and it says so
  ${command('--platform <id>')}   for a bare @handle — x, github, youtube, tiktok, bluesky.
                    X when not given
  ${command('--json')}            one object on stdout, nothing else. For an agent
  ${command('--no-open')}         print the link and the QR code; do not open a browser

  No key is needed. The link is an ordinary Stripe Checkout page: give it to the person who
  pays. They accept the terms (${style.link('https://sponsoredtokens.com/terms')}) there, and the
  sponsorship goes live within seconds of the payment.

The model is chosen for your tier: the dearest one the pool will pay for, named before every launch.
Every task run through the pool ends with a line naming the sponsor who paid for it.
`;
}
