import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Deliberately a separate table/key from the website's own
// checkout_payment_methods_v1 (SiteSetting) — the mobile app's payment
// methods are controlled independently via a dedicated "Mobile App Settings"
// admin panel section (built in the rentcar-38ee... project), not tied to
// whatever the website's checkout offers.
const MOBILE_APP_KEY_PAYMENT_METHODS = 'mobile_app_payment_methods_v1';

// Same pattern as MOBILE_APP_KEY_PAYMENT_METHODS — controls which rental
// period tabs and pickup modes show in the home screen's search widget.
// Managed from the same "Mobile App Settings" admin panel section.
const MOBILE_APP_KEY_BOOKING_WIDGET_TABS = 'mobile_app_booking_widget_tabs_v1';

const BOOKING_WIDGET_PERIODS = [
  'rentalDaily',
  'rentalWeekly',
  'rentalMonthly',
  'rentalMonthlyPackages',
] as const;

const BOOKING_WIDGET_MODES = ['modePickup', 'modeDelivery'] as const;

type BookingWidgetPeriod = (typeof BOOKING_WIDGET_PERIODS)[number];
type BookingWidgetMode = (typeof BOOKING_WIDGET_MODES)[number];
type BookingWidgetFlags = Record<BookingWidgetPeriod | BookingWidgetMode, boolean>;

const DEFAULT_BOOKING_WIDGET_FLAGS: BookingWidgetFlags = {
  rentalDaily: true,
  rentalWeekly: true,
  rentalMonthly: true,
  rentalMonthlyPackages: true,
  modePickup: true,
  modeDelivery: true,
};

const CUSTOMER_CHECKOUT_PAYMENT_METHODS = [
  'TABBY',
  'TAMARA',
  'CARD',
  'MADA',
  'AMKAN',
  'CASH',
  'APPLE_PAY',
  'POINTS',
] as const;

type PaymentMethodCode = (typeof CUSTOMER_CHECKOUT_PAYMENT_METHODS)[number];
type PaymentMethodFlags = Record<PaymentMethodCode, boolean>;

// Used only if the MobileAppSetting row is missing entirely — the real
// control is the row itself (see mobile_app_payment_methods_v1).
const DEFAULT_FLAGS: PaymentMethodFlags = {
  TABBY: false,
  TAMARA: false,
  CARD: true,
  MADA: true,
  AMKAN: false,
  CASH: true,
  APPLE_PAY: true,
  POINTS: false,
};

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return fallback;
}

function normalizeFlags(raw: unknown): PaymentMethodFlags {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const flags = {} as PaymentMethodFlags;
  for (const method of CUSTOMER_CHECKOUT_PAYMENT_METHODS) {
    flags[method] = asBool(o[method], DEFAULT_FLAGS[method]);
  }
  const anyEnabled = CUSTOMER_CHECKOUT_PAYMENT_METHODS.some((m) => flags[m]);
  return anyEnabled ? flags : { ...flags, CARD: true };
}

function normalizeBookingWidgetFlags(raw: unknown): BookingWidgetFlags {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  let flags = {} as BookingWidgetFlags;
  for (const key of [...BOOKING_WIDGET_PERIODS, ...BOOKING_WIDGET_MODES]) {
    flags[key] = asBool(o[key], DEFAULT_BOOKING_WIDGET_FLAGS[key]);
  }

  const anyPeriod = BOOKING_WIDGET_PERIODS.some((p) => flags[p]);
  if (!anyPeriod) flags = { ...flags, rentalDaily: true };

  const anyMode = BOOKING_WIDGET_MODES.some((m) => flags[m]);
  if (!anyMode) flags = { ...flags, modePickup: true };

  return flags;
}

@Injectable()
export class SiteSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async listEnabledPaymentMethods(): Promise<PaymentMethodCode[]> {
    const row = await this.prisma.mobileAppSetting.findUnique({
      where: { key: MOBILE_APP_KEY_PAYMENT_METHODS },
      select: { value: true },
    });

    let flags = DEFAULT_FLAGS;
    if (row?.value?.trim()) {
      try {
        flags = normalizeFlags(JSON.parse(row.value));
      } catch {
        flags = DEFAULT_FLAGS;
      }
    }

    return CUSTOMER_CHECKOUT_PAYMENT_METHODS.filter((m) => flags[m]);
  }

  async getBookingWidgetTabFlags(): Promise<BookingWidgetFlags> {
    const row = await this.prisma.mobileAppSetting.findUnique({
      where: { key: MOBILE_APP_KEY_BOOKING_WIDGET_TABS },
      select: { value: true },
    });

    if (!row?.value?.trim()) return DEFAULT_BOOKING_WIDGET_FLAGS;
    try {
      return normalizeBookingWidgetFlags(JSON.parse(row.value));
    } catch {
      return DEFAULT_BOOKING_WIDGET_FLAGS;
    }
  }
}
