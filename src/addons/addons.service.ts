import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AddonsService {
  constructor(private readonly prisma: PrismaService) {}

  // Mirrors rentcar's getActiveRentalAddons (lib/rental-addon-data.ts) —
  // same active/sortOrder rules, Arabic fields only (this app has no locale switch yet).
  async listActive() {
    const rows = await this.prisma.rentalAddon.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        slug: true,
        titleAr: true,
        descriptionAr: true,
        infoAr: true,
        pricePerDay: true,
        iconKey: true,
        exclusiveGroup: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      title: r.titleAr,
      description: r.descriptionAr,
      info: r.infoAr,
      pricePerDay: r.pricePerDay,
      iconKey: r.iconKey,
      exclusiveGroup: r.exclusiveGroup,
    }));
  }
}
