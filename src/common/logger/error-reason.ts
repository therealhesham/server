// Failure reasons from outside services (WhatsApp gateway, Geidea, Google, rentcar)
// can echo request data back — a phone number, or the message text that contains an
// OTP. Logs get only the leading segment ("HTTP 401", "fetch failed", "This operation
// was aborted"), never the response body that follows the first colon.
function leadingSegment(msg: string): string {
  return msg.split(':')[0].trim().slice(0, 120) || 'unknown';
}

function errorCode(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e && typeof e.code === 'string') return e.code;
  return '';
}

function errorCause(e: unknown): unknown {
  if (e && typeof e === 'object' && 'cause' in e) return e.cause;
  return undefined;
}

export function errorReason(e: unknown): string {
  const head = leadingSegment(e instanceof Error ? e.message : String(e));
  const cause = errorCause(e);
  const extra = [errorCode(e), errorCode(cause), cause instanceof Error ? leadingSegment(cause.message) : '']
    .filter(Boolean)
    .filter((part, i, all) => part !== head && all.indexOf(part) === i)
    .join(' ');
  return (extra ? `${head} (${extra})` : head).slice(0, 120);
}

// Enough to tell two customers apart in support, not enough to identify one.
export function maskPhone(phone: string): string {
  return phone.length > 4 ? `${phone.slice(0, 4)}•••${phone.slice(-2)}` : '•••';
}
