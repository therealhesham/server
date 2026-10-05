import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { GeideaOrder, GeideaService } from './geidea.service';

// Matches merchantReferenceId built as `booking-{id}-{timestamp}` in
// GeideaService.createCheckoutSession.
function bookingIdFromReference(ref: string | null): number | null {
  const m = /^booking-(\d+)-\d+$/.exec(ref ?? '');
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isInteger(id) && id >= 1 ? id : null;
}

function isOrderPaid(order: GeideaOrder): boolean {
  return order.detailedStatus.trim().toLowerCase() === 'paid' && order.currency.trim().toUpperCase() === 'SAR' && order.amount > 0;
}

function methodFromBrand(brand: string | null): string | null {
  const b = (brand ?? '').trim().toLowerCase();
  if (!b) return null;
  if (b.includes('apple')) return 'APPLE_PAY';
  if (b.includes('mada')) return 'MADA';
  return 'CARD';
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly geidea: GeideaService,
  ) {}

  async createSession(userId: number, bookingRequestId: number) {
    if (!this.geidea.isConfigured()) {
      throw new BadRequestException('بوابة الدفع غير مهيأة على الخادم.');
    }

    const booking = await this.prisma.bookingRequest.findUnique({ where: { id: bookingRequestId } });
    if (!booking) throw new NotFoundException('الحجز غير موجود.');
    if (booking.customerId !== userId) throw new ForbiddenException('هذا الحجز لا يخصك.');
    if (booking.paymentStatus === 'PAID') throw new BadRequestException('هذا الحجز مدفوع بالفعل.');

    const amountSar = booking.snapshotTotalAmountSar;
    if (!amountSar || amountSar <= 0) throw new BadRequestException('تعذّر تحديد مبلغ الحجز.');

    const session = await this.geidea.createCheckoutSession({ bookingRequestId, amountSar });

    await this.prisma.bookingRequest.update({
      where: { id: bookingRequestId },
      data: { paymentSessionRef: session.merchantReferenceId, updatedAt: new Date() },
    });

    return { redirectUrl: session.redirectUrl };
  }

  // Idempotent — a repeated webhook or a reconcile call landing on an
  // already-PAID booking is a no-op (updateMany's guard clause won't match).
  private async applyPaidOrder(bookingId: number, order: GeideaOrder): Promise<boolean> {
    const now = new Date();
    const gatewayMethod = methodFromBrand(order.paymentBrand);

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.bookingRequest.updateMany({
        where: { id: bookingId, kind: 'DIRECT', paymentStatus: { not: 'PAID' } },
        data: {
          paymentStatus: 'PAID',
          paidAt: now,
          paidAmountSar: order.amount,
          paymentGatewayRef: order.orderId,
          ...(gatewayMethod ? { paymentMethod: gatewayMethod } : {}),
        },
      });
      if (result.count === 0) return false;

      await tx.paymentTransaction.create({
        data: {
          bookingId,
          kind: 'INITIAL_PAYMENT',
          status: 'COMPLETED',
          direction: 'CREDIT',
          amountSar: order.amount,
          method: gatewayMethod,
          actorKind: 'GATEWAY',
          actorName: 'بوابة جيديا',
          gatewayRef: order.orderId,
          sessionRef: order.merchantReferenceId,
        },
      });
      return true;
    });

    return updated;
  }

  // Called from the public webhook route. Never trusts the webhook body
  // beyond the orderId — re-fetches the order server-to-server before
  // touching anything, so a forged notification for a real-but-unpaid or
  // nonexistent order changes nothing.
  async handleWebhookOrderId(orderId: string): Promise<{ handled: boolean; bookingId?: number }> {
    const order = await this.geidea.fetchOrder(orderId);
    const bookingId = bookingIdFromReference(order.merchantReferenceId);
    if (!bookingId) return { handled: false };
    if (!isOrderPaid(order)) return { handled: false, bookingId };

    await this.applyPaidOrder(bookingId, order);
    return { handled: true, bookingId };
  }

  // Covers the case where the customer closes the in-app browser and returns
  // before the webhook has arrived — looks up the same session by reference.
  async reconcile(userId: number, bookingRequestId: number) {
    const booking = await this.prisma.bookingRequest.findUnique({ where: { id: bookingRequestId } });
    if (!booking) throw new NotFoundException('الحجز غير موجود.');
    if (booking.customerId !== userId) throw new ForbiddenException('هذا الحجز لا يخصك.');

    if (booking.paymentStatus === 'PAID') {
      return { paymentStatus: booking.paymentStatus };
    }
    if (!booking.paymentSessionRef || !this.geidea.isConfigured()) {
      return { paymentStatus: booking.paymentStatus };
    }

    const order = await this.geidea.fetchOrderByMerchantReference(booking.paymentSessionRef);
    if (order && isOrderPaid(order)) {
      await this.applyPaidOrder(bookingRequestId, order);
      return { paymentStatus: 'PAID' };
    }
    return { paymentStatus: booking.paymentStatus };
  }
}
