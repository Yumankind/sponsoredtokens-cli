/**
 * Argument parsing — the three rules from `src/args.ts`, and the ways they could eat a flag that
 * was never ours.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.ts';

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
