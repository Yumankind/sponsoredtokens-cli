/**
 * `src/api.ts`'s account read — the call behind `sponsoredtokens status`.
 *
 * ── THE BUG THIS FILE EXISTS FOR (0.3.6) ────────────────────────────────────────────────────────
 *
 * `login` saves an `sk-st-` API key and nothing else — this CLI holds no session and has no way to
 * make one — and `status` then sends that key to `GET /api/account/me` as a Bearer. The worker
 * refused API keys on every account route by design, so the very next command after a successful
 * login answered *"That key was not accepted. Run `sponsoredtokens login` again."*, and running
 * login again produced another key that was refused in exactly the same way.
 *
 * The fix is the worker's (`{ allowApiKey: 'read' }` on that one route, `worker/src/sponsored/
 * account-auth.ts`). What is pinned HERE is this side of the contract: the header this CLI sends,
 * the body shape it reads back, and the fact that a 401 still produces that sentence — because for
 * a REVOKED key it is the correct sentence, and it must not disappear along with the bug.
 *
 * The body below is the worker's `SponsoredAccountMe`, field for field, as a caller holding an API
 * key receives it: `user.recoveryEmail` is NULL AND PRESENT, because the recovery address is the
 * account's takeover path and a key may not read it, while the shape stays the site's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, USER_AGENT, fetchStatus } from '../src/api.ts';
import { endpoints } from '../src/endpoints.ts';
import { listTokens } from '../src/tokens.ts';

const EP = endpoints({} as NodeJS.ProcessEnv);
const KEY = `sk-st-K3STabcd1234.${'a'.repeat(43)}`;

/** `GET /api/account/me` for an account with one referral and a key, as the worker answers it. */
const ME = {
  user: {
    id: 'uid_alice',
    email: 'alice@example.com',
    referralCode: 'K3ST',
    referralCount: 1,
    referralLink: 'https://sponsoredtokens.com/r/K3ST',
    tier: 0,
    status: 'active',
    createdAt: '2026-09-01T00:00:00.000Z',
    recoveryEmail: null,
  },
  budget: {
    weeklyCents: 2_500,
    usedCents: 625,
    remainingCents: 1_875,
    resetsAt: '2026-09-08T00:00:00.000Z',
    dailyCapCents: null,
    globalCapOn: false,
  },
  credits: { balanceCents: 0 },
  key: { keyId: 'K3STabcd1234', createdAt: '2026-09-01T00:00:00.000Z', rotatedAt: null },
  unlock: { tier: 1, referralsNeeded: 1, exampleModels: ['anthropic/claude-sonnet-5'] },
  lifetimeSpentCents: 625,
};

/** Swap `fetch` for one call, record what it was asked, and always put the real one back. */
async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ── The request ───────────────────────────────────────────────────────────────────────────────

test('the key goes in the Authorization header, to /api/account/me, with the CLI’s user-agent', async () => {
  let seen: { url: string; headers: Record<string, string> } | null = null;
  await withFetch(
    async (input, init) => {
      seen = { url: String(input), headers: (init?.headers ?? {}) as Record<string, string> };
      return json(ME);
    },
    () => fetchStatus(EP, KEY),
  );
  const call = seen as unknown as { url: string; headers: Record<string, string> };
  assert.equal(call.url, 'https://sponsoredtokens.com/api/account/me');
  assert.equal(call.headers.authorization, `Bearer ${KEY}`);
  assert.equal(call.headers['user-agent'], USER_AGENT);
});

// ── The body ──────────────────────────────────────────────────────────────────────────────────

test('the worker’s `me` body comes back whole, and `status` reads its three numbers off it', async () => {
  const account = await withFetch(async () => json(ME), () => fetchStatus(EP, KEY));
  assert.deepEqual(account, ME);

  // The four things `status` prints from this body, read exactly as `index.ts` reads them.
  assert.equal(account.budget?.remainingCents, 1_875);
  assert.equal(account.budget?.weeklyCents, 2_500);
  assert.equal(account.budget?.resetsAt, '2026-09-08T00:00:00.000Z');
  assert.equal(account.user?.tier, 0);
  assert.equal(account.user?.referralLink, 'https://sponsoredtokens.com/r/K3ST');
  // …and the size that remainder buys, which is the token figure on the Budget line.
  assert.equal(listTokens(account.budget!.remainingCents!), '781K');
});

test('a body that grew a field is still read — the CLI takes what it knows and prints that', async () => {
  const account = await withFetch(
    async () => json({ ...ME, somethingWaveThree: { added: true }, user: { ...ME.user, newField: 7 } }),
    () => fetchStatus(EP, KEY),
  );
  assert.equal(account.budget?.remainingCents, 1_875);
  assert.equal(account.user?.referralLink, 'https://sponsoredtokens.com/r/K3ST');
});

test('a body with no budget at all is not a crash — `status` simply says less', async () => {
  const account = await withFetch(async () => json({ user: { tier: 2 } }), () => fetchStatus(EP, KEY));
  assert.equal(account.budget, undefined);
  assert.equal(account.user?.tier, 2);
});

// ── The refusals ──────────────────────────────────────────────────────────────────────────────

test('a 401 or a 403 is the one sentence a person can act on', async () => {
  for (const status of [401, 403]) {
    await assert.rejects(
      withFetch(async () => json({ error: 'nope', code: 'unauthorized' }, status), () => fetchStatus(EP, KEY)),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.message, 'That key was not accepted. Run `sponsoredtokens login` again.');
        return true;
      },
      `${status} should say what to do`,
    );
  }
});

test('any other failure carries the worker’s own message, not ours', async () => {
  await assert.rejects(
    withFetch(async () => json({ error: 'No sponsoredtokens account yet — complete sign-in first.', code: 'no_account' }, 404), () =>
      fetchStatus(EP, KEY),
    ),
    { message: 'No sponsoredtokens account yet — complete sign-in first.' },
  );
  // A named 503 from the worker reads through too, rather than being flattened to a status code.
  await assert.rejects(
    withFetch(async () => json({ error: 'SPONSORED_DB is not set', code: 'not_configured' }, 503), () => fetchStatus(EP, KEY)),
    { message: 'SPONSORED_DB is not set' },
  );
});

test('a captive portal’s HTML is named as such, and truncated, rather than thrown as a TypeError', async () => {
  await assert.rejects(
    withFetch(async () => new Response('<html><body>Sign in to the hotel wifi</body></html>', { status: 200 }), () => fetchStatus(EP, KEY)),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.match(err.message, /^Reading your account returned 200 and something that is not JSON: <html>/);
      return true;
    },
  );
});
