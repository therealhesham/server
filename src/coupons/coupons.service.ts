import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { computeBookingPricing, round2, type PricingInput, type PricingResult } from '../bookings/pricing.util';
import {
  applyPriceFloorToPeriodAmount,
  capFullTotalDiscountToFloor,
  floorForPeriodAmount,
  resolveFloorForPeriod,
} from '../bookings/price-floor.util';
import {
  buildCouponDiscountLabelAr,
  computeCouponDiscountForPeriod,
  computeCouponDiscountOnSubtotal,
  discountAppliesToPeriod,
  type CouponAppliesTo,
  type CouponKind,
  type CouponScope,
  type RentalPeriodKind,
} from './coupon-pricing.util';
import { ValidateCouponDto } from './dto/validate-coupon.dto';

export interface ResolvedCoupon {
  id: number;
  code: string;
  kind: CouponKind;
  value: number;
  scope: CouponScope;
  appliesTo: CouponAppliesTo;
  /** true = مصرَّح له إدارياً بالنزول تحت الحد الأدنى للسعر. */
  canBypassMinPrice: boolean;
  /** GENERAL = جدول `CouponCode`؛ CUSTOMIZED = `CustomizedCoupon` (مخصَّص لعميل واحد). */
  source: 'GENERAL' | 'CUSTOMIZED';
  maxUses: number | null;
}

@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}

  // Mirrors rentcar's resolveCouponCode exactly (same checks, same order,
  // same Arabic error copy) so a code behaves identically whether it's
  // entered on the website or in the app.
  async resolveCoupon(
    rawCode: string,
    customerPhone: string,
    periodKind: RentalPeriodKind,
    now = new Date(),
  ): Promise<ResolvedCoupon> {
    const code = rawCode.trim().toUpperCase();
    if (!code) throw new BadRequestException('كود الخصم غير صحيح.');

    // الأكواد المخصَّصة أولاً: نفس نص الكود ممكن يتكرر لعملاء مختلفين، فالمطابقة
    // بالكود + رقم الجوال معاً. كود مخصَّص لعميل آخر (أو غير موجود) يكمّل البحث
    // في الجدول العام كالمعتاد — نفس ترتيب rentcar's resolveCouponCode.
    const customized = await this.prisma.customizedCoupon.findUnique({
      where: { code_customerPhone: { code, customerPhone } },
    });
    if (customized) {
      if (!customized.isActive) throw new BadRequestException('كود الخصم غير مُفعَّل حالياً.');
      if (customized.isUsed) throw new BadRequestException('لقد استخدمت هذا الكود من قبل.');
      if (customized.endsAt && now.getTime() > customized.endsAt.getTime()) {
        throw new BadRequestException('انتهت صلاحية كود الخصم.');
      }
      return {
        id: customized.id,
        code: customized.code,
        kind: customized.kind as CouponKind,
        value: customized.value,
        scope: customized.scope as CouponScope,
        // الكود المخصَّص بلا قيد فترة — يسري على اليومي والشهري معاً، زي rentcar.
        appliesTo: 'DAILY_AND_MONTHLY',
        canBypassMinPrice: customized.canBypassMinPrice,
        source: 'CUSTOMIZED',
        maxUses: 1,
      };
    }

    const row = await this.prisma.couponCode.findUnique({ where: { code } });
    if (!row) throw new BadRequestException('كود الخصم غير صحيح.');
    if (!row.isActive) throw new BadRequestException('كود الخصم غير مُفعَّل حالياً.');
    if (row.startsAt && now.getTime() < row.startsAt.getTime()) {
      throw new BadRequestException('كود الخصم لم تبدأ صلاحيته بعد.');
    }
    if (row.endsAt && now.getTime() > row.endsAt.getTime()) {
      throw new BadRequestException('انتهت صلاحية كود الخصم.');
    }
    const appliesTo = row.appliesTo as CouponAppliesTo;
    if (!discountAppliesToPeriod(appliesTo, periodKind)) {
      throw new BadRequestException(
        appliesTo === 'MONTHLY_ONLY'
          ? 'هذا الكود يسري على التأجير الشهري فقط.'
          : 'هذا الكود يسري على التأجير اليومي فقط.',
      );
    }
    if (row.maxUses != null && row.usesCount >= row.maxUses) {
      throw new BadRequestException('نفد الحد الأقصى لاستخدام هذا الكود.');
    }
    if (row.perCustomerLimit != null) {
      const customerUses = await this.prisma.couponRedemption.count({
        where: { couponCodeId: row.id, customerPhone },
      });
      if (customerUses >= row.perCustomerLimit) {
        throw new BadRequestException('لقد استخدمت هذا الكود من قبل.');
      }
    }

    return {
      id: row.id,
      code: row.code,
      kind: row.kind as CouponKind,
      value: row.value,
      scope: row.scope as CouponScope,
      appliesTo,
      canBypassMinPrice: row.canBypassMinPrice,
      source: 'GENERAL',
      maxUses: row.maxUses,
    };
  }

  /**
   * الخصم النهائي بعد احترام أرضية السعر — نفس ترتيب rentcar في
   * lib/direct-booking.ts: الكوبون يُطبَّق أولاً، ثم الأرضية تقصّ ما تجاوزه.
   *
   * كود مصرَّح له إدارياً (`canBypassMinPrice`) يلغي الأرضية لهذا الحجز.
   */
  computeDiscount(coupon: ResolvedCoupon, pricing: PricingResult): number {
    if (coupon.scope === 'RENTAL_ONLY') {
      // كود مصرَّح له بتجاوز الأرضية يبدأ من مبلغ ما بعد الخصم التلقائي **قبل**
      // ما تقصّه الأرضية — وإلا كان التصريح بيتجاهل جزءاً من الخصم التلقائي.
      const startFrom = coupon.canBypassMinPrice
        ? pricing.rentalDiscount?.discountedAmountExclTax ?? pricing.listPeriodAmount
        : pricing.basePeriodAmount;

      const { discountedAmountExclTax } = computeCouponDiscountForPeriod(
        startFrom,
        coupon.kind,
        coupon.value,
        pricing.rentalPeriodKind,
      );
      // كله بوحدة «مبلغ الفترة» (سعر اليوم أو إجمالي الشهر) — بلا قسمة تضيّع كسوراً.
      const outcome = applyPriceFloorToPeriodAmount(
        discountedAmountExclTax,
        pricing.listPeriodAmount,
        coupon.canBypassMinPrice ? null : floorForPeriodAmount(pricing.priceFloor, pricing.rentalPeriodKind),
      );
      const finalRentalTotal =
        pricing.rentalPeriodKind === 'monthly'
          ? outcome.finalPeriodAmountExclTax
          : outcome.finalPeriodAmountExclTax * pricing.numberOfDays;

      return Math.max(0, round2(pricing.subtotal - finalRentalTotal));
    }

    // FULL_TOTAL — يُطرح من الإجمالي الفرعي (إيجار + إضافات + توصيل)، والأرضية
    // تحمي بند الإيجار فقط: الإضافات والرسوم قابلة للخصم بالكامل.
    const floorTotal = coupon.canBypassMinPrice
      ? null
      : resolveFloorForPeriod(pricing.priceFloor, pricing.rentalPeriodKind, pricing.numberOfDays);
    const requested = computeCouponDiscountOnSubtotal(pricing.preVat, coupon.kind, coupon.value);
    const capped = capFullTotalDiscountToFloor(requested, pricing.preVat, floorTotal);
    return Math.min(capped.discountExclTax, pricing.preVat);
  }

  async validate(userId: number, dto: ValidateCouponDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('الجلسة غير صالحة.');
    if (!user.phone) throw new BadRequestException('رقم جوالك غير مسجّل على الحساب.');

    const pricingInput: PricingInput = {
      carModelId: dto.carModelId,
      returnBranchId: dto.returnBranchId,
      pickupAt: dto.pickupAt,
      returnAt: dto.returnAt,
      addonIds: dto.addonIds,
      pickupMode: dto.pickupMode,
      deliveryBranchId: dto.deliveryBranchId,
      deliveryLat: dto.deliveryLat,
      deliveryLng: dto.deliveryLng,
      rentalPeriodKind: dto.rentalPeriodKind,
    };
    const pricing = await computeBookingPricing(this.prisma as unknown as PrismaClient, pricingInput);
    const coupon = await this.resolveCoupon(dto.code, user.phone, pricing.rentalPeriodKind);
    const discountAmountSar = this.computeDiscount(coupon, pricing);

    const discountedPreVat = Math.max(0, pricing.preVat - discountAmountSar);
    const vat = round2(discountedPreVat * (pricing.carModel.vatRatePercent / 100));
    const newTotalSar = round2(discountedPreVat + vat);

    return {
      valid: true as const,
      discountAmountSar,
      newTotalSar,
      label: buildCouponDiscountLabelAr(coupon.kind, coupon.value, discountAmountSar),
    };
  }

  // Called from inside BookingsService.createBooking's transaction — must
  // receive the same tx so the redemption and the booking commit atomically.
  async applyInTransaction(
    tx: Prisma.TransactionClient,
    coupon: ResolvedCoupon,
    customerPhone: string,
    bookingRequestId: number,
    discountAmountSar: number,
  ): Promise<void> {
    if (coupon.source === 'CUSTOMIZED') {
      // `isUsed: false` في الـ where هو القفل: حجزان متوازيان بنفس الكود، واحد
      // بس هيعدّل صفاً والتاني هيلاقي count = 0 فيتوقف.
      const updated = await tx.customizedCoupon.updateMany({
        where: { id: coupon.id, isUsed: false },
        data: { isUsed: true, usedAt: new Date(), usedByBookingRequestId: bookingRequestId },
      });
      if (updated.count === 0) {
        throw new ConflictException('تم استخدام كود الخصم المخصص من قبل. أعد المحاولة بدون الكود.');
      }
      // بلا صف في CouponRedemption — مفتاحها الأجنبي يشير إلى CouponCode وحدها.
      return;
    }

    if (coupon.maxUses != null) {
      // نفس فكرة القفل أعلاه: الشرط داخل الاستعلام يمنع تجاوز الحد تحت التزاحم،
      // بينما `update` + increment كان ممكن يعدّي الحد لو وصل طلبان معاً.
      const updated = await tx.couponCode.updateMany({
        where: { id: coupon.id, usesCount: { lt: coupon.maxUses } },
        data: { usesCount: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new ConflictException('نفد الحد الأقصى لاستخدام كود الخصم. أعد المحاولة بدون الكود.');
      }
    } else {
      await tx.couponCode.update({ where: { id: coupon.id }, data: { usesCount: { increment: 1 } } });
    }

    await tx.couponRedemption.create({
      data: {
        couponCodeId: coupon.id,
        bookingRequestId,
        customerPhone,
        discountAmountSar,
      },
    });
  }

  async getMine(userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.phone) return [];

    // CouponCode/BookingRequest are declared as required relations, so an
    // `include` throws "Inconsistent query result: Field BookingRequest is
    // required to return data, got null" the moment one redemption points at a
    // booking/coupon row that was deleted outside Prisma (orphaned FK) — which
    // 500s the entire list. Fetch the scalars, resolve the relations
    // separately, and drop any redemption whose booking/coupon is gone.
    const rows = await this.prisma.couponRedemption.findMany({
      where: { customerPhone: user.phone },
      orderBy: { redeemedAt: 'desc' },
    });
    if (rows.length === 0) return [];

    const [bookings, coupons] = await Promise.all([
      this.prisma.bookingRequest.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.bookingRequestId))] } },
        select: { id: true, pickupDate: true },
      }),
      this.prisma.couponCode.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.couponCodeId))] } },
        select: { id: true, code: true },
      }),
    ]);
    const bookingById = new Map(bookings.map((b) => [b.id, b]));
    const couponById = new Map(coupons.map((c) => [c.id, c]));

    return rows.flatMap((r) => {
      const booking = bookingById.get(r.bookingRequestId);
      const coupon = couponById.get(r.couponCodeId);
      if (!booking?.pickupDate || !coupon) return [];
      return [
        {
          id: r.id,
          code: coupon.code,
          discountAmountSar: r.discountAmountSar,
          redeemedAt: r.redeemedAt.toISOString(),
          bookingId: r.bookingRequestId,
          bookingPickupAt: booking.pickupDate.toISOString(),
        },
      ];
    });
  }
}
