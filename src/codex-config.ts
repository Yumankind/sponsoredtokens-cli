/**
 * The one config file this CLI writes into that it does not own: `~/.codex/config.toml`.
 *
 * Codex takes its provider from a `[model_providers.<id>]` table, and `-c` overrides on the command
 * line can select the provider but cannot DEFINE one. So the block has to be on disk before the
 * launch, which means editing a file full of the user's own settings.
 *
 * The rule this file exists to enforce: WRITE THE BLOCK IF IT IS ABSENT, TOUCH NOTHING ELSE, EVER.
 * Not a parse-and-reserialize — a TOML round-trip through any parser loses comments, reorders tables
 * and rewrites the user's string quoting, and a person whose Codex config came back reformatted will
 * never trust this CLI again. So: a regex to decide whether our table is already there, and an
 * append when it is not. Appending is safe in TOML because a table header ends the previous table,
 * so text added at the end of the file cannot land inside somebody else's `[table]`.
 *
 * The key itself is NOT written here. `env_key` names an environment variable, so the secret stays
 * in the process we spawn and never reaches the user's disk twice.
 */

/** The provider id, in the file and in `-c model_provider=`. */
export const CODEX_PROVIDER_ID = 'sponsoredtokens';

/** Matches `[model_providers.sponsoredtokens]` and the quoted spelling TOML also allows. */
const PROVIDER_HEADER = /^[ \t]*\[[ \t]*model_providers[ \t]*\.[ \t]*(?:sponsoredtokens|"sponsoredtokens"|'sponsoredtokens')[ \t]*\][ \t]*$/m;

export function hasCodexProvider(toml: string): boolean {
  return PROVIDER_HEADER.test(toml);
}

/**
 * The block itself.
 *
 * `wire_api = "responses"` because the pool's `/api/v1/responses` door is the one Codex speaks
 * (PLAN §7). `env_key` rather than an inline key: see the header.
 */
export function codexProviderBlock(baseUrl: string): string {
  return [
    '# Added by `sponsoredtokens` — https://sponsoredtokens.com',
    `[model_providers.${CODEX_PROVIDER_ID}]`,
    'name = "sponsoredtokens"',
    `base_url = "${baseUrl}"`,
    'env_key = "SPONSOREDTOKENS_API_KEY"',
    'wire_api = "responses"',
    '',
  ].join('\n');
}

export interface CodexMerge {
  content: string;
  /** False when the block was already there — the caller then writes nothing at all. */
  changed: boolean;
}

/**
 * `existing` is the file's current text (`''` when there is no file yet). The result is what the
 * file should contain; when `changed` is false the caller must not write, so an unchanged config
 * keeps its mtime and its place in whatever the user's dotfile tooling does.
 */
export function mergeCodexConfig(existing: string, baseUrl: string): CodexMerge {
  if (hasCodexProvider(existing)) return { content: existing, changed: false };
  const block = codexProviderBlock(baseUrl);
  if (existing.trim() === '') return { content: block, changed: true };
  // Exactly one blank line between the user's last table and ours, whatever their file ended with.
  return { content: `${existing.replace(/\s*$/, '')}\n\n${block}`, changed: true };
}
