/**
 * The two config mergers, and the property both exist to guarantee: WE NEVER TAKE SOMETHING OUT.
 *
 * A user's `~/.codex/config.toml` and `~/.config/opencode/opencode.json` are files they have been
 * editing for months. The worst bug this CLI could ship is not a failed launch — it is a launch that
 * works and quietly costs them a setting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCodexConfig, hasCodexProvider, CODEX_PROVIDER_ID } from '../src/codex-config.ts';
import { mergeJsonConfig, mergePreservingExisting } from '../src/json-config.ts';

const BASE = 'https://sponsoredtokens.com/api/v1';

// ── Codex TOML ────────────────────────────────────────────────────────────────────────────────

test('an empty config becomes just our block', () => {
  const merged = mergeCodexConfig('', BASE);
  assert.equal(merged.changed, true);
  assert.match(merged.content, /^# Added by `sponsoredtokens`/);
  assert.ok(merged.content.includes(`[model_providers.${CODEX_PROVIDER_ID}]`));
  assert.ok(merged.content.includes('wire_api = "responses"'));
  assert.ok(merged.content.includes('env_key = "SPONSOREDTOKENS_API_KEY"'));
  assert.ok(!merged.content.includes('sk-st-'), 'the key itself never goes on disk twice');
});

test('an existing config keeps every byte, and ours is appended after one blank line', () => {
  const existing = ['# my notes', 'model = "gpt-5.1"', '', '[model_providers.mine]', 'base_url = "http://localhost:1234"', ''].join('\n');
  const merged = mergeCodexConfig(existing, BASE);
  assert.equal(merged.changed, true);
  assert.ok(merged.content.startsWith('# my notes\nmodel = "gpt-5.1"'));
  assert.ok(merged.content.includes('[model_providers.mine]'));
  assert.ok(merged.content.includes('base_url = "http://localhost:1234"'));
  assert.match(merged.content, /base_url = "http:\/\/localhost:1234"\n\n# Added by/);
});

test('running twice writes nothing the second time', () => {
  const once = mergeCodexConfig('model = "x"\n', BASE);
  const twice = mergeCodexConfig(once.content, BASE);
  assert.equal(twice.changed, false);
  assert.equal(twice.content, once.content);
});

test('the quoted table spelling counts as already present', () => {
  for (const header of ['[model_providers.sponsoredtokens]', '[model_providers."sponsoredtokens"]', '  [ model_providers . sponsoredtokens ]']) {
    assert.equal(hasCodexProvider(`${header}\nbase_url = "x"\n`), true, header);
  }
});

test('a DIFFERENT provider whose name merely contains ours is not a match', () => {
  assert.equal(hasCodexProvider('[model_providers.sponsoredtokens_old]\n'), false);
});

// ── JSON ──────────────────────────────────────────────────────────────────────────────────────

test('the merge is recursive and never deletes', () => {
  const merged = mergePreservingExisting({ theme: 'dark', provider: { mine: { url: 'x' } } }, { provider: { ours: { url: 'y' } } });
  assert.deepEqual(merged, { theme: 'dark', provider: { mine: { url: 'x' }, ours: { url: 'y' } } });
});

test('a value the user already set wins — they pointed it somewhere on purpose', () => {
  const merged = mergePreservingExisting({ provider: { ours: { url: 'their-own' } } }, { provider: { ours: { url: 'https://sponsoredtokens.com/api/v1', extra: 1 } } });
  assert.deepEqual(merged, { provider: { ours: { url: 'their-own', extra: 1 } } });
});

test('no file at all produces exactly our patch', () => {
  const result = mergeJsonConfig(null, { provider: { ours: {} } });
  assert.equal(result.kind, 'write');
  assert.equal(result.kind === 'write' && result.content, '{\n  "provider": {\n    "ours": {}\n  }\n}\n');
});

test('an already-merged file is unchanged, so its mtime survives', () => {
  const first = mergeJsonConfig(null, { a: { b: 1 } });
  assert.equal(first.kind, 'write');
  const second = mergeJsonConfig(first.kind === 'write' ? first.content : '', { a: { b: 1 } });
  assert.equal(second.kind, 'unchanged');
});

test('a file with comments is refused, not guessed at', () => {
  const jsonc = '{\n  // my provider\n  "provider": {}\n}\n';
  assert.equal(mergeJsonConfig(jsonc, { provider: { ours: {} } }).kind, 'unparseable');
});

test('an array in the user’s file is replaced only if they have no value there at all', () => {
  const kept = mergePreservingExisting({ models: ['a'] }, { models: ['b'] });
  assert.deepEqual(kept, { models: ['a'] });
  const added = mergePreservingExisting({}, { models: ['b'] });
  assert.deepEqual(added, { models: ['b'] });
});
