// Failure reasons from outside services (WhatsApp gateway, Geidea, Google, rentcar)
// can echo request data back — a phone number, or the message text that contains an
// OTP. Logs get only the leading segment ("HTTP 401", "fetch failed", "This operation
// was aborted"), never the response body that follows the first colon.
export function errorReason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split(':')[0].trim().slice(0, 120) || 'unknown';
}

// Enough to tell two customers apart in support, not enough to identify one.
export function maskPhone(phone: string): string {
  return phone.length > 4 ? `${phone.slice(0, 4)}•••${phone.slice(-2)}` : '•••';
}
