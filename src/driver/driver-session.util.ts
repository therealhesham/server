import { createHmac, timingSafeEqual } from 'crypto';

// Driver session token: HMAC-signed { did, role, exp }, carried as a Bearer token.
//
// Deliberately NOT interchangeable with the customer token in auth/session.util.ts:
//   - its own secret (DRIVER_SESSION_SECRET), so a customer token can never verify here
//     and a driver token can never verify there;
//   - a different payload shape (`did` + `role: 'driver'`, no `uid`), so even a shared
//     secret by misconfiguration would not let one kind pass as the other.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ROLE = 'driver';

function getSecret(): string {
  const secret = process.env.DRIVER_SESSION_SECRET;
  if (!secret) throw new Error('DRIVER_SESSION_SECRET must be set');
  return secret;
}

export function signDriverToken(driverId: number): string {
  const payload = JSON.stringify({ did: driverId, role: ROLE, exp: Date.now() + SESSION_TTL_MS });
  const sig = createHmac('sha256', getSecret()).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

export function verifyDriverToken(token: string): number | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;

  let payload: string;
  try {
    payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const expected = createHmac('sha256', getSecret()).update(payload).digest('hex');
  try {
    const a = Buffer.from(token.slice(dot + 1), 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const { did, role, exp } = parsed as { did?: unknown; role?: unknown; exp?: unknown };
  if (role !== ROLE) return null;
  if (typeof exp !== 'number' || exp <= Date.now()) return null;
  if (typeof did !== 'number' || !Number.isInteger(did) || did < 1) return null;
  return did;
}
