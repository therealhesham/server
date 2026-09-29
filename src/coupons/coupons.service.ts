import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { computeBookingPricing, round2, type PricingInput, type PricingResult } from '../bookings/pricing.util';
import {
  buildCouponDiscountLabelAr,
  computeCouponDiscountOnRental,
  computeCouponDiscountOnSubtotal,
  couponAppliesToDaily,
  type CouponAppliesTo,
  type CouponKind,
  type CouponScope,
} from './coupon-pricing.util';
import { ValidateCouponDto } from './dto/validate-coupon.dto';

export interface ResolvedCoupon {
  id: number;
  code: string;
  kind: CouponKind;
  value: number;
  scope: CouponScope;
}

@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}

  // Mirrors rentcar's resolveCouponCode exactly (same checks, same order,
  // same Arabic error copy) so a code behaves identically whether it's
  // entered on the website or in the app.
  async resolveCoupon(rawCode: string, customerPhone: string, now = new Date()): Promise<ResolvedCoupon> {
    const code = rawCode.trim().toUpperCase();
    if (!code) throw new BadRequestException('كود الخصم غير صحيح.');

    const row = await this.prisma.couponCode.findUnique({ where: { code } });
    if (!row) throw new BadRequestException('كود الخصم غير صحيح.');
    if (!row.isActive) throw new BadRequestException('كود الخصم غير مُفعَّل حالياً.');
    if (row.startsAt && now.getTime() < row.startsAt.getTime()) {
      throw new BadRequestException('كود الخصم لم تبدأ صلاحيته بعد.');
    }
    if (row.endsAt && now.getTime() > row.endsAt.getTime()) {
      throw new BadRequestException('انتهت صلاحية كود الخصم.');
    }
    if (!couponAppliesToDaily(row.appliesTo as CouponAppliesTo)) {
      throw new BadRequestException('هذا الكود لا يسري على نوع الحجز في التطبيق.');
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

    return { id: row.id, code: row.code, kind: row.kind as CouponKind, value: row.value, scope: row.scope as CouponScope };
  }

  computeDiscount(coupon: ResolvedCoupon, pricing: PricingResult): number {
    if (coupon.scope === 'RENTAL_ONLY') {
      const raw = computeCouponDiscountOnRental(pricing.dailyRate, pricing.numberOfDays, coupon.kind, coupon.value);
      return Math.min(raw, pricing.subtotal);
    }
    const raw = computeCouponDiscountOnSubtotal(pricing.preVat, coupon.kind, coupon.value);
    return Math.min(raw, pricing.preVat);
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
    };
    const pricing = await computeBookingPricing(this.prisma as unknown as PrismaClient, pricingInput);
    const coupon = await this.resolveCoupon(dto.code, user.phone);
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
    await tx.couponCode.update({ where: { id: coupon.id }, data: { usesCount: { increment: 1 } } });
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

    const rows = await this.prisma.couponRedemption.findMany({
      where: { customerPhone: user.phone },
      orderBy: { redeemedAt: 'desc' },
      include: { CouponCode: true, BookingRequest: { select: { id: true, pickupDate: true } } },
    });

    return rows.map((r) => ({
      id: r.id,
      code: r.CouponCode.code,
      discountAmountSar: r.discountAmountSar,
      redeemedAt: r.redeemedAt.toISOString(),
      bookingId: r.bookingRequestId,
      bookingPickupAt: r.BookingRequest.pickupDate.toISOString(),
    }));
  }
}
