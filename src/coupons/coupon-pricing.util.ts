import { round2 } from '../bookings/pricing.util';

// Mirrors rentcar's lib/coupon-code.ts discount math exactly. This app has
// no distinct "monthly flat-rate" booking (see the weekly/monthly period
// work — pricing is always dailyRate × days regardless of period), so every
// booking here is treated as the "DAILY" period for appliesTo purposes; a
// MONTHLY_ONLY coupon simply never matches anything in this app.
export type CouponKind = 'PERCENT' | 'FIXED';
export type CouponScope = 'RENTAL_ONLY' | 'FULL_TOTAL';
export type CouponAppliesTo = 'DAILY_ONLY' | 'MONTHLY_ONLY' | 'DAILY_AND_MONTHLY';

export function couponAppliesToDaily(appliesTo: CouponAppliesTo): boolean {
  return appliesTo === 'DAILY_ONLY' || appliesTo === 'DAILY_AND_MONTHLY';
}

// RENTAL_ONLY — discount applied per day to the daily rate, then × days.
export function computeCouponDiscountOnRental(dailyRate: number, days: number, kind: CouponKind, value: number): number {
  const base = Math.max(0, Math.round(dailyRate));
  if (base <= 0) return 0;
  const savingsPerDay = kind === 'PERCENT' ? Math.round((base * Math.min(100, Math.max(1, Math.round(value)))) / 100) : Math.min(base, Math.max(0, Math.round(value)));
  return round2(savingsPerDay * days);
}

// FULL_TOTAL — discount applied once to the whole pre-VAT subtotal (rental + extras + delivery).
export function computeCouponDiscountOnSubtotal(subtotalExclTax: number, kind: CouponKind, value: number): number {
  const sub = Math.max(0, subtotalExclTax);
  if (sub <= 0) return 0;
  if (kind === 'PERCENT') {
    const pct = Math.min(100, Math.max(1, Math.round(value)));
    return round2((sub * pct) / 100);
  }
  return round2(Math.min(sub, Math.max(0, Math.round(value))));
}

export function buildCouponDiscountLabelAr(kind: CouponKind, value: number, savingsAmountSar: number): string {
  if (savingsAmountSar <= 0) return '';
  if (kind === 'PERCENT') {
    const pct = Math.min(100, Math.max(1, Math.round(value)));
    return `خصم ${pct}٪`;
  }
  return `وفّرت ${savingsAmountSar} ر.س`;
}
