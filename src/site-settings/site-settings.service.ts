import { Injectable, Logger } from '@nestjs/common';
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

// Direct contact channels shown on the "تواصل معنا" screen. Not in the repo on
// purpose: set this MobileAppSetting row to {"phone":"+9665…","whatsapp":"+9665…",
// "email":"…"}; any missing/invalid field is simply not offered by the app.
const MOBILE_APP_KEY_CONTACT = 'mobile_app_contact_v1';

// Same pattern — hides the self-service "إلغاء الحجز" button on the booking
// detail screen when disabled. Purely a UI toggle: the server-side cancel
// endpoint and admin-panel cancellation still work regardless of this flag.
const MOBILE_APP_KEY_BOOKING_CANCEL_BUTTON = 'mobile_app_booking_cancel_button_v1';

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

export interface ContactInfo {
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
}

// Values end up in tel:/wa.me/mailto: links, so only well-formed ones pass through.
function cleanPhone(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const p = v.replace(/[\s-]/g, '');
  return /^\+?\d{8,15}$/.test(p) ? p : null;
}

function cleanEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const e = v.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 255 ? e : null;
}

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
  private readonly logger = new Logger(SiteSettingsService.name);

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
        // Falls back to the built-in defaults, which may enable methods the admin turned off.
        this.logger.warn({ msg: `${MOBILE_APP_KEY_PAYMENT_METHODS} holds invalid JSON; using defaults` });
        flags = DEFAULT_FLAGS;
      }
    }

    return CUSTOMER_CHECKOUT_PAYMENT_METHODS.filter((m) => flags[m]);
  }

  async listRentalTerms(): Promise<{ id: number; title: string; body: string }[]> {
    const rows = await this.prisma.rentalTerm.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, titleAr: true, bodyAr: true },
    });
    return rows.map((r) => ({ id: r.id, title: r.titleAr, body: r.bodyAr }));
  }

  async getContactInfo(): Promise<ContactInfo> {
    const empty: ContactInfo = { phone: null, whatsapp: null, email: null };
    const row = await this.prisma.mobileAppSetting.findUnique({
      where: { key: MOBILE_APP_KEY_CONTACT },
      select: { value: true },
    });
    if (!row?.value?.trim()) return empty;
    try {
      const o = JSON.parse(row.value) as Record<string, unknown>;
      return { phone: cleanPhone(o.phone), whatsapp: cleanPhone(o.whatsapp), email: cleanEmail(o.email) };
    } catch {
      this.logger.warn({ msg: `${MOBILE_APP_KEY_CONTACT} holds invalid JSON; no contact channels offered` });
      return empty;
    }
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
      this.logger.warn({ msg: `${MOBILE_APP_KEY_BOOKING_WIDGET_TABS} holds invalid JSON; using defaults` });
      return DEFAULT_BOOKING_WIDGET_FLAGS;
    }
  }

  async getBookingCancelButtonEnabled(): Promise<boolean> {
    const row = await this.prisma.mobileAppSetting.findUnique({
      where: { key: MOBILE_APP_KEY_BOOKING_CANCEL_BUTTON },
      select: { value: true },
    });

    if (!row?.value?.trim()) return true;
    try {
      const o = JSON.parse(row.value) as Record<string, unknown>;
      return asBool(o.enabled, true);
    } catch {
      this.logger.warn({ msg: `${MOBILE_APP_KEY_BOOKING_CANCEL_BUTTON} holds invalid JSON; using default (enabled)` });
      return true;
    }
  }
}
