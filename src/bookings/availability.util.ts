import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

type Client = Prisma.TransactionClient | PrismaService;

// Non-blocking statuses mirror rentcar's NON_BLOCKING_BOOKING_STATUSES —
// a cancelled/rejected/returned/completed booking no longer occupies the car.
export const NON_BLOCKING_STATUSES = ['CANCELLED', 'REJECTED', 'RETURNED', 'COMPLETED'];

const DAY_MS = 86_400_000;

// Same rounded-division day count the pricing code bills — the availability a
// customer is shown must be for the exact span they would be charged for.
export function daysBetweenDates(pickupAt: Date, returnAt: Date): number {
  return Math.max(1, Math.round((returnAt.getTime() - pickupAt.getTime()) / DAY_MS));
}

// Day-level [start, end) range, UTC-anchored so DST/timezone offsets on the
// stored timestamps can't shift which calendar day a booking starts on.
export function dayRange(pickupDate: Date, days: number): { start: number; end: number } {
  const start = Date.UTC(pickupDate.getUTCFullYear(), pickupDate.getUTCMonth(), pickupDate.getUTCDate());
  return { start, end: start + days * DAY_MS };
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export const availabilityKey = (carModelId: number, branchId: number) => `${carModelId}:${branchId}`;

/**
 * عدد الحجوزات المباشرة الحاجزة للسيارة في الفرع لكل (موديل، فرع) تتقاطع مع
 * الفترة المطلوبة. دالة واحدة يستخدمها البحث (الأسطول) وإنشاء الحجز، فالنتيجة
 * اللي يشوفها العميل في القائمة هي نفسها اللي تتحقق منها آخر خطوة — مفيش
 * منطقين ممكن يختلفوا.
 */
export async function countOverlappingBookings(
  client: Client,
  args: { carModelIds: number[]; branchIds: number[]; pickupAt: Date; days: number },
): Promise<Map<string, number>> {
  const requested = dayRange(args.pickupAt, args.days);
  const rows = await client.bookingRequest.findMany({
    where: {
      kind: 'DIRECT',
      carModelId: { in: args.carModelIds },
      returnBranchId: { in: args.branchIds },
      NOT: { status: { in: NON_BLOCKING_STATUSES } },
      // حجز يبدأ بعد نهاية الفترة المطلوبة لا يمكن أن يتقاطع معها.
      pickupDate: { lt: new Date(requested.end) },
    },
    select: { carModelId: true, returnBranchId: true, pickupDate: true, numberOfDays: true },
  });

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.carModelId == null || row.returnBranchId == null) continue;
    const other = dayRange(row.pickupDate, Math.max(1, row.numberOfDays));
    if (!rangesOverlap(requested.start, requested.end, other.start, other.end)) continue;
    const key = availabilityKey(row.carModelId, row.returnBranchId);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
