/**
 * `reset`: the inverse of every config write a launch makes.
 *
 * The first block checks the two pure removals byte for byte. The last test is the one that
 * matters over time: for every harness that writes a file, the path `reset` would remove is the
 * path the launch would add — a new harness with a differently-shaped patch fails here rather
 * than leaving its block behind forever.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeCodexProvider, removeJsonPath, providerPath } from '../src/reset.ts';
import { codexProviderBlock, mergeCodexConfig } from '../src/codex-config.ts';
import { mergeJsonConfig } from '../src/json-config.ts';
import { HARNESS_IDS, planFor } from '../src/harnesses.ts';
import { endpoints } from '../src/endpoints.ts';

test('removing the Codex table gives back exactly the file the merge started from', () => {
  const theirs = '[model]\nname = "gpt-5"\n\n[model_providers.mine]\nbase_url = "https://x.test"\n';
  const merged = mergeCodexConfig(theirs, 'https://sponsoredtokens.com/api/v1').content;
  const removed = removeCodexProvider(merged);
  assert.equal(removed.changed, true);
  assert.equal(removed.content, theirs);
});

test('our table in the MIDDLE of a file goes, and the table after it stays', () => {
  const toml = `[a]\nx = 1\n\n${codexProviderBlock('https://s.test/v1')}\n[b]\ny = 2\n`;
  assert.equal(removeCodexProvider(toml).content, '[a]\nx = 1\n\n[b]\ny = 2\n');
});

test('a file that was only our block becomes empty; a file without it is untouched', () => {
  assert.equal(removeCodexProvider(codexProviderBlock('https://s.test/v1')).content, '');
  const theirs = '[model]\nname = "x"\n';
  assert.deepEqual(removeCodexProvider(theirs), { content: theirs, changed: false });
});

test('removing the JSON provider gives back the values the merge started from, and drops an emptied parent', () => {
  const theirs = '{\n  "$schema": "https://opencode.ai/config.json",\n  "theme": "dark"\n}\n';
  const patch = { provider: { sponsoredtokens: { name: 'sponsoredtokens' } } };
  const merged = mergeJsonConfig(theirs, patch);
  assert.equal(merged.kind, 'write');
  const removed = removeJsonPath(merged.kind === 'write' ? merged.content : '', ['provider', 'sponsoredtokens']);
  assert.equal(removed.kind, 'write');
  assert.deepEqual(JSON.parse(removed.kind === 'write' ? removed.content : ''), { $schema: 'https://opencode.ai/config.json', theme: 'dark' });
});

test('a sibling provider keeps its parent; a missing path is unchanged; comments are refused', () => {
  const two = JSON.stringify({ provider: { sponsoredtokens: {}, other: { a: 1 } } });
  const r = removeJsonPath(two, ['provider', 'sponsoredtokens']);
  assert.deepEqual(JSON.parse(r.kind === 'write' ? r.content : ''), { provider: { other: { a: 1 } } });
  assert.deepEqual(removeJsonPath('{"a":1}', ['provider', 'sponsoredtokens']), { kind: 'unchanged' });
  assert.deepEqual(removeJsonPath('{ // c\n}', ['provider']), { kind: 'unparseable' });
  assert.deepEqual(removeJsonPath(null, ['provider']), { kind: 'unchanged' });
});

test('every harness that writes a file writes a block reset can find again', () => {
  const ctx = { key: 'sk-st-test', endpoints: endpoints({}), model: 'sponsored/x/y', paid: false, modelOverride: null };
  let filesSeen = 0;
  for (const id of HARNESS_IDS) {
    const plan = planFor(id, ctx);
    assert.ok(plan, id);
    for (const config of plan.configs) {
      filesSeen += 1;
      if (config.format === 'codex-toml') continue;
      const path = providerPath(config.patch ?? {});
      assert.ok(path && path[path.length - 1] === 'sponsoredtokens', `${id}: ${config.label} has no sponsoredtokens object in its patch`);
    }
  }
  assert.ok(filesSeen >= 4, 'codex, opencode, kilo and pi write files');
});
