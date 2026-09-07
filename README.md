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
sponsoredtokens claude            # Claude Code, on the pool
sponsoredtokens codex             # Codex CLI
sponsoredtokens run npm test      # export the variables and run anything
sponsoredtokens status            # the pool, your budget, your tier, your model
sponsoredtokens sponsor acme.com  # put money back in: a link for whoever pays
```

Every command that talks to the pool prints where it stands, three lines, before it gets out of the
way:

```
  Pool      67.7M tokens left of 135.9M sponsored · 13 sponsors
  Top       Northwind Labs 20.1M · Ferrite 13.1M · Papertrail Books 9.48M
  Recent    Kestrel Analytics 11.7M · Northwind Labs 50.0M · Muswell Coffee 3.75M
            Token figures are at Claude Sonnet 5 prices.
```

`--quiet` turns that off. It is never fetched with your key, never blocks for more than 3 seconds,
and prints nothing at all when the board cannot be reached.

The figures are **tokens**, converted at one named reference price — Claude Sonnet 5 at pool prices,
$24 per million blended — which is the same conversion sponsoredtokens.com uses on its home page, so
the two never quote a different size for the same pool. It is a size, not a quote: the pool spends on
whatever model each task picks. Money that IS money stays money — your weekly budget below, and the
`sponsor` amount, which is a price.

`status` shows what you have:

```
  sponsored/tokens  0.3.7

  Pool      67.7M tokens left of 135.9M sponsored · 13 sponsors
  Top       Northwind Labs 20.1M · Ferrite 13.1M · Papertrail Books 9.48M
  Recent    Kestrel Analytics 11.7M · Northwind Labs 50.0M · Muswell Coffee 3.75M

  Budget    $18.75 left of $25 this week · 781K tokens
  Resets    2026-09-08T00:00:00Z
  Tier      0 — 2 referrals unlock anthropic/claude-sonnet-5
  Model     sponsored/anthropic/claude-haiku-4.5
  Referral  https://sponsoredtokens.com/r/K3ST
  Key       from SPONSOREDTOKENS_API_KEY
            Token figures are at Claude Sonnet 5 prices.
```

## Commands

| | |
|---|---|
| `login` | Device-code sign-in. Prints a code, opens the browser, stores the key at `~/.sponsoredtokens/config.json` (0600). |
| `logout` | Forget the stored key. The key on the server is unchanged — rotate it on the account page. |
| `status` | The pool, your weekly budget, your tier, the model a launch would pick, your referral link. |
| `claude`, `codex`, `openclaw`, `opencode`, `pi`, `kilo`, `hermes`, `junie`, `t3` | Wire the harness to the pool and launch it. Arguments are forwarded. |
| `run <cmd…>` | Export every base URL and key, then run any command. |
| `sponsor <target>` | Put money in. Prints a Stripe Checkout link, and a QR code of it, for whoever pays. No key needed. |

## Options

| | |
|---|---|
| `--paid` | Spend your own credits instead of the pool: drops the `sponsored/` model prefix. |
| `--model <id>` | Override the model, with or without the `sponsored/` prefix — it is added for you unless `--paid`. A 402 from the pool means the model is above your tier: `--model anthropic/claude-haiku-4.5`. |
| `--yes`, `-y` | Install a missing harness without asking. Never used for `curl \| bash` installers. |
| `--quiet`, `-q` | No pool block and no model line before the harness starts. |
| `--` | Stop reading options. Everything after is forwarded verbatim. |

`--paid`, `--model`, `--yes` and `--quiet` are recognised before or after a harness name, but never
after `--`, and never inside a `run` command — that argv is yours.

## Sponsoring the pool

```sh
sponsoredtokens sponsor acme.com                       # the amount that takes #1 today
sponsoredtokens sponsor @acme --platform github --amount 250
sponsoredtokens sponsor acme.com --audience PT,ES      # Portugal and Spain, $2 each
sponsoredtokens sponsor acme.com --json --no-open      # for an agent
```

```
  Sponsor   https://acme.com
  Amount    $487
  Rank      #1 — the top spot
  Pay       https://checkout.stripe.com/c/pay/cs_live_…
```

Followed by a QR code of that link, and one line: give the link to the person who pays. **The
sponsorship is completed by a human**, on Stripe's own page, with their own card — this command
mints the link and settles nothing. Whoever pays accepts the [terms](https://sponsoredtokens.com/terms)
there; the version accepted is stored on the sponsor record.

| | |
|---|---|
| `--amount <n>` | Whole dollars. Default: the top remaining balance on your board plus $5, which is what takes #1 there. Below that board's minimum ($2 global, $2 for each country) or above $100,000 is refused before any request is made |
| `--audience <a>` | `global` (the default: every board, everywhere) or the countries you want to be seen in — `--audience PT,ES`. See **Global or local** |
| `--platform <id>` | For a bare `@handle`: `x`, `github`, `youtube`, `tiktok`, `bluesky`. X when not given, and ignored for a URL |
| `--json` | One object on stdout and nothing else; the wordmark and the closing note move to stderr. Errors are `{ "error", "code" }` on stdout with exit 1 |
| `--no-open` | Print the link and the QR; do not open a browser. A browser is never opened without a terminal anyway |
| `--quiet` | Only the four facts: target, amount, rank, link |

```json
{
  "target": "https://acme.com",
  "platform": null,
  "audience": "global",
  "amountCents": 48700,
  "rank": 1,
  "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_live_…",
  "shortUrl": "https://sponsoredtokens.com/p/x7Kq2mP9aB",
  "terms": { "version": "2026-09", "payer": "operator" }
}
```

`payer: "operator"` is the contract: the human who runs the agent is the one who pays the link and
accepts the terms. **No key is required** — `POST /api/sponsor/checkout` is public. If a key is
stored it is sent anyway, so the sponsorship can be attributed to that account later.

### Global or local

`--audience` decides which board the sponsorship is on, and every other number follows from it.

```sh
sponsoredtokens sponsor acme.com                      # global: every board, from $2
sponsoredtokens sponsor acme.com --audience PT,ES     # the local boards of PT and ES, from $2
sponsoredtokens sponsor acme.com --audience dach,PT   # groups and countries mix
```

```
  Sponsor   https://acme.com
  Amount    $50
  Rank      #1 — the top spot on the local board of PT
  Pay       https://checkout.stripe.com/c/pay/cs_live_…
```

A **global** sponsor is on every board there is, and on the home page for everybody: $2 minimum. A
**local** sponsor is on the local boards of the countries they named and nowhere else, and is drawn
for the pool's tasks that come from those countries: **$2 for each country**. One country is $2,
three are $6, eighty-four are $168 — a country is a board, and each board costs the same. So $2 is
the entry price either way, and picking two countries costs more than picking the world: countries
are bought one board at a time, and the world is one board. A local sponsor still appears on the
global board too, ranked by balance like anyone else. The audience is set at payment, and the
only way to change it is to recharge with a different one.

Country codes are ISO-3166-1 alpha-2, in any case, de-duplicated and sorted before they are sent:
`--audience pt,es,PT` is `["ES","PT"]`. Twelve group names stand for a list of codes and can be
mixed with plain ones — `eu`, `eea`, `dach`, `nordics`, `iberia`, `uk-ie`, `north-america`, `latam`,
`apac`, `middle-east`, `africa`, `english` (`src/countries.ts` writes out exactly what each covers).
There is **no ceiling**: name as many countries as you like and pay $2 for each, so
`--audience eea,africa` is 84 countries and $168. The one exception is the set that leaves nobody
out — name all **249** and it is a **global** sponsorship, because "everyone" is simply the global
board written the long way. The command says so in one line before it asks for anything: *That is
every country, so this is a global sponsorship.* Nothing is refused either way; the amount is then
the global board's, starting at $2.

Codes are validated against the standard itself — all 249 are embedded in `src/countries.ts`, copied
from the site's own table so the two agree exactly — so `ZZ` is refused here, by name, rather than
sent on to be refused by the pool.

Anything else is refused before a Checkout session exists, by name rather than by being dropped: an
unknown country, an empty entry, `global` mixed with countries, an amount under what the countries
come to — `--audience PT,ES,FR --amount 20` is answered with *3 countries need at least $30*. The
"#N" and the board come from the first country you named, `PT` for `--audience PT,ES`; the default
amount is that board's suggestion, never proposed below what the countries cost.

The QR code is encoded here, with no dependency (`src/qr.ts`, byte mode, error level L, versions
1–20). It is drawn only on a colour terminal wide enough for it, and nothing is printed otherwise:
a QR that cannot be guaranteed dark-on-light in the reader's theme, or that wraps, is not a QR
worth printing. A live Stripe Checkout link is about 479 bytes, which is a version-15 symbol — **85
columns**. An 80-column window gets the link and no picture.

The [agents page](https://sponsoredtokens.com/docs/agents) has the same thing as one HTTP request,
with a `sponsor_pool` tool definition to paste into a toolset.

## Which model

The pool gates models by tier, so the default is not a constant: before a launch the CLI reads
`GET /api/v1/models` with your key and takes the **dearest sponsored model at or below your tier** —
an Anthropic one for Claude Code, an OpenAI one for Codex, the dearest of any vendor otherwise — and
says which, and why:

```
  Model     sponsored/anthropic/claude-haiku-4.5 — the best at tier 0; 2 referrals unlock anthropic/claude-sonnet-5
```

The answer is cached in `~/.sponsoredtokens/config.json` for an hour. If the list cannot be read the
CLI falls back to `sponsored/anthropic/claude-haiku-4.5`, which is tier 0 — never to a model your
tier would refuse, because that is a 402 in the middle of somebody's first session.

## Colour

ANSI when stdout (or stderr, for the stream being written to) is a terminal, `NO_COLOR` is unset and
`TERM` is not `dumb`; `FORCE_COLOR` turns it on anyway, `FORCE_COLOR=0` off. The accent is the brand
orange `#D97757` in truecolour, its 256-colour neighbour where `COLORTERM` says nothing, and plain
bold below that. Windows 10+ is detected, never switched into VT mode by us.

## Environment

| | |
|---|---|
| `SPONSOREDTOKENS_API_KEY` | Use this key instead of the stored one. The way to run in CI. |
| `SPONSOREDTOKENS_BASE_URL` | Point at another deployment (a `wrangler dev`, say). Defaults to `https://sponsoredtokens.com`. |
| `NO_COLOR`, `FORCE_COLOR` | Turn the colour off / on. See **Colour**. |

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

Three things are mirrored from elsewhere in the monorepo and guarded by tests that read the original
file: `TERMS_VERSION` from `sponsoredtokens-site/src/content/index.ts`, `PLATFORM_IDS` from
`worker/src/sponsored/platforms.ts`, and the token conversion in `src/tokens.ts` — the reference
price and both formatters — from `sponsoredtokens-site/src/lib/tank.ts` and `lib/pool-line.ts`. The
audience — the two minimums and the twelve groups — is the CLI's copy of
`docs/sponsoredtokens/audience-contract.md`, which is the file to change first.

Release: bump `package.json` **and** `src/version.ts` (a test fails if they disagree), tag
`cli-v<version>`, push. `.github/workflows/sponsoredtokens-cli.yml` compiles the five binaries with
Bun, writes `SHA256SUMS`, uploads to the `sponsoredtokens-cli` R2 bucket and publishes to npm.
