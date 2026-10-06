/**
 * الحد الأدنى للسعر (دون ضريبة) — يمنع أكواد الخصم من إنزال سعر الإيجار تحت
 * أرضية محدَّدة إدارياً. منقول عن rentcar's lib/min-price-floor.ts.
 *
 * الفرق الوحيد عن الأصل: rentcar تقسم الأرضية الشهرية على الأيام لأن
 * `computeCheckoutTotals` عندها تشتغل بسعر يومي × أيام. هنا الحساب يتم على
 * مبلغ الفترة مباشرة، فالمقارنة تتم على الإجمالي بلا قسمة ولا ضرب — نفس
 * القاعدة بالضبط وبدقة أعلى (القسمة ثم التقريب لهللتين كانت تضيّع فروقاً
 * على مدى شهر).
 */
import { round2 } from './pricing.util';

export interface ResolvedPriceFloor {
  minPricePerDayExclTax: number | null;
  /** أرضية **إجمالي** الشهر (مش لليوم) — تُقارَن بإجمالي الإيجار الشهري. */
  minPriceMonthlyExclTax: number | null;
}

export const NO_PRICE_FLOOR: ResolvedPriceFloor = {
  minPricePerDayExclTax: null,
  minPriceMonthlyExclTax: null,
};

export interface PriceFloorOutcome {
  /** مبلغ الفترة النهائي بعد احترام الأرضية (دون ضريبة). */
  finalPeriodAmountExclTax: number;
  /** أرضية الفترة كاملة — null = بلا حد. */
  floorPeriodAmountExclTax: number | null;
  /** true = الأرضية ألغت جزءاً من الخصم فعلياً. */
  floorApplied: boolean;
  /** المبلغ المحجوب من الخصم بسبب الأرضية (دون ضريبة). */
  withheldDiscountExclTax: number;
}

/**
 * الأرضية بوحدة «مبلغ الفترة» المستخدمة في الحساب: سعر اليوم لليومي، وإجمالي
 * الشهر للشهري — فتُقارَن مباشرةً بـ `basePeriodAmount` بلا قسمة ولا ضرب.
 */
export function floorForPeriodAmount(
  floor: ResolvedPriceFloor,
  rentalPeriodKind: 'daily' | 'monthly',
): number | null {
  return rentalPeriodKind === 'monthly' ? floor.minPriceMonthlyExclTax : floor.minPricePerDayExclTax;
}

/** أرضية الفترة كاملة: الشهرية إجمالٌ جاهز، واليومية تُضرب في عدد الأيام. */
export function resolveFloorForPeriod(
  floor: ResolvedPriceFloor,
  rentalPeriodKind: 'daily' | 'monthly',
  numberOfDays: number,
): number | null {
  if (rentalPeriodKind === 'monthly') return floor.minPriceMonthlyExclTax;
  if (floor.minPricePerDayExclTax == null) return null;
  return floor.minPricePerDayExclTax * Math.max(1, Math.round(numberOfDays));
}

/**
 * يطبّق الأرضية على مبلغ الفترة بعد الخصم.
 *
 * المعادلة: `final = min(base, max(discounted, floor))`
 *
 * الحد الأعلى بـ `base` مقصود: لو الأرضية أعلى من السعر الأساسي (سوء إعداد)
 * فرفع السعر فوق المعلن للعميل خطأ أفدح من تجاهل الأرضية — نُبقي السعر الأساسي.
 */
export function applyPriceFloorToPeriodAmount(
  discountedPeriodAmountExclTax: number,
  basePeriodAmountExclTax: number,
  floorPeriodAmountExclTax: number | null,
): PriceFloorOutcome {
  const base = Math.max(0, basePeriodAmountExclTax);
  const discounted = Math.max(0, discountedPeriodAmountExclTax);

  if (floorPeriodAmountExclTax == null || floorPeriodAmountExclTax <= 0) {
    return {
      finalPeriodAmountExclTax: round2(discounted),
      floorPeriodAmountExclTax: null,
      floorApplied: false,
      withheldDiscountExclTax: 0,
    };
  }

  const final = Math.min(base, Math.max(discounted, floorPeriodAmountExclTax));
  // الأرضية «طبَّقت» فقط لو رفعت السعر فعلياً فوق سعر ما بعد الخصم.
  const floorApplied = final > discounted;

  return {
    finalPeriodAmountExclTax: round2(final),
    floorPeriodAmountExclTax: round2(floorPeriodAmountExclTax),
    floorApplied,
    withheldDiscountExclTax: floorApplied ? round2(final - discounted) : 0,
  };
}

/**
 * سقف خصم كوبون `FULL_TOTAL` بحيث لا ينزل المتبقي تحت أرضية الإيجار.
 *
 * الأرضية تحمي بند الإيجار فقط (قرار إداري في rentcar): الإضافات والرسوم
 * قابلة للخصم بالكامل، لكن الإجمالي الفرعي لا ينزل تحت أرضية الفترة.
 */
export function capFullTotalDiscountToFloor(
  requestedDiscountExclTax: number,
  subtotalExclTax: number,
  floorPeriodAmountExclTax: number | null,
): { discountExclTax: number; floorApplied: boolean; withheldDiscountExclTax: number } {
  const requested = Math.max(0, requestedDiscountExclTax);
  if (floorPeriodAmountExclTax == null || floorPeriodAmountExclTax <= 0) {
    return { discountExclTax: requested, floorApplied: false, withheldDiscountExclTax: 0 };
  }
  const maxDiscount = Math.max(0, subtotalExclTax - floorPeriodAmountExclTax);
  if (requested <= maxDiscount) {
    return { discountExclTax: requested, floorApplied: false, withheldDiscountExclTax: 0 };
  }
  return {
    discountExclTax: round2(maxDiscount),
    floorApplied: true,
    withheldDiscountExclTax: round2(requested - maxDiscount),
  };
}
