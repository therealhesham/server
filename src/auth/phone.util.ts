// Mirrors rentcar's lib/normalize-saudi-phone.ts exactly — same storage
// format (+9665XXXXXXXX) so a phone typed in this app matches the same
// User.phone rows rentcar's own checkout/admin tools already read.
export function saudiLocalNineToE164(localDigits: string): string | null {
  const d = localDigits.replace(/\D/g, '');
  if (!/^5\d{8}$/.test(d)) return null;
  return `+966${d}`;
}

export function e164ToLocalNine(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const p = stored.replace(/\s/g, '').trim();
  if (p.startsWith('+966')) {
    const rest = p.slice(4).replace(/\D/g, '');
    if (/^5\d{8}$/.test(rest)) return rest;
    return null;
  }
  const digits = p.replace(/\D/g, '');
  if (digits.startsWith('966') && digits.length === 12) {
    const rest = digits.slice(3);
    if (/^5\d{8}$/.test(rest)) return rest;
  }
  if (/^5\d{8}$/.test(digits)) return digits;
  return null;
}

export function e164ToEvolutionWhatsAppNumber(storedE164: string): string | null {
  const nine = e164ToLocalNine(storedE164);
  if (!nine) return null;
  return `966${nine}`;
}
