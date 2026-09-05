/**
 * `sponsoredtokens` — the command implementations, and the only file here that is allowed side
 * effects. The executable itself is `cli.ts`, which does nothing but call `main`.
 *
 * Everything with a decision in it lives in a pure module (`args`, `harnesses`, `codex-config`,
 * `json-config`, `ui`, `pool`, `models`, `exec`'s planners) and is unit-tested without a filesystem
 * or a network. This file is the impure shell: it reads the config, applies a plan, and gets out of
 * the way of the harness.
 *
 * ── WHAT GOES TO STDOUT AND WHAT GOES TO STDERR ─────────────────────────────────────────────────
 *
 * Only `status`, `sponsor` and `--help` print to stdout, because only they are output somebody
 * might pipe. `sponsor --json` goes further and keeps stdout to exactly one object.
 * Every launch banner, every "installing…" line, the pool block and every warning goes to STDERR —
 * a harness run with `-p` and piped into `jq` must not find our banner at the top of its JSON. This
 * is the one rule in this file that will break something if it is forgotten. It is also why the
 * colour is built per stream (`errInk` / `outInk`, see `ui.ts`).
 *
 * ── THE THREE NETWORK CALLS THAT ARE ALLOWED TO FAIL ────────────────────────────────────────────
 *
 * The leaderboard, the recent sponsors and the model list are decoration and defaults, not the
 * command. Each has a timeout and each returns "nothing" rather than throwing, so an offline laptop
 * still logs in, still launches, and simply says less. `--quiet` skips the two decorative ones
 * entirely.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

import { parseArgs, helpText, type ParsedArgs } from './args.ts';
import { VERSION } from './version.ts';
import { endpoints, type Endpoints } from './endpoints.ts';
import { clearConfig, readConfig, readModelPlan, resolveKey, writeConfig, writeModelPlan, configLocation } from './config-file.ts';
import { createSponsorCheckout, fetchSponsorBoard, fetchStatus, pollDevice, startDevice } from './api.ts';
import { mergeCodexConfig } from './codex-config.ts';
import { mergeJsonConfig } from './json-config.ts';
import { providerPath, removeCodexProvider, removeJsonPath } from './reset.ts';
import { resolveExecutable, runChild } from './exec.ts';
import { banner, createSpinner, errInk, money, outInk, row, spinnerFrames, suggestHarness, type Ink } from './ui.ts';
import { boardLines, fetchBoard, EMPTY_BOARD, type Board } from './pool.ts';
import { encodeQr, qrColumns, qrLines } from './qr.ts';
import {
  TERMS_VERSION,
  checkoutBody,
  isRefusal,
  parseTarget,
  rankFor,
  rankLabel,
  resolveAmountCents,
  sponsorJson,
  type SponsorRefusal,
} from './sponsor.ts';
import { chooseModel, fetchModelPlan, unlockNote, type ModelChoice, type ModelPlan } from './models.ts';
import {
  DEFAULT_MODEL,
  HARNESS_IDS,
  isHarness,
  planFor,
  planForRun,
  resolveModel,
  type LaunchPlan,
  type PlanContext,
} from './harnesses.ts';

const out = (line = ''): void => void process.stdout.write(`${line}\n`);
const note = (line = ''): void => void process.stderr.write(`${line}\n`);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── The two soft reads ────────────────────────────────────────────────────────────────────────

/** The board, or an empty one — `--quiet` does not even ask. */
async function board(ep: Endpoints, quiet: boolean): Promise<Board> {
  return quiet ? EMPTY_BOARD : fetchBoard(ep);
}

/** Print the pool block with a blank line above it, when there is one. */
function printBoard(lines: string[], write: (line?: string) => void): void {
  if (lines.length === 0) return;
  write('');
  for (const line of lines) write(line);
}

/**
 * The model plan: the config-file cache first, the pool second, nothing third.
 *
 * The cache is what keeps a launch instant — an hour's worth of `sponsoredtokens claude` costs one
 * request in total (`config-file.ts`), and a tier only changes when a referral lands.
 */
async function modelPlan(ep: Endpoints, token: string): Promise<ModelPlan | null> {
  const cached = readModelPlan();
  if (cached) return cached;
  const fresh = await fetchModelPlan(ep, token);
  if (fresh) writeModelPlan(fresh);
  return fresh;
}

// ── login ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Open the browser, and do not care whether it worked.
 *
 * There is no reliable way to know: `open` exits 0 the instant it hands the URL to LaunchServices,
 * and on a headless box `xdg-open` may not exist at all. So the URL is ALWAYS printed first and the
 * browser is a convenience on top. Detached and with stdio ignored, or a graphical browser holding
 * the pipe open would keep this process alive after the login finished.
 */
function openBrowser(url: string): void {
  const [file, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(file, args as string[], { stdio: 'ignore', detached: true, shell: false });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Printed above. Nothing to say.
  }
}

/** Is this harness already on the PATH? Used only to name one in the `Try:` line. */
function installed(bin: string): boolean {
  return resolveExecutable(bin, { platform: process.platform, env: process.env }) !== null;
}

async function login(ep: Endpoints, quiet: boolean): Promise<number> {
  const style = errInk();
  const started = await startDevice(ep);

  note('');
  note(banner(VERSION, style));
  note('');
  note(`  ${style.muted('Your code:'.padEnd(12))}${style.code(started.userCode)}`);
  note(`  ${style.muted('Open:'.padEnd(12))}${style.link(started.verifyUrl)}`);
  note('');
  note('  Sign in there and approve the code. If you already have an API key, approving');
  note('  here replaces it — the old one stops working immediately.');
  note('');
  openBrowser(started.verifyUrl);

  // One line that animates on a terminal and is one printed sentence anywhere else — see `ui.ts`.
  const spinner = createSpinner(process.stderr, 'Waiting for approval…', {
    style,
    frames: spinnerFrames(process.env, process.platform),
  });
  spinner.start();

  const deadline = Date.now() + started.expiresIn * 1000;
  try {
    while (Date.now() < deadline) {
      await sleep(started.interval * 1000);
      const result = await pollDevice(ep, started.deviceCode);
      if (result.status === 'pending') continue;
      spinner.stop();
      if (result.status === 'expired') {
        note('  That login expired. Run `sponsoredtokens login` again.');
        return 1;
      }
      const file = writeConfig({ token: result.token, keyId: result.keyId, savedAt: new Date().toISOString() });
      note(`  Signed in. Key ${style.code(result.keyId)} saved to ${file}.`);
      if (result.rotated) note('  Your previous key was replaced and no longer works.');

      printBoard(boardLines(await board(ep, quiet), style), note);
      note('');
      note(`  Try:  ${style.code(`sponsoredtokens ${suggestHarness(installed)}`)}`);
      return 0;
    }
  } finally {
    // A throw from `pollDevice` must not leave a timer redrawing a line forever.
    spinner.stop();
  }
  note('  That login expired. Run `sponsoredtokens login` again.');
  return 1;
}

// ── status ────────────────────────────────────────────────────────────────────────────────────

async function status(ep: Endpoints, quiet: boolean): Promise<number> {
  const style = outInk();
  const key = resolveKey();
  if (!key) {
    note('Not signed in. Run `sponsoredtokens login`.');
    return 1;
  }

  // All three at once: the account read is the only one that can fail the command.
  const [account, poolBoard, plan] = await Promise.all([fetchStatus(ep, key.token), board(ep, quiet), modelPlan(ep, key.token)]);

  // Read every field defensively: this endpoint belongs to the account API and may grow or rename.
  const budget = account.budget ?? {};
  const user = account.user ?? {};

  out('');
  out(banner(VERSION, style));
  printBoard(boardLines(poolBoard, style), out);
  out('');

  if (typeof budget.remainingCents === 'number' && typeof budget.weeklyCents === 'number') {
    out(row('Budget', `${style.accent(money(budget.remainingCents))} left of ${style.strong(money(budget.weeklyCents))} this week`, style));
  } else if (typeof budget.remainingCents === 'number') {
    out(row('Budget', `${style.accent(money(budget.remainingCents))} left this week`, style));
  }
  if (budget.resetsAt) out(row('Resets', budget.resetsAt, style));

  const tier = plan ? plan.tier : user.tier;
  if (tier !== undefined) {
    const unlock = unlockNote(plan);
    out(row('Tier', `${style.strong(String(tier))}${unlock ? `${style.muted(' — ')}${unlock}` : ''}`, style));
  }
  // What a launch would pick right now, so the number above and the id below cannot disagree.
  out(row('Model', style.strong(resolveModel(chooseModel(plan, 'claude').model, null, false)), style));

  if (user.referralLink) out(row('Referral', style.link(user.referralLink), style));
  out(row('Key', style.code(key.source === 'env' ? 'from SPONSOREDTOKENS_API_KEY' : (readConfig()?.keyId ?? 'stored')), style));
  out('');
  return 0;
}

// ── sponsor ───────────────────────────────────────────────────────────────────────────────────

/**
 * `sponsoredtokens sponsor <url | @handle>` — the loop's other half.
 *
 * An agent that has been running on somebody else's money can put money back with one command. What
 * it gets is an ORDINARY Stripe Checkout link and a QR code of it, to hand to the human it works
 * for; the agent settles nothing. Hence the closing line, and hence `payer: 'operator'` in the JSON.
 *
 * ── NO KEY, AND A KEY ANYWAY ────────────────────────────────────────────────────────────────────
 *
 * `/api/sponsor/checkout` is public — sponsoring is not something an account does, and requiring a
 * login before somebody can give us money would be a strange place to put a wall. So this is the
 * one command below `login` that runs signed out. When a key IS present it is sent, so the
 * sponsorship can be attributed to the account that asked for it later.
 *
 * ── WHERE THE BYTES GO ──────────────────────────────────────────────────────────────────────────
 *
 * Without `--json` this is a report, so it prints to STDOUT like `status` does. With `--json`,
 * stdout carries exactly one object and everything else — the wordmark, the terms line, every
 * warning — moves to stderr, because the caller is a program that is about to run `JSON.parse` on
 * what it reads.
 */
async function sponsor(ep: Endpoints, parsed: ParsedArgs): Promise<number> {
  const write = parsed.json ? note : out;
  const style = parsed.json ? errInk() : outInk();

  const fail = (refusal: SponsorRefusal): number => {
    if (parsed.json) out(JSON.stringify({ error: refusal.message, code: refusal.code }));
    else note(`  ${refusal.message}`);
    return 1;
  };

  const target = parseTarget(parsed.rest[0], parsed.platform);
  if (isRefusal(target)) return fail(target);

  // The board decides the default amount, the minimum and the rank. Every refusal below happens
  // BEFORE anything is POSTed: a Checkout session that exists because of a typo is a row nobody
  // asked for.
  const board = await fetchSponsorBoard(ep);
  const amountCents = resolveAmountCents({ dollars: parsed.amount, board });
  if (isRefusal(amountCents)) return fail(amountCents);

  const key = resolveKey();
  const result = await createSponsorCheckout(ep, checkoutBody(target, amountCents), key?.token ?? null);
  if (isRefusal(result)) return fail(result);

  const rank = board ? rankFor(board, amountCents) : null;

  if (parsed.json) {
    out(JSON.stringify(sponsorJson(target, amountCents, rank, result)));
  } else {
    if (!parsed.quiet) {
      write('');
      write(banner(VERSION, style));
      write('');
    }
    write(row('Sponsor', style.strong(target.value), style));
    write(row('Amount', style.accent(money(result.amountCents)), style));
    if (rank) write(row('Rank', rankLabel(rank), style));
    write(row('Pay', style.link(result.checkoutUrl), style));
    if (!parsed.quiet) {
      // The pool's short link, when the worker gave one: ~40 bytes, a 33-column symbol that fits.
      printQr(result.shortUrl ?? result.checkoutUrl, style, write);
      write('');
      write('  Give this link to the person who pays. They accept the terms');
      write(`  (${style.link(`${ep.site}/terms`)}, version ${style.strong(TERMS_VERSION)}) on the Checkout page,`);
      write('  and the sponsorship goes live within seconds of the payment.');
      write('');
    }
  }

  // The same rule as `login`: a browser is a convenience on top of a link that has already been
  // printed, and there is nothing to open into on a machine with no terminal attached.
  if (parsed.open && (process.stdout.isTTY === true || process.stderr.isTTY === true)) openBrowser(result.checkoutUrl);
  return 0;
}

/**
 * The link as a QR code, or nothing at all.
 *
 * Three ways this draws nothing, and all three are the right answer rather than a failure:
 * the payload is past what the encoder holds; the terminal is too narrow for the symbol, which
 * would wrap it into an unreadable smear; or there is no colour, and a QR without guaranteed
 * black-on-white cannot be trusted to be dark-on-light in the reader's theme (`qr.ts`).
 *
 * A live Stripe link needs 85 columns, which is why the worker also hands back a short `/p/<code>`
 * link to the same page: ~40 bytes, 33 columns, drawn here in preference. `qr.ts` has the numbers.
 */
function printQr(url: string, style: Ink, write: (line?: string) => void): void {
  if (style.level === 0) return;
  let qr;
  try {
    qr = encodeQr(url);
  } catch {
    return;
  }
  if (qrColumns(qr) > (process.stdout.columns ?? 80)) return;
  write('');
  for (const line of qrLines(qr)) write(line);
}

// ── launching a harness ───────────────────────────────────────────────────────────────────────

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function readIfExists(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Write the plan's config blocks. False means "stop, do not launch".
 *
 * A file we cannot parse is never rewritten (see `json-config.ts`); the user is handed the block and
 * the path instead. Launching anyway would run the harness against whatever provider it had before,
 * which is exactly the silent wrong answer this CLI exists to avoid.
 */
/**
 * `reset [harness]`: the inverse of `applyConfigs` and of OpenClaw's `config set`, for one harness
 * or for all of them. Nothing else to undo: the variables a launch exports die with the child, so
 * `claude`, `cursor`, `hermes`, `junie` and `t3` run plainly were never on the pool. The stored key
 * is `logout`'s business and is left alone here, on purpose — resetting a harness is not signing out.
 */
async function reset(ep: Endpoints, only: string | null): Promise<number> {
  if (only !== null && !isHarness(only)) {
    note(`  \`${only}\` is not a harness this CLI knows. One of: ${HARNESS_IDS.join(', ')}.`);
    return 1;
  }
  const ctx: PlanContext = { key: '', endpoints: ep, model: 'sponsored/x/y', paid: false, modelOverride: null };
  let removed = 0;
  let envOnly: string[] = [];
  for (const id of only ? [only] : HARNESS_IDS) {
    const plan = planFor(id, ctx);
    if (!plan) continue;
    if (plan.configs.length === 0 && plan.preCommands.length === 0) {
      envOnly.push(id);
      continue;
    }
    for (const config of plan.configs) {
      const file = join(homedir(), ...config.segments);
      const existing = readIfExists(file);
      if (existing === null) continue;
      if (config.format === 'codex-toml') {
        const edit = removeCodexProvider(existing);
        if (!edit.changed) continue;
        writeFileSync(file, edit.content);
        note(`  Removed the sponsoredtokens provider from ${config.label}.`);
        removed += 1;
        continue;
      }
      const path = providerPath(config.patch ?? {});
      const result = path ? removeJsonPath(existing, path) : { kind: 'unchanged' as const };
      if (result.kind === 'unparseable') {
        note(`  ${config.label} could not be parsed as JSON, so it was left alone. Remove the "sponsoredtokens" provider from it yourself.`);
        continue;
      }
      if (result.kind === 'unchanged') continue;
      writeFileSync(file, result.content);
      note(`  Removed the sponsoredtokens provider from ${config.label}.`);
      removed += 1;
    }
    // OpenClaw wrote its provider with its own `config set`; its own `config unset` takes it out.
    for (const args of plan.preCommands) {
      if (args[0] !== 'config' || args[1] !== 'set' || !args[2]) continue;
      const binary = resolveExecutable(plan.bin, { platform: process.platform, env: process.env });
      if (!binary) continue;
      const code = await runChild(binary, ['config', 'unset', args[2]], process.env, 'ignore');
      if (code === 0) {
        note(`  Removed ${args[2]} from ${plan.bin}'s config.`);
        removed += 1;
      }
    }
  }
  if (removed === 0) note(only ? `  Nothing of ours in ${only}'s config.` : '  Nothing of ours in any harness config.');
  if (envOnly.length > 0 && only !== null) {
    note(`  ${only} keeps nothing on disk: the pool's variables live only in the launched process. Run \`${only}\` plainly and it is on its own settings.`);
  } else if (envOnly.length > 0) {
    note(`  ${envOnly.join(', ')} keep nothing on disk: run them plainly and they are on their own settings.`);
  }
  note('  Your stored key is untouched; `sponsoredtokens logout` forgets it.');
  return 0;
}

function applyConfigs(plan: LaunchPlan, ep: Endpoints): boolean {
  for (const config of plan.configs) {
    const file = join(homedir(), ...config.segments);
    const existing = readIfExists(file);

    if (config.format === 'codex-toml') {
      const merged = mergeCodexConfig(existing ?? '', ep.v1);
      if (!merged.changed) continue;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, merged.content);
      note(`  Added the sponsoredtokens provider to ${config.label}.`);
      continue;
    }

    const result = mergeJsonConfig(existing, config.patch ?? {});
    if (result.kind === 'unparseable') {
      note(`  ${config.label} could not be parsed as JSON, so it was left alone.`);
      note('  Add this to it yourself and run the command again:');
      note('');
      note(JSON.stringify(config.patch, null, 2));
      note('');
      return false;
    }
    if (result.kind === 'unchanged') continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, result.content);
    note(`  Added the sponsoredtokens provider to ${config.label}.`);
  }
  return true;
}

/** The child's environment: ours on top of the parent's, minus the ones we take away. */
function childEnv(plan: LaunchPlan): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...plan.env };
  for (const name of plan.unset) delete env[name];
  return env;
}

/**
 * Locate the harness, offering to install it when it is missing.
 *
 * An `npm` install may be run for the user after a yes; a `curl … | bash` installer never is, at
 * any prompt, with any flag. Piping a stranger's script into a shell is a decision a person makes
 * for themselves — a CLI that makes it for them, even with consent gathered in one keystroke, is
 * teaching a habit worth more than the convenience.
 */
async function locate(plan: LaunchPlan, yes: boolean): Promise<string | null> {
  const found = resolveExecutable(plan.bin, { platform: process.platform, env: process.env });
  if (found) return found;

  if (!plan.install) {
    note(`  \`${plan.bin}\` is not on your PATH.`);
    return null;
  }
  note(`  \`${plan.bin}\` is not installed. Install it with:`);
  note('');
  note(`      ${plan.install.command}`);
  note('');
  if (plan.install.note) note(`  ${plan.install.note}`);

  if (plan.install.kind === 'script') return null;
  if (!yes && !(await confirm('  Run that now?'))) return null;

  const npm = resolveExecutable('npm', { platform: process.platform, env: process.env });
  if (!npm) {
    note('  npm is not on your PATH either — install Node.js first.');
    return null;
  }
  const pkg = plan.install.command.split(/\s+/).slice(3); // after `npm install -g`
  const code = await runChild(npm, ['install', '-g', ...pkg], process.env);
  if (code !== 0) {
    note(`  That install exited ${code}.`);
    return null;
  }
  return resolveExecutable(plan.bin, { platform: process.platform, env: process.env });
}

interface LaunchOptions {
  yes: boolean;
  quiet: boolean;
  /** The one line naming what is about to run. Already styled. */
  banner: string;
  /** Why this model, when we chose it. Null under `--model`, `--paid` and `--quiet`. */
  modelNote: string | null;
}

/**
 * The block printed immediately before `exec`, and the last thing this CLI says.
 *
 * It is fetched HERE rather than in `main` so that a launch which stops early — an unsupported
 * harness, a missing binary, an unparseable config — never pays for a network call or prints a
 * leaderboard above its own error.
 */
async function launch(plan: LaunchPlan, rest: string[], ep: Endpoints, options: LaunchOptions): Promise<number> {
  const style = errInk();
  if (plan.unsupported) {
    note('');
    note(`  ${plan.unsupported.replace(/\n/g, '\n  ')}`);
    note('');
    return 1;
  }

  const binary = await locate(plan, options.yes);
  if (!binary) return 127; // the shell's own "command not found".

  if (!applyConfigs(plan, ep)) return 1;

  const env = childEnv(plan);
  for (const args of plan.preCommands) {
    const code = await runChild(binary, args, env, 'ignore');
    if (code !== 0) note(`  \`${plan.bin} ${args.slice(0, 2).join(' ')}\` exited ${code} — launching anyway.`);
  }

  if (!options.quiet) {
    printBoard(boardLines(await fetchBoard(ep), style), note);
    if (options.modelNote) note(row('Model', style.muted(options.modelNote), style));
    note('');
  }
  note(options.banner);
  return runChild(binary, [...plan.args, ...rest], env);
}

/** `  sponsoredtokens · claude · sponsored/… · the pool pays` — identical text without colour. */
function launchBanner(style: Ink, parts: string[]): string {
  const dot = style.muted(' · ');
  const [first, ...others] = parts;
  return `  ${style.strong('sponsored')}${style.accent('/')}${style.strong('tokens')}${dot}${style.strong(first ?? '')}${others
    .map((part) => `${dot}${style.muted(part)}`)
    .join('')}`;
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    note(parsed.error);
    return 2;
  }
  if (parsed.version) {
    out(VERSION);
    return 0;
  }
  if (parsed.help || !parsed.command) {
    out(helpText(HARNESS_IDS, outInk()));
    return parsed.help ? 0 : 1; // no arguments at all is a usage error, not a successful run.
  }

  const ep = endpoints();

  if (parsed.command === 'logout') {
    const { file } = configLocation(process.platform, process.env, homedir());
    note(clearConfig() ? `Removed ${file}. Your key on the server is unchanged — rotate it on the account page.` : 'Nothing stored; already signed out.');
    return 0;
  }
  if (parsed.command === 'reset') return reset(ep, parsed.rest[0] ?? null);
  if (parsed.command === 'login') return login(ep, parsed.quiet);
  if (parsed.command === 'status') return status(ep, parsed.quiet);
  // Sponsoring the pool needs no key: the endpoint is public (see `sponsor` above).
  if (parsed.command === 'sponsor') return sponsor(ep, parsed);

  // Everything below needs a key.
  const key = resolveKey();
  if (!key) {
    note('Not signed in. Run `sponsoredtokens login` first.');
    return 1;
  }

  /**
   * The tier-checked default, and the two cases that skip the lookup entirely.
   *
   * `--paid` means the caller's own credits pay, and a tier is a limit on what the POOL will pay
   * for; `--model` means they have already answered the question. Both cases keep the old constants
   * and cost no request.
   */
  const chosen: ModelChoice | null = parsed.paid || parsed.model ? null : chooseModel(await modelPlan(ep, key.token), parsed.command);

  const ctx: PlanContext = {
    key: key.token,
    endpoints: ep,
    model: resolveModel(chosen?.model ?? DEFAULT_MODEL, parsed.model, parsed.paid),
    paid: parsed.paid,
    modelOverride: parsed.model,
    tierModel: chosen?.model ?? null,
    tierSmallModel: chosen?.small ?? null,
  };
  const style = errInk();
  const payer = parsed.paid ? 'your own credits' : 'the pool pays';

  if (parsed.command === 'run') {
    const [command, ...rest] = parsed.rest;
    if (!command) {
      note('`run` needs a command: sponsoredtokens run <cmd…>');
      return 2;
    }
    return launch(planForRun(ctx, command), rest, ep, {
      yes: parsed.yes,
      quiet: parsed.quiet,
      banner: launchBanner(style, [command, payer]),
      modelNote: chosen?.reason ?? null,
    });
  }

  if (!isHarness(parsed.command)) {
    note(`Unknown command \`${parsed.command}\`. Try \`sponsoredtokens --help\`.`);
    return 2;
  }
  const plan = planFor(parsed.command, ctx)!;
  return launch(plan, parsed.rest, ep, {
    yes: parsed.yes,
    quiet: parsed.quiet,
    banner: launchBanner(style, [parsed.command, plan.model, payer]),
    modelNote: chosen?.reason ?? null,
  });
}
