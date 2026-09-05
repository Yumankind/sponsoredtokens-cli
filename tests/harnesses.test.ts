/**
 * The per-harness wiring, asserted variable name by variable name.
 *
 * These are the assertions that catch the failure this CLI is most likely to actually have: a
 * variable spelled the way the plan said rather than the way the harness's docs say. Every
 * expectation below was read off the harness's own documentation on 2026-09-05 and the source of
 * that reading is in `src/harnesses.ts`'s per-entry comments — so when one of these fails, the
 * question to ask is "did the harness change?", not "is the test wrong?".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpoints } from '../src/endpoints.ts';
import { HARNESS_IDS, planFor, planForRun, resolveModel, DEFAULT_MODEL, type PlanContext } from '../src/harnesses.ts';

const KEY = 'sk-st-abcdefghijkl.SECRET';
const EP = endpoints({} as NodeJS.ProcessEnv);

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const paid = over.paid ?? false;
  const modelOverride = over.modelOverride ?? null;
  return {
    key: KEY,
    endpoints: EP,
    model: resolveModel(DEFAULT_MODEL, modelOverride, paid),
    paid,
    modelOverride,
    ...over,
  };
}

const plan = (id: string, over: Partial<PlanContext> = {}) => {
  const result = planFor(id, ctx(over));
  assert.ok(result, `${id} should be a known harness`);
  return result;
};

// ── The prefix rule ───────────────────────────────────────────────────────────────────────────

test('every model id is prefixed by default — the pool pays unless asked otherwise', () => {
  assert.equal(resolveModel('anthropic/claude-sonnet-5', null, false), 'sponsored/anthropic/claude-sonnet-5');
});

test('--paid drops the prefix, even from a --model that already carried one', () => {
  assert.equal(resolveModel('a/b', null, true), 'a/b');
  assert.equal(resolveModel('a/b', 'sponsored/x/y', true), 'x/y');
});

test('--model is idempotent about the prefix', () => {
  assert.equal(resolveModel('a/b', 'sponsored/x/y', false), 'sponsored/x/y');
  assert.equal(resolveModel('a/b', 'x/y', false), 'sponsored/x/y');
});

// ── The common environment ────────────────────────────────────────────────────────────────────

test('every harness gets all four credential families, at the right base URLs', () => {
  for (const id of HARNESS_IDS) {
    const p = plan(id);
    assert.equal(p.env.SPONSOREDTOKENS_API_KEY, KEY, id);
    assert.equal(p.env.OPENAI_BASE_URL, 'https://sponsoredtokens.com/api/v1', id);
    assert.equal(p.env.OPENROUTER_BASE_URL, 'https://sponsoredtokens.com/api/v1', id);
    // Claude Code's base stops one segment earlier: it appends `/v1/messages` itself.
    assert.equal(p.env.ANTHROPIC_BASE_URL, 'https://sponsoredtokens.com/api', id);
    assert.equal(p.env.ANTHROPIC_AUTH_TOKEN, KEY, id);
  }
});

test('ANTHROPIC_API_KEY is REMOVED, so a real Anthropic key in the shell is not sent to the pool', () => {
  for (const id of HARNESS_IDS) {
    assert.ok(plan(id).unset.includes('ANTHROPIC_API_KEY'), id);
  }
});

test('`run` gets the common environment and nothing harness-specific', () => {
  const p = planForRun(ctx(), 'make');
  assert.equal(p.bin, 'make');
  assert.equal(p.env.OPENAI_API_KEY, KEY);
  assert.deepEqual(p.configs, []);
  assert.deepEqual(p.args, []);
});

// ── Claude Code ───────────────────────────────────────────────────────────────────────────────

test('claude gets both the current and the deprecated small-model variable', () => {
  const p = plan('claude');
  assert.equal(p.env.ANTHROPIC_MODEL, 'sponsored/anthropic/claude-sonnet-5');
  assert.equal(p.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'sponsored/anthropic/claude-haiku-4.5');
  // The prefixed id is unknown to Claude Code's catalogue; without this it lectures on every launch.
  assert.equal(p.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT, '1');
  assert.equal(p.env.ANTHROPIC_SMALL_FAST_MODEL, 'sponsored/anthropic/claude-haiku-4.5');
  assert.deepEqual(p.configs, [], 'Claude Code needs no config file');
  assert.equal(p.install?.command, 'npm install -g @anthropic-ai/claude-code');
});

test('--paid drops the prefix from BOTH of claude’s models, not just the big one', () => {
  const p = plan('claude', { paid: true });
  assert.equal(p.env.ANTHROPIC_MODEL, 'anthropic/claude-sonnet-5');
  assert.equal(p.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'anthropic/claude-haiku-4.5');
});

// ── Codex ─────────────────────────────────────────────────────────────────────────────────────

test('codex selects the provider and the model on the command line, and writes the provider block', () => {
  const p = plan('codex');
  assert.deepEqual(p.args, ['-c', 'model_provider=sponsoredtokens', '-c', 'model=sponsored/openai/gpt-5.1-codex']);
  assert.deepEqual(p.configs[0]?.segments, ['.codex', 'config.toml']);
  assert.equal(p.configs[0]?.format, 'codex-toml');
});

test('the banner model is the plan’s own, so a codex session is not labelled with sonnet', () => {
  assert.equal(plan('codex').model, 'sponsored/openai/gpt-5.1-codex');
  assert.equal(plan('claude').model, 'sponsored/anthropic/claude-sonnet-5');
});

test('codex has its own default model, and --model still overrides it', () => {
  assert.ok(plan('codex', { modelOverride: 'openai/gpt-5.5' }).args.includes('model=sponsored/openai/gpt-5.5'));
  assert.ok(plan('codex', { paid: true }).args.includes('model=openai/gpt-5.1-codex'));
});

// ── The config-file harnesses ─────────────────────────────────────────────────────────────────

test('openclaw is configured by openclaw itself, merging rather than rewriting its JSON5', () => {
  const p = plan('openclaw');
  assert.deepEqual(p.configs, [], 'we never parse JSON5 ourselves');
  const [command] = p.preCommands;
  assert.ok(command);
  assert.deepEqual(command.slice(0, 3), ['config', 'set', 'models.providers.sponsoredtokens']);
  assert.ok(command.includes('--merge'), 'a set without --merge would replace the providers table');
  const provider = JSON.parse(command[3]!) as { baseUrl: string; apiKey: { source: string; id: string } };
  assert.equal(provider.baseUrl, 'https://sponsoredtokens.com/api/v1');
  assert.deepEqual(provider.apiKey, { source: 'env', id: 'SPONSOREDTOKENS_API_KEY' });
});

test('opencode gets a provider block in its own config, not OPENCODE_CONFIG_CONTENT', () => {
  const p = plan('opencode');
  assert.equal(p.env.OPENCODE_CONFIG_CONTENT, undefined, 'that variable REPLACES the user’s config');
  assert.deepEqual(p.configs[0]?.segments, ['.config', 'opencode', 'opencode.json']);
  const patch = p.configs[0]?.patch as { provider: { sponsoredtokens: { options: { baseURL: string; apiKey: string } } } };
  assert.equal(patch.provider.sponsoredtokens.options.baseURL, 'https://sponsoredtokens.com/api/v1');
  assert.equal(patch.provider.sponsoredtokens.options.apiKey, '{env:SPONSOREDTOKENS_API_KEY}');
});

test('kilo takes the OpenCode shape at its own trusted path, where {env:…} resolves', () => {
  const p = plan('kilo');
  assert.deepEqual(p.configs[0]?.segments, ['.config', 'kilo', 'kilo.jsonc']);
  const patch = p.configs[0]?.patch as { model: string };
  assert.equal(patch.model, 'sponsoredtokens/sponsored/anthropic/claude-sonnet-5');
});

test('pi gets a provider in ~/.pi/agent/models.json with $VAR interpolation', () => {
  const p = plan('pi');
  assert.deepEqual(p.configs[0]?.segments, ['.pi', 'agent', 'models.json']);
  const patch = p.configs[0]?.patch as { providers: { sponsoredtokens: { apiKey: string; api: string } } };
  assert.equal(patch.providers.sponsoredtokens.apiKey, '$SPONSOREDTOKENS_API_KEY');
  assert.equal(patch.providers.sponsoredtokens.api, 'openai-completions');
});

// ── The env-only outliers ─────────────────────────────────────────────────────────────────────

test('hermes is wired by CUSTOM_BASE_URL, which beats anything in its config', () => {
  const p = plan('hermes');
  assert.equal(p.env.CUSTOM_BASE_URL, 'https://sponsoredtokens.com/api/v1');
  assert.deepEqual(p.configs, []);
  assert.equal(p.install?.kind, 'script', 'the official Hermes is not on npm');
});

test('junie goes through its LiteLLM provider, which needs no file at all', () => {
  const p = plan('junie');
  assert.equal(p.env.JUNIE_LLM_PROVIDER, 'litellm');
  assert.equal(p.env.JUNIE_LITELLM_URL, 'https://sponsoredtokens.com/api/v1');
  assert.equal(p.env.JUNIE_LITELLM_API_KEY, KEY);
  assert.equal(p.env.JUNIE_MODEL, 'sponsored/anthropic/claude-sonnet-5');
});

test('t3 is a wrapper, so it gets the Claude Code variables to pass down', () => {
  const p = plan('t3');
  assert.equal(p.env.ANTHROPIC_MODEL, 'sponsored/anthropic/claude-sonnet-5');
  assert.equal(p.bin, 't3');
});

// ── The refusal ───────────────────────────────────────────────────────────────────────────────

test('cursor refuses by name rather than pretending', () => {
  const p = plan('cursor');
  assert.ok(p.unsupported, 'Cursor CLI has no custom-endpoint setting; launching it would bill Cursor');
  assert.match(p.unsupported, /no custom-endpoint setting/);
});

test('an unknown id is null, not a guess', () => {
  assert.equal(planFor('aider', ctx()), null);
});
