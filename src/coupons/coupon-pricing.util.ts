import { round2 } from '../bookings/pricing.util';

// Mirrors rentcar's lib/coupon-code.ts discount math and lib/discount-scope.ts
// scoping exactly, so a code behaves identically whether it's entered on the
// website or in the app — including on monthly bookings.
export type CouponKind = 'PERCENT' | 'FIXED';
export type CouponScope = 'RENTAL_ONLY' | 'FULL_TOTAL';
export type CouponAppliesTo = 'DAILY_ONLY' | 'MONTHLY_ONLY' | 'DAILY_AND_MONTHLY';
export type RentalPeriodKind = 'daily' | 'monthly';

/** هل يسري الخصم على نوع التأجير المطلوب؟ الافتراضي عند غياب النوع = يومي. */
export function discountAppliesToPeriod(
  appliesTo: CouponAppliesTo,
  periodKind: RentalPeriodKind | null | undefined,
): boolean {
  if (appliesTo === 'DAILY_AND_MONTHLY') return true;
  return (periodKind ?? 'daily') === 'monthly' ? appliesTo === 'MONTHLY_ONLY' : appliesTo === 'DAILY_ONLY';
}

/**
 * خصم كوبون `RENTAL_ONLY` على مبلغ الفترة.
 *
 * - `daily`: المبلغ الممرَّر هو سعر اليوم، فالخصم يُحسب لليوم ثم يُضرب في الأيام
 *   عند النداء — سلوك غير متغيّر عن السابق.
 * - `monthly`: يُحسب على **إجمالي الشهر** لتفادي خسارة الكسور عند القسمة على
 *   الأيام والتقريب لريال كامل.
 *
 * ملاحظة: `FIXED` في الكوبون مبلغ ثابت (مش يومي)، فيُطرح مرة واحدة من إجمالي
 * الشهر — بينما في اليومي يُطرح من سعر اليوم، تماماً كما في rentcar.
 */
export function computeCouponDiscountForPeriod(
  basePeriodAmountExclTax: number,
  kind: CouponKind,
  value: number,
  periodKind: RentalPeriodKind,
): { discountedAmountExclTax: number; discountAmountExclTax: number } {
  if (periodKind !== 'monthly') {
    // التقريب لريال كامل على سعر اليوم — نفس computeCouponDiscountPerDay.
    const base = Math.max(0, Math.round(basePeriodAmountExclTax));
    if (base <= 0) return { discountedAmountExclTax: 0, discountAmountExclTax: 0 };
    const savings =
      kind === 'PERCENT'
        ? Math.round((base * Math.min(100, Math.max(1, Math.round(value)))) / 100)
        : Math.min(base, Math.max(0, Math.round(value)));
    return { discountedAmountExclTax: base - savings, discountAmountExclTax: savings };
  }

  const base = Math.max(0, basePeriodAmountExclTax);
  if (base <= 0) return { discountedAmountExclTax: 0, discountAmountExclTax: 0 };

  const savings =
    kind === 'PERCENT'
      ? round2((base * Math.min(100, Math.max(1, Math.round(value)))) / 100)
      : Math.min(base, Math.max(0, Math.round(value)));

  return { discountedAmountExclTax: round2(base - savings), discountAmountExclTax: savings };
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
