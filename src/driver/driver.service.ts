import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';

import { saudiLocalNineToE164 } from '../auth/phone.util';
import { PrismaService } from '../prisma/prisma.service';
import { signDriverToken } from './driver-session.util';

export type TripType = 'DELIVERY' | 'RETURN';

export type DriverTrip = {
  bookingId: number;
  type: TripType;
  customerName: string;
  customerPhone: string;
  lat: number | null;
  lng: number | null;
  address: string | null;
  /** ISO — موعد التسليم (تاريخ الاستلام) أو موعد الاستلام من العميل (نفس الساعة + عدد الأيام). */
  scheduledAt: string;
  carLabel: string;
  mapsUrl: string | null;
};

// Same rule as rentcar's computeBookingReturnAt: pickup instant + N whole days, N clamped to 1..60.
const MIN_DAYS = 1;
const MAX_DAYS = 60;

const TERMINAL_STATUSES = ['CANCELLED', 'REJECTED', 'RETURNED'];

// Explicit select — never `include`/no-select here. This API is the privacy boundary:
// no prices, payment, e-mail, KYC images or admin notes may reach the driver app.
const TRIP_SELECT = {
  id: true,
  fullName: true,
  phone: true,
  carType: true,
  vehiclePlateNumber: true,
  pickupDate: true,
  numberOfDays: true,
  deliveryLat: true,
  deliveryLng: true,
  deliveryAddress: true,
  returnLat: true,
  returnLng: true,
  returnAddress: true,
} as const;

type TripRow = {
  id: number;
  fullName: string;
  phone: string;
  carType: string;
  vehiclePlateNumber: string | null;
  pickupDate: Date;
  numberOfDays: number;
  deliveryLat: number | null;
  deliveryLng: number | null;
  deliveryAddress: string | null;
  returnLat: number | null;
  returnLng: number | null;
  returnAddress: string | null;
};

// Compared against when the phone is unknown so a miss costs the same bcrypt time as a
// wrong password — the response time can't be used to enumerate driver phones.
const DUMMY_HASH = bcrypt.hashSync(randomBytes(16).toString('hex'), 10);

/** يقبل 05XXXXXXXX أو 5XXXXXXXX أو +9665XXXXXXXX ويعيد صيغة التخزين +9665XXXXXXXX. */
function normalizeDriverPhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('966')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return saudiLocalNineToE164(digits);
}

function mapsUrlFor(lat: number | null, lng: number | null): string | null {
  if (lat == null || lng == null) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

function returnAt(pickupDate: Date, numberOfDays: number): Date {
  const n = Math.round(Number(numberOfDays));
  const days = Math.max(MIN_DAYS, Math.min(MAX_DAYS, Number.isFinite(n) ? n : MIN_DAYS));
  const d = new Date(pickupDate.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function toTrip(row: TripRow, type: TripType): DriverTrip {
  const isDelivery = type === 'DELIVERY';
  const lat = isDelivery ? row.deliveryLat : row.returnLat;
  const lng = isDelivery ? row.deliveryLng : row.returnLng;
  const address = (isDelivery ? row.deliveryAddress : row.returnAddress)?.trim() || null;
  const plate = row.vehiclePlateNumber?.trim();

  return {
    bookingId: row.id,
    type,
    customerName: row.fullName,
    customerPhone: row.phone,
    lat,
    lng,
    address,
    scheduledAt: (isDelivery ? row.pickupDate : returnAt(row.pickupDate, row.numberOfDays)).toISOString(),
    carLabel: plate ? `${row.carType} · ${plate}` : row.carType,
    mapsUrl: mapsUrlFor(lat, lng),
  };
}

@Injectable()
export class DriverService {
  constructor(private readonly prisma: PrismaService) {}

  async login(phoneRaw: string, password: string) {
    const phone = normalizeDriverPhone(phoneRaw);
    const driver = phone
      ? await this.prisma.deliveryDriver.findUnique({ where: { phone } })
      : null;

    const passwordOk = await bcrypt.compare(password, driver?.passwordHash ?? DUMMY_HASH);
    // One message for unknown phone / wrong password / disabled driver.
    if (!driver || !passwordOk || !driver.isActive) {
      throw new UnauthorizedException('رقم الجوال أو كلمة المرور غير صحيحة.');
    }

    return {
      token: signDriverToken(driver.id),
      driver: { id: driver.id, name: driver.name, phone: driver.phone },
    };
  }

  async me(driverId: number) {
    const driver = await this.prisma.deliveryDriver.findUnique({
      where: { id: driverId },
      select: { id: true, name: true, phone: true },
    });
    if (!driver) throw new UnauthorizedException('الجلسة غير صالحة.');
    return driver;
  }

  /** الرحلات الجارية فقط، الأقرب موعداً أولاً. */
  async listTrips(driverId: number): Promise<DriverTrip[]> {
    const [deliveries, returns] = await Promise.all([
      this.prisma.bookingRequest.findMany({
        where: this.deliveryWhere(driverId),
        select: TRIP_SELECT,
      }),
      this.prisma.bookingRequest.findMany({
        where: this.returnWhere(driverId),
        select: TRIP_SELECT,
      }),
    ]);

    return [
      ...deliveries.map((r) => toTrip(r, 'DELIVERY')),
      ...returns.map((r) => toTrip(r, 'RETURN')),
    ].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  }

  async getTrip(driverId: number, bookingId: number, typeRaw: string | undefined): Promise<DriverTrip> {
    if (typeRaw !== 'DELIVERY' && typeRaw !== 'RETURN') {
      throw new BadRequestException('نوع الرحلة غير صالح (DELIVERY أو RETURN).');
    }
    const type: TripType = typeRaw;

    const row = await this.prisma.bookingRequest.findFirst({
      where: { id: bookingId, ...(type === 'DELIVERY' ? this.deliveryWhere(driverId) : this.returnWhere(driverId)) },
      select: TRIP_SELECT,
    });
    // 404 (not 403) for a booking assigned to someone else: don't confirm it exists.
    if (!row) throw new NotFoundException('الرحلة غير موجودة.');
    return toTrip(row, type);
  }

  private baseActiveWhere() {
    return {
      cancelledAt: null,
      isHidden: false,
      status: { notIn: TERMINAL_STATUSES },
    };
  }

  private deliveryWhere(driverId: number) {
    return {
      ...this.baseActiveWhere(),
      deliveryDriverId: driverId,
      pickupMode: 'DELIVERY',
      vehiclePickedUpAt: null,
    };
  }

  private returnWhere(driverId: number) {
    return {
      ...this.baseActiveWhere(),
      returnDriverId: driverId,
      returnMode: 'DELIVERY',
      vehicleReturnedAt: null,
    };
  }
}
