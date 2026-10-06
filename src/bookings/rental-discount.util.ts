/**
 * الخصومات التلقائية (`RentalDiscount`) — تنزّل السعر المعروض بلا كود من العميل.
 * منقولة عن rentcar's lib/rental-discount.ts بنفس قواعد المطابقة والترجيح.
 *
 * الترتيب الذي يفرضه rentcar: الخصم التلقائي يُحسب **دائماً** أولاً، ثم الكود
 * يُطبَّق فوق السعر الظاهر للعميل (بعد الخصم التلقائي) — وإلا كود ضعيف يستبدل
 * عرضاً أقوى فيرفع السعر بدل ما ينزّله.
 */
import { PrismaClient } from '@prisma/client';

import { discountAppliesToPeriod, type DiscountAppliesTo, type RentalPeriodKind } from './discount-scope.util';
import type { ResolvedPriceFloor } from './price-floor.util';
import { round2 } from './pricing.util';

export type RentalDiscountKind = 'PERCENT' | 'FIXED_DAILY' | 'TO_MIN_PRICE';

export interface RentalDiscountRule {
  id: number;
  kind: RentalDiscountKind;
  value: number;
  appliesTo: DiscountAppliesTo;
  startsAt: Date | null;
  endsAt: Date | null;
  brandId: number | null;
  carModelId: number | null;
  branchId: number | null;
  sortOrder: number;
}

export interface RentalDiscountContext {
  brandId: number;
  carModelId: number;
  branchId?: number | null;
  /** تاريخ الاستلام أو «الآن» لعرض الأسطول. */
  referenceDate?: Date | null;
  periodKind: RentalPeriodKind;
  numberOfDays: number;
  /** يحتاجها نوع `TO_MIN_PRICE` ليعرف لأي رقم ينزّل. */
  priceFloor?: ResolvedPriceFloor | null;
}

export interface ResolvedPeriodDiscount {
  /** المبلغ بعد الخصم: إجمالي الشهر للشهري، وسعر اليوم لليومي. */
  discountedAmountExclTax: number;
  originalAmountExclTax: number;
  savingsExclTax: number;
  /** نص مختصر للعرض: «خصم ١٠٪» أو «وفّرت ٥٠ ر.س». */
  displayLabelAr: string;
  kind: RentalDiscountKind;
}

// نفس الـ TTL في rentcar — القواعد نادرة التغيّر، وجلبها لكل صف أسطول مكلف.
const CACHE_TTL_MS = 30_000;
let cachedRules: RentalDiscountRule[] | null = null;
let cachedAtMs = 0;

export async function getActiveRentalDiscounts(prisma: PrismaClient): Promise<RentalDiscountRule[]> {
  const now = Date.now();
  if (cachedRules && now - cachedAtMs < CACHE_TTL_MS) return cachedRules;
  const rows = await prisma.rentalDiscount.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      kind: true,
      value: true,
      appliesTo: true,
      startsAt: true,
      endsAt: true,
      brandId: true,
      carModelId: true,
      branchId: true,
      sortOrder: true,
    },
  });
  cachedRules = rows as RentalDiscountRule[];
  cachedAtMs = now;
  return cachedRules;
}

export function invalidateRentalDiscountCache(): void {
  cachedRules = null;
  cachedAtMs = 0;
}

function startOfUtcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function isWithinDiscountPeriod(rule: RentalDiscountRule, referenceDate: Date): boolean {
  const refDay = startOfUtcDay(referenceDate);
  if (rule.startsAt && refDay < startOfUtcDay(rule.startsAt)) return false;
  if (rule.endsAt && refDay > startOfUtcDay(rule.endsAt)) return false;
  return true;
}

function matchesContext(rule: RentalDiscountRule, ctx: RentalDiscountContext): boolean {
  if (!discountAppliesToPeriod(rule.appliesTo, ctx.periodKind)) return false;
  if (rule.brandId != null && rule.brandId !== ctx.brandId) return false;
  if (rule.carModelId != null && rule.carModelId !== ctx.carModelId) return false;
  if (rule.branchId != null && (ctx.branchId == null || rule.branchId !== ctx.branchId)) return false;
  return isWithinDiscountPeriod(rule, ctx.referenceDate ?? new Date());
}

/** توفير اليوم الواحد — التقريب لريال كامل، مطابق لـ computeDiscountedDailyPrice. */
function computeDailySavings(
  basePricePerDayExclTax: number,
  kind: RentalDiscountKind,
  value: number,
  minPricePerDayExclTax: number | null | undefined,
): number {
  const base = Math.max(0, Math.round(basePricePerDayExclTax));
  if (base <= 0) return 0;

  if (kind === 'TO_MIN_PRICE') {
    // ينزّل للأرضية بالضبط. بلا أرضية (أو أرضية ≥ السعر) لا خصم — والقاعدة
    // تسقط تلقائياً فتتاح الفرصة لقاعدة أخرى مطابقة.
    if (minPricePerDayExclTax == null || minPricePerDayExclTax <= 0) return 0;
    const floor = round2(minPricePerDayExclTax);
    return floor >= base ? 0 : round2(base - floor);
  }
  if (kind === 'PERCENT') {
    return Math.round((base * Math.min(100, Math.max(1, Math.round(value)))) / 100);
  }
  return Math.min(base, Math.max(0, Math.round(value)));
}

/** توفير الشهر — يُحسب على إجمالي الشهر بدقة هللتين، بلا قسمة على الأيام. */
function computeMonthlySavings(
  monthlyTotalExclTax: number,
  kind: RentalDiscountKind,
  value: number,
  numberOfDays: number,
  minPriceMonthlyExclTax: number | null | undefined,
): number {
  const base = Math.max(0, monthlyTotalExclTax);
  if (base <= 0) return 0;

  if (kind === 'TO_MIN_PRICE') {
    if (minPriceMonthlyExclTax == null || minPriceMonthlyExclTax <= 0) return 0;
    const floor = round2(minPriceMonthlyExclTax);
    return floor >= base ? 0 : round2(base - floor);
  }
  if (kind === 'PERCENT') {
    return round2((base * Math.min(100, Math.max(1, Math.round(value)))) / 100);
  }
  // FIXED_DAILY = مبلغ يومي بالريال → يُضرب في عدد أيام الشهر المحجوز.
  return Math.min(base, Math.max(0, Math.round(value)) * Math.max(1, Math.round(numberOfDays)));
}

export function buildCustomerDiscountLabelAr(
  kind: RentalDiscountKind,
  value: number,
  savings: number,
): string {
  if (savings <= 0) return '';
  // `TO_MIN_PRICE` مبلغ متغيّر لكل مركبة — يُعرض دائماً كمبلغ، لا كنسبة.
  if (kind === 'PERCENT') return `خصم ${Math.min(100, Math.max(1, Math.round(value)))}٪`;
  return `وفّرت ${savings} ر.س`;
}

/**
 * أفضل خصم مطابق: الأكبر توفيراً، وعند التعادل الأقل `sortOrder` — نفس ترجيح
 * rentcar's resolveBestPeriodDiscount.
 */
export function resolveBestPeriodDiscount(
  rules: ReadonlyArray<RentalDiscountRule>,
  ctx: RentalDiscountContext,
  baseAmountExclTax: number,
): ResolvedPeriodDiscount | null {
  const isMonthly = ctx.periodKind === 'monthly';
  const base = isMonthly ? Math.max(0, baseAmountExclTax) : Math.max(0, Math.round(baseAmountExclTax));
  if (base <= 0) return null;

  let best: { resolved: ResolvedPeriodDiscount; sortOrder: number } | null = null;

  for (const rule of rules) {
    if (!matchesContext(rule, ctx)) continue;
    const savings = isMonthly
      ? computeMonthlySavings(base, rule.kind, rule.value, ctx.numberOfDays, ctx.priceFloor?.minPriceMonthlyExclTax)
      : computeDailySavings(base, rule.kind, rule.value, ctx.priceFloor?.minPricePerDayExclTax);
    if (savings <= 0) continue;

    const candidate: ResolvedPeriodDiscount = {
      discountedAmountExclTax: round2(base - savings),
      originalAmountExclTax: base,
      savingsExclTax: savings,
      displayLabelAr: buildCustomerDiscountLabelAr(rule.kind, rule.value, savings),
      kind: rule.kind,
    };

    if (
      !best ||
      candidate.savingsExclTax > best.resolved.savingsExclTax ||
      (candidate.savingsExclTax === best.resolved.savingsExclTax && rule.sortOrder < best.sortOrder)
    ) {
      best = { resolved: candidate, sortOrder: rule.sortOrder };
    }
  }

  return best?.resolved ?? null;
}

export async function resolveRentalDiscountForPeriod(
  prisma: PrismaClient,
  baseAmountExclTax: number,
  ctx: RentalDiscountContext,
): Promise<ResolvedPeriodDiscount | null> {
  return resolveBestPeriodDiscount(await getActiveRentalDiscounts(prisma), ctx, baseAmountExclTax);
}
