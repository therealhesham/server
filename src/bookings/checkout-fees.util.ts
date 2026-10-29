import { PrismaClient } from '@prisma/client';

// نفس شكل CheckoutOneTimeFeeSnap في newrent (lib/booking-pricing-snapshot.ts).
export interface CheckoutOneTimeFeeSnap {
  slug: string;
  labelAr: string;
  feeExclVatSar: number;
}

/**
 * رسوم إتمام الحجز النشطة التي تديرها الإدارة (جدول CheckoutOneTimeFee) —
 * مطابقة لـ getActiveCheckoutOneTimeFees في newrent: كل رسم نشط بمبلغ أكبر من
 * صفر يُضاف لكل حجز، ريالاً كاملاً دون ضريبة.
 */
export async function getActiveCheckoutOneTimeFees(prisma: PrismaClient): Promise<CheckoutOneTimeFeeSnap[]> {
  const rows = await prisma.checkoutOneTimeFee.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: { slug: true, labelAr: true, feeExclVatSar: true },
  });
  return rows
    .filter((r) => r.feeExclVatSar > 0)
    .map((r) => ({
      slug: r.slug.trim().toLowerCase(),
      labelAr: r.labelAr.trim(),
      feeExclVatSar: Math.round(r.feeExclVatSar),
    }));
}
