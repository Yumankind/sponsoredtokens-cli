/**
 * The three worker calls this CLI makes, and nothing else.
 *
 * `fetch` is a Node built-in from 20 and a Bun built-in always, so this file has no dependencies and
 * the compiled binary carries no HTTP client. Every response is treated as untrusted shape — the
 * worker is ours, but a captive-portal login page, a corporate proxy's error document and a 502 from
 * the edge all arrive here as "a response", and the difference between a clear message and a
 * `TypeError: undefined is not an object` is entirely in whether this file checks.
 */
import type { Endpoints } from './endpoints.ts';
import { VERSION } from './version.ts';

/** Sent on every call so the worker's logs can tell a CLI login from a browser one. */
export const USER_AGENT = `sponsoredtokens-cli/${VERSION}`;

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  /** Seconds between polls, chosen by the server so we can slow it down without shipping a CLI. */
  interval: number;
  expiresIn: number;
}

export type DevicePoll =
  | { status: 'pending' }
  | { status: 'approved'; token: string; keyId: string; rotated: boolean }
  | { status: 'expired' };

/** An error whose message is meant to be printed to a terminal as-is. */
export class ApiError extends Error {}

async function readJson(res: Response, what: string): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // The body is the most useful thing we have when this happens, but it can be a whole HTML page.
    throw new ApiError(`${what} returned ${res.status} and something that is not JSON: ${text.slice(0, 200)}`);
  }
}

export async function startDevice(ep: Endpoints): Promise<DeviceStart> {
  const res = await fetch(`${ep.api}/cli/device`, { method: 'POST', headers: { 'user-agent': USER_AGENT } });
  const body = (await readJson(res, 'Starting the login')) as Partial<DeviceStart> & { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? `Starting the login failed (${res.status}).`);
  if (!body.deviceCode || !body.userCode || !body.verifyUrl) throw new ApiError('The server did not return a login code.');
  return {
    deviceCode: body.deviceCode,
    userCode: body.userCode,
    verifyUrl: body.verifyUrl,
    interval: typeof body.interval === 'number' && body.interval > 0 ? body.interval : 5,
    expiresIn: typeof body.expiresIn === 'number' && body.expiresIn > 0 ? body.expiresIn : 600,
  };
}

export async function pollDevice(ep: Endpoints, deviceCode: string): Promise<DevicePoll> {
  const res = await fetch(`${ep.api}/cli/device/${encodeURIComponent(deviceCode)}`, { headers: { 'user-agent': USER_AGENT } });
  // A transient 5xx must NOT end the login — the user is mid-browser-flow and would have to start
  // over for a blip at the edge. Treat it as "not yet" and let the poll loop's deadline decide.
  if (res.status >= 500) return { status: 'pending' };
  const body = (await readJson(res, 'Checking the login')) as { status?: string; token?: string; keyId?: string; rotated?: boolean };
  if (body.status === 'approved' && typeof body.token === 'string' && body.token) {
    return { status: 'approved', token: body.token, keyId: typeof body.keyId === 'string' ? body.keyId : '', rotated: body.rotated === true };
  }
  if (body.status === 'pending') return { status: 'pending' };
  return { status: 'expired' };
}

export interface AccountStatus {
  budget?: { remainingCents?: number; weeklyCents?: number; resetsAt?: string };
  user?: { tier?: number | string; referralLink?: string };
  [key: string]: unknown;
}

/**
 * `GET /api/account/me`.
 *
 * The shape is the account API's (Wave 2 A) and every field is read defensively: `status` is a
 * convenience, and a CLI that crashes because the API grew a field is worse than one that prints the
 * three numbers it recognised.
 */
export async function fetchStatus(ep: Endpoints, token: string): Promise<AccountStatus> {
  const res = await fetch(`${ep.api}/account/me`, { headers: { authorization: `Bearer ${token}`, 'user-agent': USER_AGENT } });
  if (res.status === 401 || res.status === 403) {
    throw new ApiError('That key was not accepted. Run `sponsoredtokens login` again.');
  }
  const body = (await readJson(res, 'Reading your account')) as AccountStatus & { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? `Reading your account failed (${res.status}).`);
  return body;
}

// Money formatting lives in `ui.ts` (`money`), with the rest of the presentation.
