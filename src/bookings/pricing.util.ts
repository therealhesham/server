import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import {
  applyPriceFloorToPeriodAmount,
  floorForPeriodAmount,
  type ResolvedPriceFloor,
} from './price-floor.util';
import { resolveRentalDiscountForPeriod, type ResolvedPeriodDiscount } from './rental-discount.util';

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * حدّ مؤقت منقول عن rentcar (MONTHLY_BOOKING_MAX_DAYS في lib/direct-booking.ts).
 *
 * التسعير الشهري مبلغ ثابت للفترة مهما طالت، فحجز ٤٥ أو ٦٠ يوماً بتواريخ صحيحة
 * تماماً يدفع سعر شهر واحد. المنطق سليم لشهر واحد لكنه يفترض ضمناً أن المدة
 * ≈ شهر — نمنع ما فوقها ريثما يُحسم تسعير المدد الأطول: رفض الحجز أهون من
 * بيعه بنصف سعره.
 */
export const MONTHLY_BOOKING_MAX_DAYS = 31;

// Same rounded-division day count the app already displays as "trip.days" —
// billing what the customer sees, not a stricter calendar-day recount that
// could silently diverge from the on-screen total.
export function daysBetween(pickupAt: Date, returnAt: Date): number {
  return Math.max(1, Math.round((returnAt.getTime() - pickupAt.getTime()) / 86_400_000));
}

// Same formula as lib/geo.ts's haversineKm on the client — kept identical so
// the fee the customer previewed on the delivery-location screen matches
// what actually gets billed, since only this server-side copy is trusted.
function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface PricingInput {
  carModelId: number;
  returnBranchId: number;
  pickupAt: string;
  returnAt: string;
  addonIds?: number[];
  pickupMode: 'branch' | 'delivery';
  deliveryBranchId?: number;
  deliveryLat?: number;
  deliveryLng?: number;
  // 'monthly' bills the car's flat monthly rate instead of dailyRate × days —
  // see the subtotal branch below. Omitted/'daily' keeps the old behavior.
  rentalPeriodKind?: 'daily' | 'monthly';
}

export interface PricingResult {
  carModel: { id: number; vatRatePercent: number; categorySlug: string };
  pickupAt: Date;
  returnAt: Date;
  numberOfDays: number;
  dailyRate: number;
  rentalPeriodKind: 'daily' | 'monthly';
  addons: { id: number; slug: string; title: string; pricePerDay: number }[];
  extrasTotal: number;
  deliveryFee: number;
  subtotal: number;
  preVat: number;
  /**
   * مبلغ الإيجار للفترة **بعد الخصم التلقائي** وقبل أي كود: إجمالي الشهر
   * للشهري، وسعر اليوم لليومي. الكوبون بنطاق RENTAL_ONLY يُحسب على ده (مش على
   * `subtotal` اللي شامل الإضافات والتوصيل) — نفس تقسيم rentcar.
   */
  basePeriodAmount: number;
  /** نفس المبلغ قبل الخصم التلقائي — للعرض («كان كذا») وللتدقيق. */
  listPeriodAmount: number;
  /** الخصم التلقائي المطبَّق، إن وُجد. */
  rentalDiscount: ResolvedPeriodDiscount | null;
  /** أرضية السعر الفعّالة للموديل في هذا الفرع — تجاوز الفرع إن وُجد وإلا حد الموديل. */
  priceFloor: ResolvedPriceFloor;
}

// Shared by BookingsService.createBooking and CouponsService.validate so a
// coupon preview and the actual booking charge are computed from identical
// logic — never two slightly-different implementations that could drift.
export async function computeBookingPricing(prisma: PrismaClient, input: PricingInput): Promise<PricingResult> {
  const carModel = await prisma.carModel.findUnique({
    where: { id: input.carModelId },
    include: { FleetCategory: true },
  });
  if (!carModel) throw new BadRequestException('السيارة غير موجودة.');

  const pickupAt = new Date(input.pickupAt);
  const returnAt = new Date(input.returnAt);
  if (Number.isNaN(pickupAt.getTime()) || Number.isNaN(returnAt.getTime()) || returnAt <= pickupAt) {
    throw new BadRequestException('تواريخ الحجز غير صالحة.');
  }
  const numberOfDays = daysBetween(pickupAt, returnAt);

  const fleetRow = await prisma.fleet.findUnique({
    where: { modelId_branchId: { modelId: input.carModelId, branchId: input.returnBranchId } },
  });
  // `CarModel.min*` أرضية سعر (الحد الذي يمنع الخصومات من النزول تحته) — مش
  // سعراً معروضاً. السقوط عليها كبديل كان يبيع السيارة بأقل رقم مقبول إدارياً.
  // البديل الصحيح هو سعر الموديل نفسه، تماماً كـ rentcar's
  // resolveBranchBasePriceForModel / resolveBranchMonthlyPriceForModel.
  const dailyRate = fleetRow?.pricePerDayExclTax ?? carModel.price;
  const rentalPeriodKind = input.rentalPeriodKind === 'monthly' ? 'monthly' : 'daily';

  let listPeriodAmount: number;
  if (rentalPeriodKind === 'monthly') {
    const monthlyRate = fleetRow?.priceMonthlyExclTax ?? carModel.priceMonthlyExclTax ?? null;
    if (!monthlyRate) throw new BadRequestException('لا يتوفر سعر شهري لهذه السيارة في هذا الفرع.');
    if (numberOfDays > MONTHLY_BOOKING_MAX_DAYS) {
      throw new BadRequestException(
        `الحجز الشهري متاح حتى ${MONTHLY_BOOKING_MAX_DAYS} يوماً. للمدد الأطول اختر الإيجار اليومي أو تواصل معنا.`,
      );
    }
    listPeriodAmount = monthlyRate;
  } else {
    if (!dailyRate) throw new BadRequestException('تعذّر تحديد سعر السيارة في هذا الفرع.');
    listPeriodAmount = dailyRate;
  }

  // تجاوز الفرع إن وُجد وإلا حد الموديل — نفس نمط rentcar's resolvePriceFloorForModel.
  const priceFloor: ResolvedPriceFloor = {
    minPricePerDayExclTax: fleetRow?.minPricePerDayExclTax ?? carModel.minPricePerDayExclTax,
    minPriceMonthlyExclTax: fleetRow?.minPriceMonthlyExclTax ?? carModel.minPriceMonthlyExclTax,
  };

  // الخصم التلقائي يُحسب قبل أي كود — الكود يُطبَّق فوق السعر الظاهر للعميل،
  // مش على سعر القائمة؛ وإلا كود ضعيف يستبدل عرضاً أقوى فيرفع السعر.
  const rentalDiscount = await resolveRentalDiscountForPeriod(prisma, listPeriodAmount, {
    brandId: carModel.brandId,
    carModelId: carModel.id,
    branchId: input.returnBranchId,
    referenceDate: pickupAt,
    periodKind: rentalPeriodKind,
    numberOfDays,
    priceFloor,
  });
  // الأرضية تقصّ الخصم التلقائي كما تقصّ الكود — في rentcar الاتنين بيمرّوا على
  // نفس applyPriceFloorPerDay مرة واحدة، فلازم تتطبّق هنا كمان مش بس مع الكود.
  const basePeriodAmount = applyPriceFloorToPeriodAmount(
    rentalDiscount?.discountedAmountExclTax ?? listPeriodAmount,
    listPeriodAmount,
    floorForPeriodAmount(priceFloor, rentalPeriodKind),
  ).finalPeriodAmountExclTax;
  const subtotal = rentalPeriodKind === 'monthly' ? basePeriodAmount : basePeriodAmount * numberOfDays;

  let addons: { id: number; slug: string; title: string; pricePerDay: number }[] = [];
  if (input.addonIds?.length) {
    const rows = await prisma.rentalAddon.findMany({ where: { id: { in: input.addonIds }, isActive: true } });
    addons = rows.map((r) => ({ id: r.id, slug: r.slug, title: r.titleAr, pricePerDay: r.pricePerDay }));
  }

  let deliveryFee = 0;
  if (input.pickupMode === 'delivery') {
    if (!input.deliveryBranchId || input.deliveryLat == null || input.deliveryLng == null) {
      throw new BadRequestException('بيانات موقع التوصيل ناقصة.');
    }
    const servicingBranch = await prisma.branch.findUnique({ where: { id: input.deliveryBranchId } });
    if (!servicingBranch?.latitude || !servicingBranch?.longitude) {
      throw new BadRequestException('تعذّر تحديد موقع الفرع لحساب رسوم التوصيل.');
    }
    const distanceKm = haversineKm(
      { lat: servicingBranch.latitude, lng: servicingBranch.longitude },
      { lat: input.deliveryLat, lng: input.deliveryLng },
    );
    deliveryFee = round2(distanceKm * servicingBranch.deliveryFeePerKmSar);
  }

  const extrasTotal = addons.reduce((sum, a) => sum + a.pricePerDay, 0) * numberOfDays;
  const preVat = subtotal + extrasTotal + deliveryFee;

  return {
    carModel: { id: carModel.id, vatRatePercent: carModel.vatRatePercent, categorySlug: carModel.FleetCategory.slug },
    pickupAt,
    returnAt,
    numberOfDays,
    dailyRate,
    rentalPeriodKind,
    addons,
    extrasTotal,
    deliveryFee,
    subtotal,
    preVat,
    basePeriodAmount,
    listPeriodAmount,
    rentalDiscount,
    priceFloor,
  };
}
