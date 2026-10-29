import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { availabilityKey, countOverlappingBookings, daysBetweenDates } from '../bookings/availability.util';
import { getActiveCheckoutOneTimeFees } from '../bookings/checkout-fees.util';
import { getActiveRentalDiscounts, resolveBestPeriodDiscount } from '../bookings/rental-discount.util';
import { ListCarsQueryDto } from './dto/list-cars-query.dto';

const FUEL_LABELS: Record<string, string> = {
  GASOLINE: 'بنزين',
  DIESEL: 'ديزل',
  HYBRID: 'هايبرد',
  ELECTRIC: 'كهربائي',
};

const TRANSMISSION_LABELS: Record<string, string> = {
  MANUAL: 'يدوي',
  AUTOMATIC: 'أوتوماتيك',
};

@Injectable()
export class FleetService {
  constructor(private readonly prisma: PrismaService) {}

  async listCategories() {
    return this.prisma.fleetCategory.findMany({
      orderBy: { sortOrder: 'asc' },
      select: { id: true, slug: true, title: true, titleEn: true, image: true },
    });
  }

  // Mirrors rentcar's getActiveBookingCitiesWithBranches (lib/branch-data.ts):
  // branches are always picked in the context of their city, and only active
  // cities/branches with real opening-hours + delivery data are offered.
  async listBranchesByCity() {
    const cities = await this.prisma.city.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: {
        Branch: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            slug: true,
            name: true,
            nameEn: true,
            address: true,
            addressEn: true,
            openingHoursJson: true,
            mapUrl: true,
            latitude: true,
            longitude: true,
            deliveryFeePerKmSar: true,
          },
        },
      },
    });

    return cities
      .filter((city) => city.Branch.length > 0)
      .map((city) => ({
        id: city.id,
        slug: city.slug,
        name: city.name,
        nameEn: city.nameEn,
        branches: city.Branch.map((b) => ({
          id: b.id,
          slug: b.slug,
          name: b.name,
          nameEn: b.nameEn,
          address: b.address,
          addressEn: b.addressEn,
          openingHours: safeParseJson(b.openingHoursJson),
          lat: b.latitude,
          lng: b.longitude,
          mapUrl: b.mapUrl,
          deliveryFeePerKmSar: b.deliveryFeePerKmSar,
        })),
      }));
  }

  // معاينة فقط — الرسوم الفعلية تُحسب وتُفرض من السيرفر عند الحجز
  // (resolveInterCityShippingSnap)، فالتطبيق ما يقدرش يخفّضها بتعديل هذه القائمة.
  async listInterCityFees() {
    const rows = await this.prisma.interCityShippingFee.findMany({
      where: { isActive: true, feeExclVatSar: { gt: 0 } },
      select: { fromCityId: true, toCityId: true, feeExclVatSar: true },
    });
    return rows;
  }

  // معاينة فقط — الفرض الفعلي في computeBookingPricing.
  async listCheckoutFees() {
    return getActiveCheckoutOneTimeFees(this.prisma as unknown as PrismaClient);
  }

  async listCars(query: ListCarsQueryDto) {
    const fleetRows = await this.prisma.fleet.findMany({
      where: {
        isVisible: true,
        quantity: { gt: 0 },
        ...(query.branchId ? { branchId: query.branchId } : {}),
        ...(query.categoryId ? { CarModel: { categoryId: query.categoryId } } : {}),
      },
      orderBy: { displayOrder: 'asc' },
      include: {
        CarModel: { include: { Brand: true, FleetCategory: true } },
        Branch: { select: { id: true, name: true, slug: true } },
      },
    });

    // الخصومات التلقائية تدخل في المقارنة قبل اختيار «الأرخص» — صف أغلى بخصم
    // قوي ممكن يطلع أرخص فعلاً من صف أقل سعراً بلا خصم، زي rentcar's
    // pickCheapestRowPerModel اللي بيقارن بـ rowEffectivePrice.
    const rules = await getActiveRentalDiscounts(this.prisma as unknown as PrismaClient);
    const effectiveDaily = (row: (typeof fleetRows)[number]) => {
      const list = row.pricePerDayExclTax ?? row.CarModel.price;
      const discount = resolveBestPeriodDiscount(
        rules,
        {
          brandId: row.CarModel.brandId,
          carModelId: row.modelId,
          branchId: row.branchId,
          periodKind: 'daily',
          numberOfDays: 1,
          priceFloor: {
            minPricePerDayExclTax: row.minPricePerDayExclTax ?? row.CarModel.minPricePerDayExclTax,
            minPriceMonthlyExclTax: row.minPriceMonthlyExclTax ?? row.CarModel.minPriceMonthlyExclTax,
          },
        },
        list,
      );
      return discount?.discountedAmountExclTax ?? list;
    };

    // مع التواريخ: كل صف أسطول يعرف كم وحدة فاضلة في الفترة دي. السيارة غير
    // المتاحة بتفضل ظاهرة (بحالة available=false) مش بتختفي — العميل لازم يعرف
    // إنها محجوزة في الفترة دي مش إنها مش موجودة.
    const span = parseRequestedSpan(query.pickupAt, query.returnAt);
    const taken = span
      ? await countOverlappingBookings(this.prisma, {
          carModelIds: [...new Set(fleetRows.map((r) => r.modelId))],
          branchIds: [...new Set(fleetRows.map((r) => r.branchId))],
          pickupAt: span.pickupAt,
          days: span.days,
        })
      : null;
    const unitsLeftFor = (row: (typeof fleetRows)[number]): number | null =>
      taken ? Math.max(0, row.quantity - (taken.get(availabilityKey(row.modelId, row.branchId)) ?? 0)) : null;
    const isAvailable = (left: number | null) => left == null || left > 0;

    // Without a branch filter, the same CarModel can appear at several
    // branches — collapse to one card per model showing its cheapest price,
    // preferring a branch that is actually free in the requested period.
    const byModel = new Map<number, { row: (typeof fleetRows)[number]; price: number; left: number | null }>();
    for (const row of fleetRows) {
      const price = effectiveDaily(row);
      const left = unitsLeftFor(row);
      const existing = byModel.get(row.modelId);
      const better =
        !existing ||
        (isAvailable(left) && !isAvailable(existing.left)) ||
        (isAvailable(left) === isAvailable(existing.left) && price < existing.price);
      if (better) byModel.set(row.modelId, { row, price, left });
    }

    const cards = [...byModel.values()].map(({ row, price, left }) => this.toCarSummary(row, price, left));
    // المتاحة أولاً، وبعدها غير المتاحة — بنفس ترتيب العرض الأصلي داخل كل مجموعة.
    return span ? [...cards.filter((c) => c.available), ...cards.filter((c) => !c.available)] : cards;
  }

  async getCar(modelId: number, branchId?: number, pickupAtRaw?: string, returnAtRaw?: string) {
    const carModel = await this.prisma.carModel.findUnique({
      where: { id: modelId },
      include: {
        Brand: true,
        FleetCategory: true,
        Fleet: {
          where: { isVisible: true, ...(branchId ? { branchId } : {}) },
          include: { Branch: { select: { id: true, name: true, slug: true } } },
          orderBy: { pricePerDayExclTax: 'asc' },
        },
      },
    });
    if (!carModel) throw new NotFoundException('Car model not found');

    const span = parseRequestedSpan(pickupAtRaw, returnAtRaw);
    const taken = span
      ? await countOverlappingBookings(this.prisma, {
          carModelIds: [modelId],
          branchIds: carModel.Fleet.map((f) => f.branchId),
          pickupAt: span.pickupAt,
          days: span.days,
        })
      : null;

    const cheapestFleet = carModel.Fleet[0];
    const listPricePerDay = cheapestFleet?.pricePerDayExclTax ?? carModel.price;

    // نفس الخصم التلقائي المعروض في القائمة — لو صفحة التفاصيل عرضت سعر القائمة
    // كان العميل هيشوف رقمين مختلفين لنفس السيارة.
    const dailyDiscount = resolveBestPeriodDiscount(
      await getActiveRentalDiscounts(this.prisma as unknown as PrismaClient),
      {
        brandId: carModel.brandId,
        carModelId: carModel.id,
        branchId: cheapestFleet?.branchId ?? branchId ?? null,
        periodKind: 'daily',
        numberOfDays: 1,
        priceFloor: {
          minPricePerDayExclTax: cheapestFleet?.minPricePerDayExclTax ?? carModel.minPricePerDayExclTax,
          minPriceMonthlyExclTax: cheapestFleet?.minPriceMonthlyExclTax ?? carModel.minPriceMonthlyExclTax,
        },
      },
      listPricePerDay,
    );

    return {
      id: carModel.id,
      make: carModel.Brand.name,
      makeEn: carModel.Brand.nameEn,
      model: carModel.name,
      modelEn: carModel.nameEn,
      year: carModel.year,
      category: carModel.FleetCategory.slug,
      categoryLabel: carModel.FleetCategory.title,
      seats: carModel.chairs,
      engine: carModel.engine,
      fuel: carModel.fuel,
      fuelLabel: FUEL_LABELS[carModel.fuel] ?? carModel.fuel,
      transmission: carModel.transmission,
      transmissionLabel: TRANSMISSION_LABELS[carModel.transmission] ?? carModel.transmission,
      image: carModel.image,
      pricePerDay: dailyDiscount?.discountedAmountExclTax ?? listPricePerDay,
      originalPricePerDay: dailyDiscount ? listPricePerDay : null,
      priceMonthly: cheapestFleet?.priceMonthlyExclTax ?? carModel.priceMonthlyExclTax ?? null,
      vatRatePercent: carModel.vatRatePercent,
      availability: carModel.Fleet.map((f) => {
        const unitsLeft = taken
          ? Math.max(0, f.quantity - (taken.get(availabilityKey(modelId, f.branchId)) ?? 0))
          : null;
        return {
          branchId: f.branchId,
          branchName: f.Branch.name,
          quantity: f.quantity,
          // null لما التواريخ ما اتبعتتش — العميل ساعتها ما يعرفش إلا المخزون.
          unitsLeft,
          available: unitsLeft == null ? null : unitsLeft > 0,
          pricePerDay: f.pricePerDayExclTax,
          priceMonthly: f.priceMonthlyExclTax,
        };
      }),
    };
  }

  private toCarSummary(row: {
    id: number;
    modelId: number;
    branchId: number;
    quantity: number;
    pricePerDayExclTax: number | null;
    priceMonthlyExclTax: number | null;
    CarModel: {
      id: number;
      name: string;
      nameEn: string | null;
      year: number;
      chairs: number;
      transmission: string;
      fuel: string;
      image: string | null;
      price: number;
      priceMonthlyExclTax: number | null;
      vatRatePercent: number;
      Brand: { name: string; nameEn: string | null };
      FleetCategory: { slug: string; title: string };
    };
    Branch: { id: number; name: string; slug: string };
  },
  /** السعر اليومي بعد الخصم التلقائي — يسقط على سعر القائمة لو مفيش خصم. */
  effectivePricePerDay?: number,
  /** الوحدات الفاضلة في الفترة المطلوبة — null لما التواريخ ما اتبعتتش. */
  unitsLeft: number | null = null,
  ) {
    // `CarModel.min*` أرضية سعر وليست سعراً — البديل الصحيح هو سعر الموديل
    // نفسه، مطابقاً لـ rentcar's resolveBranchBasePriceForModel.
    const listPricePerDay = row.pricePerDayExclTax ?? row.CarModel.price;
    return {
      id: row.CarModel.id,
      fleetId: row.id,
      make: row.CarModel.Brand.name,
      makeEn: row.CarModel.Brand.nameEn,
      model: row.CarModel.name,
      modelEn: row.CarModel.nameEn,
      year: row.CarModel.year,
      category: row.CarModel.FleetCategory.slug,
      categoryLabel: row.CarModel.FleetCategory.title,
      seats: row.CarModel.chairs,
      fuel: row.CarModel.fuel,
      fuelLabel: FUEL_LABELS[row.CarModel.fuel] ?? row.CarModel.fuel,
      transmission: row.CarModel.transmission,
      transmissionLabel: TRANSMISSION_LABELS[row.CarModel.transmission] ?? row.CarModel.transmission,
      image: row.CarModel.image,
      pricePerDay: effectivePricePerDay ?? listPricePerDay,
      // سعر القائمة قبل الخصم التلقائي — null لما مفيش خصم، فالواجهة ما تعرضش
      // شطباً على سعر مطابق.
      originalPricePerDay:
        effectivePricePerDay != null && effectivePricePerDay < listPricePerDay ? listPricePerDay : null,
      priceMonthly: row.priceMonthlyExclTax ?? row.CarModel.priceMonthlyExclTax ?? null,
      vatRatePercent: row.CarModel.vatRatePercent,
      branch: { id: row.Branch.id, name: row.Branch.name, slug: row.Branch.slug },
      quantityAvailable: row.quantity,
      unitsLeft,
      available: unitsLeft == null ? null : unitsLeft > 0,
    };
  }
}

// الفترة المطلوبة للبحث — نفس حساب الأيام اللي بيتحاسب عليه الحجز. تواريخ ناقصة
// أو معكوسة تعني «بدون فحص توفّر» بدل خطأ، فالقائمة تفضل شغالة بدون تواريخ.
function parseRequestedSpan(pickupAtRaw?: string, returnAtRaw?: string): { pickupAt: Date; days: number } | null {
  if (!pickupAtRaw || !returnAtRaw) return null;
  const pickupAt = new Date(pickupAtRaw);
  const returnAt = new Date(returnAtRaw);
  if (Number.isNaN(pickupAt.getTime()) || Number.isNaN(returnAt.getTime()) || returnAt <= pickupAt) return null;
  return { pickupAt, days: daysBetweenDates(pickupAt, returnAt) };
}

function safeParseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    new Logger('Fleet').warn({ msg: 'Branch openingHoursJson is invalid JSON; hours omitted', sample: raw.slice(0, 80) });
    return null;
  }
}
