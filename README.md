# sponsoredtokens

Run your coding agent on [sponsoredtokens.com](https://sponsoredtokens.com) — a public pool of AI
tokens paid for by sponsors. Every task ends with a line naming the company that paid for it.

```sh
curl -fsSL https://sponsoredtokens.com/cli/install.sh | bash    # macOS, Linux
irm https://sponsoredtokens.com/cli/install.ps1 | iex            # Windows
npx sponsoredtokens login                                        # or just use npx
```

Then:

```sh
sponsoredtokens claude          # Claude Code, on the pool
sponsoredtokens codex           # Codex CLI
sponsoredtokens run npm test    # export the variables and run anything
sponsoredtokens status          # weekly budget, tier, referral link
```

## Commands

| | |
|---|---|
| `login` | Device-code sign-in. Prints a code, opens the browser, stores the key at `~/.sponsoredtokens/config.json` (0600). |
| `logout` | Forget the stored key. The key on the server is unchanged — rotate it on the account page. |
| `status` | Weekly budget, model tier, referral link. |
| `claude`, `codex`, `openclaw`, `opencode`, `pi`, `kilo`, `hermes`, `junie`, `t3` | Wire the harness to the pool and launch it. Arguments are forwarded. |
| `run <cmd…>` | Export every base URL and key, then run any command. |

## Options

| | |
|---|---|
| `--paid` | Spend your own credits instead of the pool: drops the `sponsored/` model prefix. |
| `--model <id>` | Override the model. `sponsored/` is added unless `--paid`. |
| `--yes`, `-y` | Install a missing harness without asking. Never used for `curl \| bash` installers. |
| `--` | Stop reading options. Everything after is forwarded verbatim. |

`--paid`, `--model` and `--yes` are recognised before or after a harness name, but never after `--`,
and never inside a `run` command — that argv is yours.

## Environment

| | |
|---|---|
| `SPONSOREDTOKENS_API_KEY` | Use this key instead of the stored one. The way to run in CI. |
| `SPONSOREDTOKENS_BASE_URL` | Point at another deployment (a `wrangler dev`, say). Defaults to `https://sponsoredtokens.com`. |

## Which harnesses are wired how

Verified against each harness's own documentation, 2026-09-05. `src/harnesses.ts` cites the page
each row came from.

| Harness | How |
|---|---|
| Claude Code | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` |
| Codex | a `[model_providers.sponsoredtokens]` block appended to `~/.codex/config.toml`, plus `-c model_provider=` / `-c model=` |
| OpenClaw | `openclaw config set models.providers.sponsoredtokens … --merge` (OpenClaw edits its own JSON5) |
| OpenCode | a provider merged into `~/.config/opencode/opencode.json` |
| Kilo | a provider merged into `~/.config/kilo/kilo.jsonc` |
| pi | a provider merged into `~/.pi/agent/models.json` |
| Hermes | `CUSTOM_BASE_URL` + `OPENAI_API_KEY` |
| Junie | `JUNIE_LLM_PROVIDER=litellm`, `JUNIE_LITELLM_URL`, `JUNIE_LITELLM_API_KEY` |
| T3 Code | the Claude Code variables, which T3 passes to the CLI it launches |
| Cursor CLI | **not supported.** Cursor CLI has no custom-endpoint setting; `CURSOR_API_KEY` authenticates to Cursor itself. The command says so and stops. |

A config file that already contains our provider is left alone. A config file we cannot parse is
never rewritten — the block is printed for you to paste instead.

## Development

```sh
npm install      # devDependencies only; the CLI itself has no runtime dependency
npm test         # node --test, TypeScript run directly
npm run typecheck
npm run build    # plain tsc → dist/, which is what `npx sponsoredtokens` runs
```

Release: bump `package.json` **and** `src/version.ts` (a test fails if they disagree), tag
`cli-v<version>`, push. `.github/workflows/sponsoredtokens-cli.yml` compiles the five binaries with
Bun, writes `SHA256SUMS`, uploads to the `sponsoredtokens-cli` R2 bucket and publishes to npm.
