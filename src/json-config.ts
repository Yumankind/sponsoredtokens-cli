/**
 * Merging one provider block into somebody else's JSON config, without ever taking something out.
 *
 * Four of the harnesses (OpenCode, Kilo, pi, and OpenClaw's file form) keep their providers in a
 * JSON document that also holds every other setting the user has. There is no "add a provider"
 * API, so the CLI has to read, merge and write — and the failure mode to design against is not a
 * crash, it is a silent loss: a config that comes back missing the user's keybindings because we
 * wrote our object over theirs.
 *
 * So, three rules:
 *
 *   · MERGE IS RECURSIVE AND ADDITIVE. Objects are merged key by key; arrays and scalars from the
 *     patch replace, because an array of models is a value, not a namespace. Nothing is deleted.
 *   · A KEY THE USER ALREADY SET WINS. If `provider.sponsoredtokens.options.baseURL` is already
 *     there, we leave it — they pointed it somewhere on purpose, perhaps at a `wrangler dev`.
 *   · A FILE WE CANNOT PARSE IS NOT A FILE WE REWRITE. Kilo's config is `.jsonc` and may legally
 *     hold comments; a hand-rolled comment stripper that gets a `//` inside a string wrong would
 *     silently corrupt it. When `JSON.parse` refuses, the caller prints the block for the user to
 *     paste and stops. Refusing to write is always recoverable; writing the wrong thing is not.
 */

export type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `patch` merged into `base`, with `base`'s own values kept wherever the two disagree.
 *
 * Returns a NEW object; neither input is mutated, which is what makes `changed` below trustworthy.
 */
export function mergePreservingExisting(base: unknown, patch: JsonObject): JsonObject {
  const out: JsonObject = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    if (isPlainObject(value)) {
      out[key] = mergePreservingExisting(existing, value);
    } else if (existing === undefined) {
      out[key] = value;
    }
    // else: the user set a scalar or an array here. Theirs stands.
  }
  return out;
}

export type JsonMergeResult =
  | { kind: 'unchanged' }
  | { kind: 'write'; content: string }
  /** The file exists but is not JSON we can safely rewrite — comments, trailing commas, corruption. */
  | { kind: 'unparseable' };

/**
 * What to do with a config file, given its current text (`null` when it does not exist).
 *
 * Two spaces and a trailing newline: the format every one of these tools ships its own examples in,
 * so a file we create looks like one they would have created.
 */
export function mergeJsonConfig(existing: string | null, patch: JsonObject): JsonMergeResult {
  if (existing === null || existing.trim() === '') {
    return { kind: 'write', content: `${JSON.stringify(patch, null, 2)}\n` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return { kind: 'unparseable' };
  }
  const merged = mergePreservingExisting(parsed, patch);
  const content = `${JSON.stringify(merged, null, 2)}\n`;
  // Compare the VALUES, not the text: a user whose file is formatted differently should not get a
  // rewrite just because we would have indented it another way.
  if (JSON.stringify(merged) === JSON.stringify(parsed)) return { kind: 'unchanged' };
  return { kind: 'write', content };
}
