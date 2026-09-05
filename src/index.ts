/**
 * `sponsoredtokens` — the command implementations, and the only file here that is allowed side
 * effects. The executable itself is `cli.ts`, which does nothing but call `main`.
 *
 * Everything with a decision in it lives in a pure module (`args`, `harnesses`, `codex-config`,
 * `json-config`, `exec`'s planners) and is unit-tested without a filesystem or a network. This file
 * is the impure shell: it reads the config, applies a plan, and gets out of the way of the harness.
 *
 * ── WHAT GOES TO STDOUT AND WHAT GOES TO STDERR ─────────────────────────────────────────────────
 *
 * Only `status` and `--help` print to stdout, because only they are output somebody might pipe.
 * Every launch banner, every "installing…" line and every warning goes to STDERR — a harness run
 * with `-p` and piped into `jq` must not find our banner at the top of its JSON. This is the one
 * rule in this file that will break something if it is forgotten.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

import { parseArgs, helpText } from './args.ts';
import { VERSION } from './version.ts';
import { endpoints, type Endpoints } from './endpoints.ts';
import { clearConfig, readConfig, resolveKey, writeConfig, configLocation } from './config-file.ts';
import { fetchStatus, formatCents, pollDevice, startDevice } from './api.ts';
import { mergeCodexConfig } from './codex-config.ts';
import { mergeJsonConfig } from './json-config.ts';
import { resolveExecutable, runChild } from './exec.ts';
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

async function login(ep: Endpoints): Promise<number> {
  const started = await startDevice(ep);

  note('');
  note(`  Your code:  ${started.userCode}`);
  note(`  Open:       ${started.verifyUrl}`);
  note('');
  note('  Sign in there and approve the code. If you already have an API key, approving');
  note('  here replaces it — the old one stops working immediately.');
  note('');
  openBrowser(started.verifyUrl);

  const deadline = Date.now() + started.expiresIn * 1000;
  process.stderr.write('  Waiting');
  while (Date.now() < deadline) {
    await sleep(started.interval * 1000);
    process.stderr.write('.');
    const result = await pollDevice(ep, started.deviceCode);
    if (result.status === 'pending') continue;
    note('');
    if (result.status === 'expired') {
      note('  That login expired. Run `sponsoredtokens login` again.');
      return 1;
    }
    const file = writeConfig({ token: result.token, keyId: result.keyId, savedAt: new Date().toISOString() });
    note(`  Signed in. Key ${result.keyId} saved to ${file}.`);
    if (result.rotated) note('  Your previous key was replaced and no longer works.');
    note('');
    note('  Try:  sponsoredtokens claude');
    return 0;
  }
  note('');
  note('  That login expired. Run `sponsoredtokens login` again.');
  return 1;
}

// ── status ────────────────────────────────────────────────────────────────────────────────────

async function status(ep: Endpoints): Promise<number> {
  const key = resolveKey();
  if (!key) {
    note('Not signed in. Run `sponsoredtokens login`.');
    return 1;
  }
  const account = await fetchStatus(ep, key.token);

  // Read every field defensively: this endpoint belongs to the account API and may grow or rename.
  const budget = account.budget ?? {};
  const user = account.user ?? {};
  out('');
  if (typeof budget.remainingCents === 'number' && typeof budget.weeklyCents === 'number') {
    out(`  Weekly budget   ${formatCents(budget.remainingCents)} left of ${formatCents(budget.weeklyCents)}`);
  } else if (typeof budget.remainingCents === 'number') {
    out(`  Weekly budget   ${formatCents(budget.remainingCents)} left`);
  }
  if (budget.resetsAt) out(`  Resets          ${budget.resetsAt}`);
  if (user.tier !== undefined) out(`  Model tier      ${user.tier}`);
  if (user.referralLink) out(`  Referral link   ${user.referralLink}`);
  out(`  Key            ${key.source === 'env' ? 'from SPONSOREDTOKENS_API_KEY' : (readConfig()?.keyId ?? 'stored')}`);
  out('');
  return 0;
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

async function launch(plan: LaunchPlan, rest: string[], ep: Endpoints, yes: boolean, banner: string): Promise<number> {
  if (plan.unsupported) {
    note('');
    note(`  ${plan.unsupported.replace(/\n/g, '\n  ')}`);
    note('');
    return 1;
  }

  const binary = await locate(plan, yes);
  if (!binary) return 127; // the shell's own "command not found".

  if (!applyConfigs(plan, ep)) return 1;

  const env = childEnv(plan);
  for (const args of plan.preCommands) {
    const code = await runChild(binary, args, env, 'ignore');
    if (code !== 0) note(`  \`${plan.bin} ${args.slice(0, 2).join(' ')}\` exited ${code} — launching anyway.`);
  }

  note(banner);
  return runChild(binary, [...plan.args, ...rest], env);
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
    out(helpText(HARNESS_IDS));
    return parsed.help ? 0 : 1; // no arguments at all is a usage error, not a successful run.
  }

  const ep = endpoints();

  if (parsed.command === 'logout') {
    const { file } = configLocation(process.platform, process.env, homedir());
    note(clearConfig() ? `Removed ${file}. Your key on the server is unchanged — rotate it on the account page.` : 'Nothing stored; already signed out.');
    return 0;
  }
  if (parsed.command === 'login') return login(ep);
  if (parsed.command === 'status') return status(ep);

  // Everything below needs a key.
  const key = resolveKey();
  if (!key) {
    note('Not signed in. Run `sponsoredtokens login` first.');
    return 1;
  }

  const ctx: PlanContext = {
    key: key.token,
    endpoints: ep,
    model: resolveModel(DEFAULT_MODEL, parsed.model, parsed.paid),
    paid: parsed.paid,
    modelOverride: parsed.model,
  };

  if (parsed.command === 'run') {
    const [command, ...rest] = parsed.rest;
    if (!command) {
      note('`run` needs a command: sponsoredtokens run <cmd…>');
      return 2;
    }
    const plan = planForRun(ctx, command);
    return launch(plan, rest, ep, parsed.yes, `  sponsoredtokens · ${command} · ${parsed.paid ? 'your own credits' : 'the pool pays'}`);
  }

  if (!isHarness(parsed.command)) {
    note(`Unknown command \`${parsed.command}\`. Try \`sponsoredtokens --help\`.`);
    return 2;
  }
  const plan = planFor(parsed.command, ctx)!;
  return launch(
    plan,
    parsed.rest,
    ep,
    parsed.yes,
    `  sponsoredtokens · ${parsed.command} · ${plan.model} · ${parsed.paid ? 'your own credits' : 'the pool pays'}`,
  );
}
