// Mirrors lib/kyc-validation.ts (same regex, same digit-prefix rules) so a
// submission that passes the Expo app's client-side check can't slip past
// the server with a malformed id/license number. Duplicated here because
// this NestJS project doesn't share a module graph with the app's lib/.

export interface KycInput {
  idKind: 'citizen' | 'resident' | 'visitor';
  nationalIdNumber?: string | null;
  passportNumber?: string | null;
  licenseNumber: string;
}

export function validateNationalId(digits: string): { valid: boolean; error?: string } {
  if (!/^\d{10}$/.test(digits)) {
    return { valid: false, error: 'رقم الهوية أو الإقامة يجب أن يكون ١٠ أرقام.' };
  }
  if (!digits.startsWith('1') && !digits.startsWith('2')) {
    return { valid: false, error: 'يبدأ بـ ١ للمواطن أو ٢ للمقيم.' };
  }
  return { valid: true };
}

export function validatePassport(value: string): { valid: boolean; error?: string } {
  const v = value.trim().toUpperCase();
  if (v.length < 6 || v.length > 24) {
    return { valid: false, error: 'رقم الجواز يجب أن يكون بين ٦ و٢٤ حرفاً.' };
  }
  if (!/^[A-Z0-9-]+$/.test(v)) {
    return { valid: false, error: 'أحرف إنجليزية وأرقام وشرطة فقط.' };
  }
  return { valid: true };
}

export function validateLicenseNumber(digits: string): { valid: boolean; error?: string } {
  if (!/^\d{10}$/.test(digits)) {
    return { valid: false, error: 'رقم رخصة القيادة يجب أن يكون ١٠ أرقام.' };
  }
  return { valid: true };
}

// Cross-checks idKind against the right document number, including the
// citizen=1/resident=2 prefix rule detectIdKindFromNationalId enforces
// client-side — a mismatched idKind/number pair must not reach a booking.
export function validateKyc(kyc: KycInput): { valid: boolean; error?: string } {
  if (kyc.idKind === 'visitor') {
    if (!kyc.passportNumber) return { valid: false, error: 'رقم الجواز مطلوب.' };
    const passport = validatePassport(kyc.passportNumber);
    if (!passport.valid) return passport;
  } else {
    if (!kyc.nationalIdNumber) return { valid: false, error: 'رقم الهوية أو الإقامة مطلوب.' };
    const nationalId = validateNationalId(kyc.nationalIdNumber);
    if (!nationalId.valid) return nationalId;
    const expectedPrefix = kyc.idKind === 'citizen' ? '1' : '2';
    if (!kyc.nationalIdNumber.startsWith(expectedPrefix)) {
      return { valid: false, error: 'نوع الهوية المُدخل لا يطابق رقم الهوية.' };
    }
  }

  const license = validateLicenseNumber(kyc.licenseNumber);
  if (!license.valid) return license;

  return { valid: true };
}
