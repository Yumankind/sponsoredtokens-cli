/**
 * `sponsoredtokens reset [harness]` — take the pool back OUT of a harness's own configuration.
 *
 * What a launch leaves behind is small and named: a `[model_providers.sponsoredtokens]` table in
 * Codex's TOML, a `provider.sponsoredtokens` (OpenCode, Kilo) or `providers.sponsoredtokens` (pi)
 * object in a JSON file, and for OpenClaw a provider the tool itself wrote with `config set`. The
 * variables a launch exports live only in the child process and are gone when it exits, so `claude`
 * run plainly was never pointed at the pool in the first place. This is the inverse of
 * `applyConfigs` (index.ts): the same files, the same blocks, removed with every other byte kept.
 *
 * Nothing here deletes a file. A config that becomes `{}` is written as `{}`; the user's editor
 * history and their dotfile tooling are theirs.
 */
import { CODEX_PROVIDER_ID } from './codex-config.ts';
import type { JsonObject } from './json-config.ts';

/** The comment `codexProviderBlock` writes above its table, so a removal takes its own note with it. */
const CODEX_NOTE = /^[ \t]*#[^\n]*sponsoredtokens[^\n]*$/;
const CODEX_HEADER = /^[ \t]*\[[ \t]*model_providers[ \t]*\.[ \t]*(?:sponsoredtokens|"sponsoredtokens"|'sponsoredtokens')[ \t]*\][ \t]*$/;
const ANY_HEADER = /^[ \t]*\[/;

export interface TextEdit {
  content: string;
  changed: boolean;
}

/**
 * The TOML without our table: from the header (and the one comment line above it, when it is
 * ours) up to the next `[table]` header or the end of the file. The user's own tables before and
 * after are untouched; a run of blank lines the removal leaves behind is squeezed to one.
 */
export function removeCodexProvider(toml: string): TextEdit {
  const lines = toml.split('\n');
  const start = lines.findIndex((line) => CODEX_HEADER.test(line));
  if (start === -1) return { content: toml, changed: false };
  let from = start;
  if (from > 0 && CODEX_NOTE.test(lines[from - 1] ?? '')) from -= 1;
  let to = start + 1;
  while (to < lines.length && !ANY_HEADER.test(lines[to] ?? '')) to += 1;
  const kept = [...lines.slice(0, from), ...lines.slice(to)];
  const content = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  return { content: content.trim() === '' ? '' : content.endsWith('\n') ? content : `${content}\n`, changed: true };
}

export type JsonRemoveResult =
  | { kind: 'unchanged' }
  | { kind: 'write'; content: string }
  | { kind: 'unparseable' };

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The JSON without the object at `path` (e.g. `['provider', 'sponsoredtokens']`). The parent is
 * removed too when ours was the only thing in it, and no further: a `provider: {}` left behind is
 * harmless but untidy, while removing `$schema` or anything of the user's would be a loss.
 */
export function removeJsonPath(existing: string | null, path: string[]): JsonRemoveResult {
  if (existing === null || existing.trim() === '') return { kind: 'unchanged' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return { kind: 'unparseable' };
  }
  if (!isPlainObject(parsed) || path.length === 0) return { kind: 'unchanged' };
  const root: JsonObject = { ...parsed };
  const chain: JsonObject[] = [root];
  for (const key of path.slice(0, -1)) {
    const next = chain[chain.length - 1]?.[key];
    if (!isPlainObject(next)) return { kind: 'unchanged' };
    const copy = { ...next };
    chain[chain.length - 1]![key] = copy;
    chain.push(copy);
  }
  const leaf = path[path.length - 1]!;
  const parent = chain[chain.length - 1]!;
  if (!(leaf in parent)) return { kind: 'unchanged' };
  delete parent[leaf];
  if (chain.length > 1 && Object.keys(parent).length === 0) {
    delete chain[chain.length - 2]![path[path.length - 2]!];
  }
  return { kind: 'write', content: `${JSON.stringify(root, null, 2)}\n` };
}

/** Where, inside a launch plan's JSON patch, our provider object sits: the first key path ending in `sponsoredtokens`. */
export function providerPath(patch: JsonObject, providerId = CODEX_PROVIDER_ID): string[] | null {
  for (const [key, value] of Object.entries(patch)) {
    if (key === providerId) return [key];
    if (isPlainObject(value)) {
      const below = providerPath(value, providerId);
      if (below) return [key, ...below];
    }
  }
  return null;
}
