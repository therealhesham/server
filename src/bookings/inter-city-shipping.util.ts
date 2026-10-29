import { PrismaClient } from '@prisma/client';

// نفس شكل InterCityShippingSnap في newrent (lib/inter-city-shipping.ts) — يُخزَّن
// داخل addonsJson ويقرأه مفسّر اللقطة والفاتورة هناك كما هو.
export interface InterCityShippingSnap {
  fromCitySlug: string;
  toCitySlug: string;
  feeExclVatSar: number;
  labelAr: string;
}

/**
 * رسوم شحن لمرة واحدة (دون ضريبة) عندما تختلف مدينة الاستلام/التوصيل عن مدينة
 * فرع الإرجاع. الاتجاه «من ← إلى» تحدده الإدارة، فمسار غير معرَّف أو برسوم صفر
 * يعني لا رسوم — مثل newrent's resolveInterCityShippingSnap.
 */
export async function resolveInterCityShippingSnap(
  prisma: PrismaClient,
  originBranchId: number,
  returnBranchId: number,
): Promise<InterCityShippingSnap | null> {
  if (originBranchId === returnBranchId) return null;

  const [origin, destination] = await Promise.all([
    prisma.branch.findFirst({
      where: { id: originBranchId, isActive: true },
      select: { cityId: true, City: { select: { slug: true, name: true, isActive: true } } },
    }),
    prisma.branch.findFirst({
      where: { id: returnBranchId, isActive: true },
      select: { cityId: true, City: { select: { slug: true, name: true, isActive: true } } },
    }),
  ]);
  if (!origin?.City.isActive || !destination?.City.isActive) return null;
  if (origin.cityId === destination.cityId) return null;

  const rule = await prisma.interCityShippingFee.findFirst({
    where: { isActive: true, fromCityId: origin.cityId, toCityId: destination.cityId },
    select: { feeExclVatSar: true },
  });
  if (!rule || rule.feeExclVatSar <= 0) return null;

  return {
    fromCitySlug: origin.City.slug.trim().toLowerCase(),
    toCitySlug: destination.City.slug.trim().toLowerCase(),
    feeExclVatSar: rule.feeExclVatSar,
    labelAr: `رسوم شحن بين المدن (${origin.City.name.trim()} → ${destination.City.name.trim()})`,
  };
}
