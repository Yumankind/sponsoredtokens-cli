/**
 * The harness table: what to set, what to write, and what to admit we cannot do.
 *
 * Everything here is a PURE function of `(harness id, key, endpoints, model, paid)` producing a
 * `LaunchPlan`. Nothing in this file touches the filesystem, spawns anything or reads the real
 * environment — `index.ts` applies the plan. That split is what makes the per-harness wiring
 * testable at all: the interesting bugs are "we set the wrong variable name" and "we would have
 * overwritten their config", and both are assertions about a plain object.
 *
 * ── WHAT WAS VERIFIED, 2026-09-05, AND WHAT IT CHANGED ──────────────────────────────────────────
 *
 * Each entry below cites the doc it came from. Three findings contradicted the plan and the code
 * follows the docs, not the plan:
 *
 *   · Claude Code's `ANTHROPIC_SMALL_FAST_MODEL` is DEPRECATED in favour of
 *     `ANTHROPIC_DEFAULT_HAIKU_MODEL`. Both are set — the new name for current versions, the old one
 *     so an installed-last-year Claude Code still gets a cheap model instead of falling back to a
 *     paid one.
 *   · OpenCode does NOT honour `OPENAI_BASE_URL` or `OPENROUTER_BASE_URL` (zero references in the
 *     source; the docs say providers only). Env-only wiring for it is a myth several blog posts
 *     repeat. It needs a provider block, so it gets one.
 *   · Cursor CLI has NO custom-endpoint support at all: `CURSOR_API_KEY` authenticates to Cursor,
 *     and `--endpoint` picks which Cursor backend to log into. There is no honest wiring, so the
 *     command REFUSES BY NAME rather than launching something that silently bills Cursor. A command
 *     that appears to work and quietly does the opposite of what it says is worse than no command.
 *
 * ── THE PREFIX RULE (PLAN §5) ───────────────────────────────────────────────────────────────────
 *
 * Every model id this CLI sets is `sponsored/<id>` — the pool pays. `--paid` drops the prefix and
 * the caller's own credits pay instead. That default is the whole reason the CLI exists: at launch
 * a sponsoredtokens.com wallet is empty, so an unprefixed id answers 402, and nobody should meet
 * that by accident on their first run.
 *
 * WHICH id is no longer a constant: the pool gates models by TIER, and the constants below are a
 * fallback for `--paid` and for an unreachable model list only. `models.ts` reads the caller's tier
 * and puts the answer on `PlanContext.tierModel`; see its header for why a stale constant here was
 * a 402 on a new account's very first launch.
 */
import type { Endpoints } from './endpoints.ts';
import { CODEX_PROVIDER_ID } from './codex-config.ts';
import type { JsonObject } from './json-config.ts';

/** The pool's default big model, without the prefix. `resolveModel` adds it. */
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5';

/** The cheap model Claude Code uses for its background chores. */
export const DEFAULT_SMALL_MODEL = 'anthropic/claude-haiku-4.5';

/** Codex is a different shape of model and the plan pins its own default. */
export const DEFAULT_CODEX_MODEL = 'openai/gpt-5.1-codex';

/** The prefix that means "the pool pays" (mirrors `worker/src/sponsored/config.ts`). */
export const SPONSORED_PREFIX = 'sponsored/';

/**
 * The model id to hand a harness.
 *
 * Idempotent about the prefix on purpose: `--model sponsored/x` and `--model x` mean the same
 * thing, and `--paid --model sponsored/x` means the unprefixed one — because `--paid` is a statement
 * about WHO PAYS, and letting a stale prefix in a shell alias override it would bill the pool for a
 * request the user asked to pay for themselves.
 */
export function resolveModel(defaultId: string, override: string | null, paid: boolean): string {
  const raw = override ?? defaultId;
  const bare = raw.startsWith(SPONSORED_PREFIX) ? raw.slice(SPONSORED_PREFIX.length) : raw;
  return paid ? bare : `${SPONSORED_PREFIX}${bare}`;
}

export interface InstallSpec {
  /** `npm` may be run for the user after a prompt. `script` is printed, never executed for them. */
  kind: 'npm' | 'script';
  command: string;
  note?: string;
}

/** A config file to merge into, addressed relative to the user's home directory. */
export interface ConfigPatch {
  /** Path segments under `$HOME`, e.g. `['.codex', 'config.toml']`. */
  segments: string[];
  format: 'json' | 'codex-toml';
  /** For `json`: the object to deep-merge. For `codex-toml`: unused, the block is fixed. */
  patch?: JsonObject;
  /** Printed when the file cannot be parsed, so the user can paste the block themselves. */
  label: string;
}

export interface LaunchPlan {
  id: string;
  /** The executable to look for on PATH. */
  bin: string;
  /**
   * The model id this launch will actually use — for the banner, and for nothing else.
   *
   * It lives on the plan rather than being read back out of `env`/`args` by the caller because
   * Codex's default is not the general default: a banner that reconstructed it would print the
   * sonnet id above a Codex session running gpt-5.1-codex, and a user reading that would have no way
   * to tell which of the two was lying.
   */
  model: string;
  /** Variables to set in the child. */
  env: Record<string, string>;
  /** Variables to REMOVE from the child's environment entirely. */
  unset: string[];
  /** Arguments to place before the user's own. */
  args: string[];
  configs: ConfigPatch[];
  /** Commands to run with the harness itself before launching, e.g. `openclaw config set`. */
  preCommands: string[][];
  install: InstallSpec | null;
  /** When set, this harness cannot be pointed at the pool and the CLI says so and stops. */
  unsupported: string | null;
}

export interface PlanContext {
  key: string;
  endpoints: Endpoints;
  /** Already resolved through `resolveModel` by the caller for the general case. */
  model: string;
  paid: boolean;
  /** The raw `--model` value, so a harness with its own default can resolve it differently. */
  modelOverride: string | null;
  /**
   * The default the POOL chose for this harness at this account's tier (`models.ts`), bare.
   *
   * Absent means "use the constant below", which is what `--paid` does: a tier is a limit on what
   * the pool will pay for and says nothing about what the caller may buy with their own credits.
   */
  tierModel?: string | null;
  /** Likewise for Claude Code's background model. */
  tierSmallModel?: string | null;
}

/**
 * The variables every harness and every `run` gets.
 *
 * All four families at once, because a harness may consult any of them and a variable a harness
 * ignores costs nothing. `ANTHROPIC_API_KEY` is the one we take AWAY: Claude Code sends it as
 * `x-api-key` and prefers it over `ANTHROPIC_AUTH_TOKEN`, so a user with a real Anthropic key in
 * their shell profile would otherwise send that key to our proxy and be billed by neither of us in
 * the way they expected.
 */
export function commonEnv(ctx: PlanContext): Record<string, string> {
  return {
    SPONSOREDTOKENS_API_KEY: ctx.key,
    OPENAI_BASE_URL: ctx.endpoints.proxyV1,
    OPENAI_API_KEY: ctx.key,
    OPENROUTER_BASE_URL: ctx.endpoints.proxyV1,
    OPENROUTER_API_KEY: ctx.key,
    ANTHROPIC_BASE_URL: ctx.endpoints.proxyApi,
    ANTHROPIC_AUTH_TOKEN: ctx.key,
  };
}

const COMMON_UNSET = ['ANTHROPIC_API_KEY'];

function base(id: string, bin: string, ctx: PlanContext): LaunchPlan {
  return {
    id,
    bin,
    model: ctx.model,
    env: commonEnv(ctx),
    unset: [...COMMON_UNSET],
    args: [],
    configs: [],
    preCommands: [],
    install: null,
    unsupported: null,
  };
}

/** The provider id used in every harness's own config, so one name identifies us everywhere. */
const PROVIDER_ID = 'sponsoredtokens';

type Builder = (ctx: PlanContext) => LaunchPlan;

const BUILDERS: Record<string, Builder> = {
  /**
   * Claude Code — env only. `ANTHROPIC_BASE_URL` stops one segment short of the others (`/api`, not
   * `/api/v1`) because Claude Code appends `/v1/messages` itself.
   * Docs: code.claude.com/docs/en/env-vars, /setup.
   */
  claude: (ctx) => {
    const plan = base('claude', 'claude', ctx);
    const small = resolveModel(ctx.tierSmallModel ?? DEFAULT_SMALL_MODEL, null, ctx.paid);
    plan.env.ANTHROPIC_MODEL = ctx.model;
    plan.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = small;
    // Deprecated but still read by older installs — see the header.
    plan.env.ANTHROPIC_SMALL_FAST_MODEL = small;
    // A `sponsored/…` id is not in Claude Code's own model catalogue, and recent versions print a
    // paragraph about that on every launch and cap the context at an assumed 200k. This is the
    // switch the same paragraph names for going back to letting the API say what the model is.
    plan.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = '1';
    plan.install = { kind: 'npm', command: 'npm install -g @anthropic-ai/claude-code' };
    return plan;
  },

  /**
   * Codex — a provider block on disk plus `-c` overrides at launch. `wire_api = "responses"` is the
   * only wire format current Codex supports, which is why the pool serves `/api/v1/responses`.
   * Docs: learn.chatgpt.com/docs/config-file/config-reference.
   */
  codex: (ctx) => {
    const plan = base('codex', 'codex', ctx);
    const model = resolveModel(ctx.tierModel ?? DEFAULT_CODEX_MODEL, ctx.modelOverride, ctx.paid);
    plan.model = model;
    plan.configs.push({ segments: ['.codex', 'config.toml'], format: 'codex-toml', label: '~/.codex/config.toml' });
    plan.args = ['-c', `model_provider=${CODEX_PROVIDER_ID}`, '-c', `model=${model}`];
    // The provider table on disk keeps the global base; a pinned launch overrides it for THIS run,
    // so `--region` never leaves a region written into a file that outlives the flag.
    if (ctx.endpoints.region) plan.args.push('-c', `model_providers.${CODEX_PROVIDER_ID}.base_url="${ctx.endpoints.proxyV1}"`);
    plan.install = { kind: 'npm', command: 'npm install -g @openai/codex' };
    return plan;
  },

  /**
   * OpenClaw — a provider under `models.providers`, merged by OpenClaw's OWN `config set --merge`.
   * Its config is JSON5 and may hold comments and trailing commas; letting the tool that owns the
   * format edit it is strictly safer than parsing JSON5 ourselves with no dependencies.
   * Docs: docs.openclaw.ai/gateway/configuration, /gateway/config-tools.
   */
  openclaw: (ctx) => {
    const plan = base('openclaw', 'openclaw', ctx);
    const provider = {
      baseUrl: ctx.endpoints.proxyV1,
      api: 'openai-completions',
      apiKey: { source: 'env', id: 'SPONSOREDTOKENS_API_KEY' },
      models: [{ id: ctx.model, name: 'sponsoredtokens', contextWindow: 200_000, maxTokens: 32_000 }],
    };
    plan.preCommands = [['config', 'set', `models.providers.${PROVIDER_ID}`, JSON.stringify(provider), '--strict-json', '--merge']];
    plan.install = { kind: 'npm', command: 'npm install -g openclaw@latest --allow-scripts=openclaw' };
    return plan;
  },

  /**
   * OpenCode — a provider block in `~/.config/opencode/opencode.json`.
   *
   * NOT `OPENCODE_CONFIG_CONTENT`, which is the tempting one-liner: it REPLACES the config rather
   * than adding to it, so a launch through this CLI would run with the user's own settings missing
   * and they would blame the harness. Merging into the file leaves every other setting in place.
   * Docs: opencode.ai/docs/providers, /docs/config.
   */
  opencode: (ctx) => {
    const plan = base('opencode', 'opencode', ctx);
    plan.configs.push({
      segments: ['.config', 'opencode', 'opencode.json'],
      format: 'json',
      label: '~/.config/opencode/opencode.json',
      patch: {
        $schema: 'https://opencode.ai/config.json',
        provider: {
          [PROVIDER_ID]: {
            npm: '@ai-sdk/openai-compatible',
            name: 'sponsoredtokens',
            options: { baseURL: ctx.endpoints.proxyV1, apiKey: '{env:SPONSOREDTOKENS_API_KEY}' },
            models: { [ctx.model]: { name: ctx.model } },
          },
        },
      },
    });
    plan.install = { kind: 'npm', command: 'npm install -g opencode-ai' };
    return plan;
  },

  /**
   * Kilo — an OpenCode fork, same config shape, at `~/.config/kilo/kilo.jsonc`. `{env:VAR}` only
   * resolves in trusted locations, and `~/.config/kilo` is one, which is why the block goes there
   * and not into a project file. `KILO_BASE_URL` is NOT documented — the docs give the
   * `KILO_<FIELD>` pattern with `KILO_API_KEY` as its only example — so the file is the wiring.
   * Docs: kilo.ai/docs/code-with-ai/platforms/cli.
   */
  kilo: (ctx) => {
    const plan = base('kilo', 'kilo', ctx);
    plan.env.KILO_PROVIDER = PROVIDER_ID;
    plan.env.KILO_API_KEY = ctx.key;
    plan.configs.push({
      segments: ['.config', 'kilo', 'kilo.jsonc'],
      format: 'json',
      label: '~/.config/kilo/kilo.jsonc',
      patch: {
        provider: {
          [PROVIDER_ID]: {
            npm: '@ai-sdk/openai-compatible',
            name: 'sponsoredtokens',
            options: { baseURL: ctx.endpoints.proxyV1, apiKey: '{env:SPONSOREDTOKENS_API_KEY}' },
            models: { [ctx.model]: { name: ctx.model } },
          },
        },
        model: `${PROVIDER_ID}/${ctx.model}`,
      },
    });
    plan.install = { kind: 'npm', command: 'npm install -g @kilocode/cli' };
    return plan;
  },

  /**
   * pi — `~/.pi/agent/models.json`, plain JSON, `$VAR` interpolation in `apiKey`.
   * Docs: github.com/earendil-works/pi, packages/coding-agent/docs/models.md.
   */
  pi: (ctx) => {
    const plan = base('pi', 'pi', ctx);
    plan.configs.push({
      segments: ['.pi', 'agent', 'models.json'],
      format: 'json',
      label: '~/.pi/agent/models.json',
      patch: {
        providers: {
          [PROVIDER_ID]: {
            baseUrl: ctx.endpoints.proxyV1,
            api: 'openai-completions',
            apiKey: '$SPONSOREDTOKENS_API_KEY',
            models: [{ id: ctx.model }],
          },
        },
      },
    });
    plan.install = { kind: 'npm', command: 'npm install -g @earendil-works/pi-coding-agent' };
    return plan;
  },

  /**
   * Hermes — env only, and the precedence is in its own source
   * (`explicit > CUSTOM_BASE_URL > model.base_url > OPENROUTER_BASE_URL > default`), so
   * `CUSTOM_BASE_URL` wins over anything in the user's config without editing it.
   *
   * Distributed by an install script, not npm: the `hermes-agent` package on npm describes itself as
   * an unofficial bridge, and installing a stranger's package because it has the right name is not
   * a thing this CLI will do on a user's behalf.
   * Docs: github.com/NousResearch/hermes-agent, website/docs/integrations/providers.md.
   */
  hermes: (ctx) => {
    const plan = base('hermes', 'hermes', ctx);
    plan.env.CUSTOM_BASE_URL = ctx.endpoints.proxyV1;
    plan.install = {
      kind: 'script',
      command: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
      note: 'Hermes is not published on npm by Nous Research; the `hermes-agent` npm package is an unofficial bridge.',
    };
    return plan;
  },

  /**
   * Junie — env only, through its LiteLLM provider, which is exactly an OpenAI-compatible endpoint.
   * The per-model JSON file form exists too and wants the FULL endpoint path in `baseUrl`; the env
   * route needs no file at all, so it is the one used.
   * Docs: junie.jetbrains.com/docs/environment-variables.html, /docs/custom-llm-models.html.
   */
  junie: (ctx) => {
    const plan = base('junie', 'junie', ctx);
    plan.env.JUNIE_LLM_PROVIDER = 'litellm';
    plan.env.JUNIE_LITELLM_URL = ctx.endpoints.proxyV1;
    plan.env.JUNIE_LITELLM_API_KEY = ctx.key;
    plan.env.JUNIE_MODEL = ctx.model;
    plan.install = { kind: 'npm', command: 'npm install -g @jetbrains/junie-cli' };
    return plan;
  },

  /**
   * Cursor CLI — REFUSED, by name. `CURSOR_API_KEY` authenticates to Cursor's own backend and
   * `--endpoint` chooses which Cursor backend that is; there is no OpenAI-compatible base URL.
   * Docs: cursor.com/docs/cli/reference/authentication, /configuration.
   */
  cursor: (ctx) => {
    const plan = base('cursor', 'agent', ctx);
    plan.unsupported =
      'Cursor CLI has no custom-endpoint setting — CURSOR_API_KEY authenticates to Cursor itself, so it cannot be pointed at the pool.\n' +
      'See https://cursor.com/docs/cli/reference/authentication. Use `sponsoredtokens claude` or `sponsoredtokens codex` instead.';
    return plan;
  },

  /**
   * T3 Code — a wrapper, not a harness: it launches Claude Code, Codex and friends for you. Its own
   * docs show `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (and an emptied `ANTHROPIC_API_KEY`) as
   * the way to route the Claude Code it spawns at a non-Anthropic host, which is precisely the
   * environment this CLI already exports — so launching `t3` from here hands its children the
   * pool. Whether they inherit it depends on how the user configured that provider instance, so the
   * caller prints a line saying so.
   * Docs: github.com/pingdotgg/t3code, docs/user/providers-claude.md.
   */
  t3: (ctx) => {
    const plan = base('t3', 't3', ctx);
    const small = resolveModel(ctx.tierSmallModel ?? DEFAULT_SMALL_MODEL, null, ctx.paid);
    plan.env.ANTHROPIC_MODEL = ctx.model;
    plan.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = small;
    plan.env.ANTHROPIC_SMALL_FAST_MODEL = small;
    // A `sponsored/…` id is not in Claude Code's own model catalogue, and recent versions print a
    // paragraph about that on every launch and cap the context at an assumed 200k. This is the
    // switch the same paragraph names for going back to letting the API say what the model is.
    plan.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = '1';
    plan.install = { kind: 'npm', command: 'npm install -g t3' };
    return plan;
  },
};

/** Every harness the CLI knows, in the order `--help` lists them. */
export const HARNESS_IDS: readonly string[] = ['claude', 'codex', 'openclaw', 'opencode', 'pi', 'kilo', 'hermes', 'junie', 'cursor', 't3'];

export function isHarness(id: string): boolean {
  return Object.hasOwn(BUILDERS, id);
}

/** The plan for a harness, or null when the id is not one of ours. */
export function planFor(id: string, ctx: PlanContext): LaunchPlan | null {
  const build = BUILDERS[id];
  return build ? build(ctx) : null;
}

/** `run <cmd…>`: the common variables and nothing harness-specific. */
export function planForRun(ctx: PlanContext, command: string): LaunchPlan {
  return base('run', command, ctx);
}
