/**
 * The addresses (src/endpoints.ts): the global pair the CLI itself calls, and the pair a harness is
 * handed, which gains a region segment when the launch is pinned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpoints, parseRegion } from '../src/endpoints.ts';

test('unpinned, the harness gets the same base the CLI uses', () => {
  const ep = endpoints({} as NodeJS.ProcessEnv);
  assert.equal(ep.region, null);
  assert.equal(ep.proxyApi, 'https://sponsoredtokens.com/api');
  assert.equal(ep.proxyV1, 'https://sponsoredtokens.com/api/v1');
});

test('pinned, the region sits before v1 — and the CLI\'s own routes never move', () => {
  const ep = endpoints({} as NodeJS.ProcessEnv, 'eu');
  assert.equal(ep.proxyApi, 'https://sponsoredtokens.com/api/eu');
  assert.equal(ep.proxyV1, 'https://sponsoredtokens.com/api/eu/v1');
  assert.equal(ep.api, 'https://sponsoredtokens.com/api');
  assert.equal(ep.v1, 'https://sponsoredtokens.com/api/v1');
});

test('SPONSOREDTOKENS_REGION is the flag\'s environment twin, and nonsense is the global pool', () => {
  assert.equal(endpoints({ SPONSOREDTOKENS_REGION: 'US' } as NodeJS.ProcessEnv).region, 'us');
  assert.equal(endpoints({ SPONSOREDTOKENS_REGION: 'moon' } as NodeJS.ProcessEnv).region, null);
  assert.equal(parseRegion(' eu '), 'eu');
  assert.equal(parseRegion(undefined), null);
});
