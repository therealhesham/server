import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

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
}

export interface PricingResult {
  carModel: { id: number; vatRatePercent: number; categorySlug: string };
  pickupAt: Date;
  returnAt: Date;
  numberOfDays: number;
  dailyRate: number;
  addons: { id: number; slug: string; title: string; pricePerDay: number }[];
  extrasTotal: number;
  deliveryFee: number;
  subtotal: number;
  preVat: number;
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
  const dailyRate = fleetRow?.pricePerDayExclTax ?? carModel.minPricePerDayExclTax ?? carModel.price;
  if (!dailyRate) throw new BadRequestException('تعذّر تحديد سعر السيارة في هذا الفرع.');

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

  const subtotal = dailyRate * numberOfDays;
  const extrasTotal = addons.reduce((sum, a) => sum + a.pricePerDay, 0) * numberOfDays;
  const preVat = subtotal + extrasTotal + deliveryFee;

  return {
    carModel: { id: carModel.id, vatRatePercent: carModel.vatRatePercent, categorySlug: carModel.FleetCategory.slug },
    pickupAt,
    returnAt,
    numberOfDays,
    dailyRate,
    addons,
    extrasTotal,
    deliveryFee,
    subtotal,
    preVat,
  };
}
