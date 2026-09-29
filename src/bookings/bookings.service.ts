import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CouponsService, type ResolvedCoupon } from '../coupons/coupons.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { computeBookingPricing, round2 } from './pricing.util';

// Non-blocking statuses mirror rentcar's NON_BLOCKING_BOOKING_STATUSES —
// a cancelled/rejected/returned/completed booking no longer occupies the car.
const NON_BLOCKING_STATUSES = ['CANCELLED', 'REJECTED', 'RETURNED', 'COMPLETED'];

const ID_KIND_TO_DOCUMENT_KIND: Record<string, string> = {
  citizen: 'CITIZEN',
  resident: 'RESIDENT',
  visitor: 'VISITOR',
};

// Day-level [start, end) range, UTC-anchored so DST/timezone offsets on the
// stored timestamps can't shift which calendar day a booking starts on.
function dayRange(pickupDate: Date, days: number): { start: number; end: number } {
  const start = Date.UTC(pickupDate.getUTCFullYear(), pickupDate.getUTCMonth(), pickupDate.getUTCDate());
  return { start, end: start + days * 86_400_000 };
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly couponsService: CouponsService,
  ) {}

  private async sumFleetQuantity(
    carModelId: number,
    branchId: number,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<number> {
    const agg = await client.fleet.aggregate({
      where: { modelId: carModelId, branchId },
      _sum: { quantity: true },
    });
    return Math.max(0, agg._sum.quantity ?? 0);
  }

  private async countOverlapping(
    carModelId: number,
    returnBranchId: number,
    pickupAt: Date,
    days: number,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<number> {
    const rows = await client.bookingRequest.findMany({
      where: {
        kind: 'DIRECT',
        carModelId,
        returnBranchId,
        NOT: { status: { in: NON_BLOCKING_STATUSES } },
      },
      select: { pickupDate: true, numberOfDays: true },
    });
    const requested = dayRange(pickupAt, days);
    let count = 0;
    for (const row of rows) {
      const other = dayRange(row.pickupDate, Math.max(1, row.numberOfDays));
      if (rangesOverlap(requested.start, requested.end, other.start, other.end)) count += 1;
    }
    return count;
  }

  async createBooking(userId: number, dto: CreateBookingDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('الجلسة غير صالحة.');
    if (!user.phone) throw new BadRequestException('رقم جوالك غير مسجّل على الحساب.');

    const pricing = await computeBookingPricing(this.prisma as unknown as PrismaClient, dto);
    const { pickupAt, returnAt, numberOfDays, dailyRate, addons, deliveryFee } = pricing;

    // Resolved (and re-validated) here so a coupon can never be applied
    // twice or on a stale eligibility check between preview and commit.
    let coupon: ResolvedCoupon | null = null;
    let discountAmountSar = 0;
    if (dto.couponCode) {
      coupon = await this.couponsService.resolveCoupon(dto.couponCode, user.phone);
      discountAmountSar = this.couponsService.computeDiscount(coupon, pricing);
    }

    const discountedPreVat = Math.max(0, pricing.preVat - discountAmountSar);
    const vat = round2(discountedPreVat * (pricing.carModel.vatRatePercent / 100));
    const total = round2(discountedPreVat + vat);

    const idDocumentKind = ID_KIND_TO_DOCUMENT_KIND[dto.kyc.idKind];
    const licenseExpiryDate = new Date(dto.kyc.licenseExpiryIso);
    if (Number.isNaN(licenseExpiryDate.getTime())) {
      throw new BadRequestException('تاريخ انتهاء الرخصة غير صالح.');
    }

    const fleetUnits = await this.sumFleetQuantity(dto.carModelId, dto.returnBranchId);
    if (fleetUnits <= 0) {
      throw new ConflictException('لا توجد وحدات لهذا الموديل في فرع الإرجاع.');
    }

    const now = new Date();
    const bookingRequestId = await this.prisma.$transaction(async (tx) => {
      const unitsNow = await this.sumFleetQuantity(dto.carModelId, dto.returnBranchId, tx);
      const overlapNow = await this.countOverlapping(dto.carModelId, dto.returnBranchId, pickupAt, numberOfDays, tx);
      if (overlapNow >= unitsNow) {
        throw new ConflictException('الفترة ممتلئة بالنسبة لعدد السيارات المتاحة في هذا الفرع.');
      }

      const created = await tx.bookingRequest.create({
        data: {
          kind: 'DIRECT',
          carModelId: dto.carModelId,
          customerId: userId,
          fullName: dto.fullName.trim(),
          phone: user.phone!,
          contactEmail: dto.contactEmail?.trim().toLowerCase() ?? user.email,
          ageRange: dto.ageBand,
          carType: pricing.carModel.categorySlug,
          branchId: dto.pickupMode === 'branch' ? dto.pickupBranchId ?? dto.returnBranchId : null,
          returnBranchId: dto.returnBranchId,
          pickupMode: dto.pickupMode.toUpperCase(),
          platform: dto.platform ? `mobile app - ${dto.platform}` : null,
          deliveryLat: dto.deliveryLat ?? null,
          deliveryLng: dto.deliveryLng ?? null,
          deliveryAddress: dto.deliveryAddress ?? null,
          pickupDate: pickupAt,
          numberOfDays,
          termsAccepted: dto.termsAccepted ?? true,
          addonsJson: JSON.stringify(addons),
          paymentMethod: dto.paymentMethodId?.toUpperCase() ?? null,
          idDocumentKind,
          nationalIdNumber: dto.kyc.nationalIdNumber ?? null,
          passportNumber: dto.kyc.passportNumber ?? null,
          licenseNumber: dto.kyc.licenseNumber,
          idCardImageUrl: dto.kyc.idImageUri,
          driverLicenseImageUrl: dto.kyc.licenseImageUri,
          licenseExpiryDate,
          snapshotTotalAmountSar: total,
          updatedAt: now,
        },
        select: { id: true },
      });

      if (coupon && discountAmountSar > 0) {
        await this.couponsService.applyInTransaction(tx, coupon, user.phone!, created.id, discountAmountSar);
      }

      return created.id;
    });

    // Save the same KYC snapshot onto the account so a returning customer's
    // id-verification step comes pre-filled instead of starting from zero.
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        name: dto.fullName.trim(),
        idDocumentKind,
        nationalIdNumber: dto.kyc.nationalIdNumber ?? null,
        passportNumber: dto.kyc.passportNumber ?? null,
        licenseNumber: dto.kyc.licenseNumber,
        idCardImageUrl: dto.kyc.idImageUri,
        driverLicenseImageUrl: dto.kyc.licenseImageUri,
        licenseExpiryDate,
        updatedAt: now,
      },
    });

    return { ok: true, bookingRequestId, totalAmountSar: total, discountAmountSar };
  }

  async getMine(userId: number) {
    const rows = await this.prisma.bookingRequest.findMany({
      where: { customerId: userId, kind: 'DIRECT' },
      orderBy: { pickupDate: 'desc' },
      include: {
        CarModel: { include: { Brand: true } },
        Branch_BookingRequest_branchIdToBranch: { select: { name: true } },
        Branch_BookingRequest_returnBranchIdToBranch: { select: { name: true } },
      },
    });

    return rows.map((row) => {
      const returnAt = new Date(row.pickupDate.getTime() + row.numberOfDays * 86_400_000);
      return {
        id: row.id,
        status: row.status,
        paymentStatus: row.paymentStatus,
        paymentMethod: row.paymentMethod,
        pickupAt: row.pickupDate.toISOString(),
        returnAt: returnAt.toISOString(),
        numberOfDays: row.numberOfDays,
        totalAmountSar: row.snapshotTotalAmountSar,
        car: row.CarModel
          ? { id: row.CarModel.id, make: row.CarModel.Brand.name, model: row.CarModel.name, year: row.CarModel.year, image: row.CarModel.image }
          : null,
        branchName: row.Branch_BookingRequest_branchIdToBranch?.name ?? null,
        returnBranchName: row.Branch_BookingRequest_returnBranchIdToBranch?.name ?? null,
        pickupMode: row.pickupMode,
        deliveryAddress: row.deliveryAddress,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }
}
