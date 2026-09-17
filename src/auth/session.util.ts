import { createHmac, timingSafeEqual } from 'crypto';

// Same HMAC-signed { uid, exp } token shape as rentcar's lib/customer-auth.ts
// (signCustomerSession/getCustomerSessionUserId), just carried as a Bearer
// token instead of an httpOnly cookie since the app has no browser to hold one.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function getSecret(): string {
  const secret = process.env.CUSTOMER_SESSION_SECRET;
  if (!secret) throw new Error('CUSTOMER_SESSION_SECRET must be set');
  return secret;
}

export function signSessionToken(userId: number): string {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = JSON.stringify({ uid: userId, exp });
  const sig = createHmac('sha256', getSecret()).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

export function verifySessionToken(token: string): number | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const payloadPart = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let payload: string;
  try {
    payload = Buffer.from(payloadPart, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const expected = createHmac('sha256', getSecret()).update(payload).digest('hex');
  try {
    const a = Buffer.from(sig, 'hex');
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
  const { uid, exp } = parsed as { uid?: unknown; exp?: unknown };
  if (typeof exp !== 'number' || exp <= Date.now()) return null;
  if (typeof uid !== 'number' || !Number.isInteger(uid) || uid < 1) return null;
  return uid;
}
