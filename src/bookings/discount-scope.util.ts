/**
 * نطاق الخصم بحسب نوع التأجير — مشترك بين `RentalDiscount` و`CouponCode`
 * عشان القاعدتين ما يفترقوش مع الوقت. منقول عن rentcar's lib/discount-scope.ts.
 */
export type DiscountAppliesTo = 'DAILY_ONLY' | 'MONTHLY_ONLY' | 'DAILY_AND_MONTHLY';
export type RentalPeriodKind = 'daily' | 'monthly';

/** هل يسري الخصم على نوع التأجير المطلوب؟ الافتراضي عند غياب النوع = يومي. */
export function discountAppliesToPeriod(
  appliesTo: DiscountAppliesTo,
  periodKind: RentalPeriodKind | null | undefined,
): boolean {
  if (appliesTo === 'DAILY_AND_MONTHLY') return true;
  return (periodKind ?? 'daily') === 'monthly' ? appliesTo === 'MONTHLY_ONLY' : appliesTo === 'DAILY_ONLY';
}
