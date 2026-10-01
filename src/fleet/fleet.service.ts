import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
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

    // Without a branch filter, the same CarModel can appear at several
    // branches — collapse to one card per model showing its cheapest price.
    const byModel = new Map<number, (typeof fleetRows)[number]>();
    for (const row of fleetRows) {
      const existing = byModel.get(row.modelId);
      const rowPrice = row.pricePerDayExclTax ?? row.CarModel.minPricePerDayExclTax ?? Infinity;
      const existingPrice = existing
        ? existing.pricePerDayExclTax ?? existing.CarModel.minPricePerDayExclTax ?? Infinity
        : Infinity;
      if (!existing || rowPrice < existingPrice) byModel.set(row.modelId, row);
    }

    return [...byModel.values()].map((row) => this.toCarSummary(row));
  }

  async getCar(modelId: number, branchId?: number) {
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

    const cheapestFleet = carModel.Fleet[0];

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
      pricePerDay: cheapestFleet?.pricePerDayExclTax ?? carModel.minPricePerDayExclTax ?? null,
      priceMonthly: cheapestFleet?.priceMonthlyExclTax ?? carModel.minPriceMonthlyExclTax ?? null,
      vatRatePercent: carModel.vatRatePercent,
      availability: carModel.Fleet.map((f) => ({
        branchId: f.branchId,
        branchName: f.Branch.name,
        quantity: f.quantity,
        pricePerDay: f.pricePerDayExclTax,
        priceMonthly: f.priceMonthlyExclTax,
      })),
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
      minPricePerDayExclTax: number | null;
      vatRatePercent: number;
      Brand: { name: string; nameEn: string | null };
      FleetCategory: { slug: string; title: string };
    };
    Branch: { id: number; name: string; slug: string };
  }) {
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
      pricePerDay: row.pricePerDayExclTax ?? row.CarModel.minPricePerDayExclTax ?? null,
      vatRatePercent: row.CarModel.vatRatePercent,
      branch: { id: row.Branch.id, name: row.Branch.name, slug: row.Branch.slug },
      quantityAvailable: row.quantity,
    };
  }
}

function safeParseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
