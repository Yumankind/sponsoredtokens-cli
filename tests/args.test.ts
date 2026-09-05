/**
 * Argument parsing — the three rules from `src/args.ts`, and the ways they could eat a flag that
 * was never ours.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, helpText } from '../src/args.ts';

test('nothing at all is not an error, just no command', () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.command, null);
  assert.equal(parsed.error, null);
});

test('flags before the command are ours', () => {
  const parsed = parseArgs(['--paid', '--model', 'openai/gpt-5.1', 'claude', '-p', 'hi']);
  assert.equal(parsed.command, 'claude');
  assert.equal(parsed.paid, true);
  assert.equal(parsed.model, 'openai/gpt-5.1');
  assert.deepEqual(parsed.rest, ['-p', 'hi']);
});

test('flags after a harness command are ours too — that is what people type', () => {
  const parsed = parseArgs(['claude', '-p', 'hi', '--paid', '--model=x/y', '-y']);
  assert.equal(parsed.command, 'claude');
  assert.equal(parsed.paid, true);
  assert.equal(parsed.yes, true);
  assert.equal(parsed.model, 'x/y');
  assert.deepEqual(parsed.rest, ['-p', 'hi']);
});

test('`--` stops us reading and forwards the rest verbatim, `--model` included', () => {
  const parsed = parseArgs(['claude', '--', '--model', 'their/own', '--paid']);
  assert.equal(parsed.paid, false);
  assert.equal(parsed.model, null);
  assert.deepEqual(parsed.rest, ['--model', 'their/own', '--paid']);
});

test('`run` hands the whole tail over untouched — the user composed that command', () => {
  const parsed = parseArgs(['run', 'npm', 'test', '--yes', '--paid']);
  assert.equal(parsed.command, 'run');
  assert.equal(parsed.yes, false, 'a --yes inside the user’s own command is theirs');
  assert.equal(parsed.paid, false);
  assert.deepEqual(parsed.rest, ['npm', 'test', '--yes', '--paid']);
});

test('`--paid` before `run` still reaches us', () => {
  const parsed = parseArgs(['--paid', 'run', 'npm', 'test']);
  assert.equal(parsed.paid, true);
  assert.deepEqual(parsed.rest, ['npm', 'test']);
});

test('--model without a value is a named error, not a silent null', () => {
  assert.match(parseArgs(['--model']).error ?? '', /--model needs a model id/);
  assert.match(parseArgs(['--model', '--paid']).error ?? '', /--model needs a model id/);
  assert.match(parseArgs(['--model=']).error ?? '', /--model needs a model id/);
});

test('an unknown option before the command is a typo worth naming', () => {
  assert.match(parseArgs(['--pad', 'claude']).error ?? '', /Unknown option --pad/);
});

test('an unknown option AFTER the command belongs to the harness', () => {
  const parsed = parseArgs(['claude', '--dangerously-skip-permissions']);
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.rest, ['--dangerously-skip-permissions']);
});

test('help and version are recognised on their own', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--version']).version, true);
  assert.equal(parseArgs(['-V']).version, true);
});

// ── sponsor's five flags ──────────────────────────────────────────────────────────────────────

test('sponsor takes its target and its five flags, in either spelling', () => {
  const spaced = parseArgs(['sponsor', 'acme.com', '--amount', '50', '--platform', 'github', '--audience', 'PT,ES', '--json', '--no-open']);
  assert.equal(spaced.command, 'sponsor');
  assert.deepEqual(spaced.rest, ['acme.com']);
  assert.equal(spaced.amount, 50);
  assert.equal(spaced.platform, 'github');
  assert.equal(spaced.audience, 'PT,ES');
  assert.equal(spaced.json, true);
  assert.equal(spaced.open, false);

  const equals = parseArgs(['sponsor', '--amount=50', '--platform=github', '--audience=dach', '@acme']);
  assert.deepEqual(equals.rest, ['@acme']);
  assert.equal(equals.amount, 50);
  assert.equal(equals.platform, 'github');
  assert.equal(equals.audience, 'dach');
});

/**
 * The VALUE is not checked here — `sponsor.ts`'s `parseAudience` owns that, the way it owns the
 * platform id. What `args.ts` owes the caller is a flag that was given nothing at all.
 */
test('--audience without a value is a named error, and the value is passed on untouched', () => {
  assert.match(parseArgs(['sponsor', 'acme.com', '--audience']).error ?? '', /--audience needs global or a country list/);
  assert.match(parseArgs(['sponsor', 'acme.com', '--audience', '--json']).error ?? '', /--audience needs global or a country list/);
  assert.match(parseArgs(['sponsor', 'acme.com', '--audience=']).error ?? '', /--audience needs global or a country list/);
  assert.equal(parseArgs(['sponsor', 'acme.com', '--audience', 'nonsense']).audience, 'nonsense');
  assert.equal(parseArgs(['sponsor', 'acme.com']).audience, null, 'nothing given is global, decided in sponsor.ts');
});

test('the browser opens unless it is told not to', () => {
  assert.equal(parseArgs(['sponsor', 'acme.com']).open, true);
  assert.equal(parseArgs(['sponsor', 'acme.com', '--no-open']).open, false);
});

test('--amount takes whole dollars and says so when it is given anything else', () => {
  assert.match(parseArgs(['sponsor', 'acme.com', '--amount']).error ?? '', /whole number of dollars/);
  assert.match(parseArgs(['sponsor', 'acme.com', '--amount', '12.5']).error ?? '', /whole number of dollars/);
  assert.match(parseArgs(['sponsor', 'acme.com', '--amount', '-5']).error ?? '', /whole number of dollars/);
  assert.match(parseArgs(['sponsor', 'acme.com', '--amount=']).error ?? '', /whole number of dollars/);
});

test('--platform without a value is a named error', () => {
  assert.match(parseArgs(['sponsor', '@acme', '--platform']).error ?? '', /--platform needs a platform id/);
  assert.match(parseArgs(['sponsor', '@acme', '--platform', '--json']).error ?? '', /--platform needs a platform id/);
});

/**
 * The reason `takeFlag` takes a `sponsorFlags` argument at all: after a HARNESS name these four are
 * the harness's, and a CLI that swallowed `--json` out of `codex --json` would be a bug reachable
 * only through `--`.
 */
test('sponsor’s flags are not taken off a harness or off a run command', () => {
  const harness = parseArgs(['codex', '--json', '--amount', '50', '--audience', 'PT', '--no-open']);
  assert.equal(harness.json, false);
  assert.equal(harness.amount, null);
  assert.equal(harness.audience, null);
  assert.deepEqual(harness.rest, ['--json', '--amount', '50', '--audience', 'PT', '--no-open']);

  const command = parseArgs(['run', 'npm', 'test', '--json']);
  assert.equal(command.json, false);
  assert.deepEqual(command.rest, ['npm', 'test', '--json']);
});

test('before the command word they are still ours, like every other flag', () => {
  const parsed = parseArgs(['--json', '--no-open', 'sponsor', 'acme.com']);
  assert.equal(parsed.command, 'sponsor');
  assert.equal(parsed.json, true);
  assert.equal(parsed.open, false);
});

test('--quiet works on sponsor the way it works everywhere else', () => {
  assert.equal(parseArgs(['sponsor', 'acme.com', '--quiet']).quiet, true);
  assert.equal(parseArgs(['-q', 'sponsor', 'acme.com']).quiet, true);
});

test('the help text names sponsor and what the link is for', () => {
  const help = helpText(['claude', 'codex']);
  assert.match(help, /sponsor <target>/);
  assert.match(help, /--amount <n>/);
  assert.match(help, /--platform <id>/);
  assert.match(help, /--no-open/);
  assert.match(help, /give it to the person who\n {2}pays/);
});

test('the help text documents --audience: the default, both prices and the groups', () => {
  const help = helpText(['claude', 'codex']);
  assert.match(help, /--audience <a>/);
  assert.match(help, /--audience PT,ES/);
  assert.match(help, /\$10 minimum/, 'the flat global price');
  assert.match(help, /\$10 for each/, 'and that a local one is priced per country');
  assert.match(help, /PT,ES is \$20/, 'with the arithmetic shown once');
  assert.match(help, /Any number of countries/, 'that there is no ceiling');
  assert.match(help, /naming every one of them is a\n\s+global sponsorship/, 'and the one set that is not local');
  for (const group of ['eu', 'eea', 'dach', 'nordics', 'iberia', 'uk-ie', 'north-america', 'latam', 'apac', 'middle-east', 'africa', 'english']) {
    assert.ok(help.includes(group), `the help text should name the ${group} group`);
  }
});

test('--region takes eu or us and nothing else', () => {
  assert.equal(parseArgs(['--region', 'eu', 'claude']).region, 'eu');
  assert.equal(parseArgs(['claude', '--region', 'US']).region, 'us');
  assert.match(parseArgs(['--region', 'moon', 'claude']).error ?? '', /eu or us/);
  assert.equal(parseArgs(['claude']).region, null);
});
