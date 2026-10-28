import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

import { PrismaService } from '../prisma/prisma.service';
import { errorReason, maskPhone } from '../common/logger/error-reason';
import { BookingKycDto } from '../bookings/dto/create-booking.dto';
import { validateKyc } from '../bookings/kyc-validation.util';
import { EvolutionWhatsAppService } from './evolution-whatsapp.service';
import { e164ToEvolutionWhatsAppNumber, saudiLocalNineToE164 } from './phone.util';
import { signSessionToken, verifySessionToken } from './session.util';

// Same constants as rentcar's lib/customer-login-otp.ts.
const OTP_LEN = 4;
const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 45 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;

const SITE_KEY_WHATSAPP_TEMPLATE_LOGIN_OTP = 'whatsapp_template_customer_login_otp';
const DEFAULT_WHATSAPP_TEMPLATE_LOGIN_OTP =
  'رمز تسجيل الدخول في روائس لتأجير السيارات: {otp}\n\nصالح لمدة 10 دقائق.';

const DEFAULT_WHATSAPP_TEMPLATE_CHANGE_PHONE =
  'رمز تأكيد تغيير رقم الجوال في روائس لتأجير السيارات: {otp}\n\nصالح لمدة 10 دقائق.';

// Same non-blocking set as bookings.service.ts — a booking in any other status
// still has the customer's car/money tied up, so the account can't be erased.
const NON_BLOCKING_BOOKING_STATUSES = ['CANCELLED', 'REJECTED', 'RETURNED', 'COMPLETED'];

const PHONE_PLACEHOLDER_EMAIL_DOMAIN = '@phone.rawaes.app';
// User.email is NOT NULL + unique and the table is shared with the website, so a
// deleted account can't be a real DELETE (bookings reference it) nor get a new
// column. It is anonymised in place and tagged with this email domain instead.
const DELETED_ACCOUNT_EMAIL_DOMAIN = '@deleted.rawaes.app';

function loginPhoneDestinationKey(e164: string): string {
  return `login:phone:${e164}`;
}

// Scoped to the user as well as the number: a login OTP for the same number must
// never be accepted here, and one user's pending change can't be completed by another.
function changePhoneDestinationKey(userId: number, e164: string): string {
  return `change-phone:${userId}:${e164}`;
}

function placeholderEmailForPhone(e164: string): string {
  return `${e164.replace('+', '')}${PHONE_PLACEHOLDER_EMAIL_DOMAIN}`;
}

function randomDigits(len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String(Math.floor(Math.random() * 10));
  return s;
}

export interface AuthUser {
  id: number;
  phone: string | null;
  name: string | null;
  email: string;
  kyc: {
    idKind: 'citizen' | 'resident' | 'visitor' | null;
    nationalIdNumber: string | null;
    passportNumber: string | null;
    licenseNumber: string | null;
    licenseExpiryIso: string | null;
    idImageUri: string | null;
    licenseImageUri: string | null;
  };
}

const DOCUMENT_KIND_TO_ID_KIND: Record<string, 'citizen' | 'resident' | 'visitor'> = {
  CITIZEN: 'citizen',
  RESIDENT: 'resident',
  VISITOR: 'visitor',
};

const ID_KIND_TO_DOCUMENT_KIND = { citizen: 'CITIZEN', resident: 'RESIDENT', visitor: 'VISITOR' } as const;

function toAuthUser(user: {
  id: number;
  phone: string | null;
  name: string | null;
  email: string;
  idDocumentKind: string | null;
  nationalIdNumber: string | null;
  passportNumber: string | null;
  licenseNumber: string | null;
  licenseExpiryDate: Date | null;
  idCardImageUrl: string | null;
  driverLicenseImageUrl: string | null;
}): AuthUser {
  return {
    id: user.id,
    phone: user.phone,
    name: user.name,
    email: user.email,
    kyc: {
      idKind: user.idDocumentKind ? (DOCUMENT_KIND_TO_ID_KIND[user.idDocumentKind] ?? null) : null,
      nationalIdNumber: user.nationalIdNumber,
      passportNumber: user.passportNumber,
      licenseNumber: user.licenseNumber,
      licenseExpiryIso: user.licenseExpiryDate ? user.licenseExpiryDate.toISOString().slice(0, 10) : null,
      idImageUri: user.idCardImageUrl,
      licenseImageUri: user.driverLicenseImageUrl,
    },
  };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: EvolutionWhatsAppService,
  ) {}

  async sendOtp(phoneRaw: string): Promise<{ ok: true }> {
    const e164 = saudiLocalNineToE164(phoneRaw);
    if (!e164) {
      throw new BadRequestException('أدخل رقم جوال سعودي صالح (9 أرقام تبدأ بـ 5).');
    }

    await this.issueOtp(e164, loginPhoneDestinationKey(e164), {
      siteKey: SITE_KEY_WHATSAPP_TEMPLATE_LOGIN_OTP,
      fallback: DEFAULT_WHATSAPP_TEMPLATE_LOGIN_OTP,
    });
    return { ok: true };
  }

  // Shared by login and change-phone: cooldown, hashing, storage and the WhatsApp send.
  private async issueOtp(
    e164: string,
    destinationKey: string,
    template: { siteKey: string | null; fallback: string },
  ): Promise<void> {
    // Mobile login OTP is independent of the website's "booking_otp_channel"
    // control-panel setting — that one gates rentcar's own booking flow and
    // isn't something the mobile app's admins control. The only requirement
    // here is that WhatsApp sending itself is configured, via the dedicated
    // "إعدادات تطبيق الموبايل" admin page (MobileAppSetting row), not .env.
    if (!(await this.whatsapp.isConfigured())) {
      throw new BadRequestException('خدمة إرسال رمز تسجيل الدخول عبر واتساب غير مفعّلة من لوحة تحكم إعدادات تطبيق الموبايل.');
    }

    const waNumber = e164ToEvolutionWhatsAppNumber(e164);
    if (!waNumber) {
      throw new BadRequestException('رقم الجوال غير صالح لإرسال واتساب.');
    }

    await this.prisma.customerLoginOtp.deleteMany({ where: { expiresAt: { lt: new Date() } } });

    const existing = await this.prisma.customerLoginOtp.findUnique({
      where: { destinationKey },
      select: { lastSentAt: true },
    });
    if (existing) {
      const elapsed = Date.now() - existing.lastSentAt.getTime();
      if (elapsed < RESEND_COOLDOWN_MS) {
        const retryAfterSec = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
        const message = `انتظر ${retryAfterSec} ثانية قبل طلب رمز جديد.`;
        // The app reads `message`; `error` stays for any existing consumer.
        throw new HttpException({ message, error: message, retryAfterSec }, HttpStatus.TOO_MANY_REQUESTS);
      }
    }

    const otp = randomDigits(OTP_LEN);
    const codeHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    const templateRow = template.siteKey
      ? await this.prisma.siteSetting.findUnique({ where: { key: template.siteKey } })
      : null;
    const message = (templateRow?.value || template.fallback).replace(/\{otp\}/g, otp);

    await this.prisma.customerLoginOtp.upsert({
      where: { destinationKey },
      create: { destinationKey, codeHash, expiresAt, verifyAttempts: 0, lastSentAt: new Date() },
      update: { codeHash, expiresAt, verifyAttempts: 0, lastSentAt: new Date() },
    });

    try {
      await this.whatsapp.sendText(waNumber, message);
    } catch (e) {
      // The customer only sees a generic message — this is the only place an outage of
      // the WhatsApp gateway (bad key, instance disconnected, timeout) shows up.
      this.logger.error({
        msg: 'WhatsApp OTP delivery failed',
        phone: maskPhone(e164),
        reason: errorReason(e),
      });
      await this.discardOtp(destinationKey);
      throw new BadRequestException('تعذّر إرسال رمز التحقق عبر واتساب. حاول لاحقاً.');
    }
  }

  // Best-effort cleanup. "Record not found" is the normal outcome when it was already
  // consumed or expired; anything else means the database is misbehaving.
  private async discardOtp(destinationKey: string): Promise<void> {
    try {
      await this.prisma.customerLoginOtp.delete({ where: { destinationKey } });
    } catch (e: any) {
      if (e?.code !== 'P2025') this.logger.warn({ msg: 'Could not delete OTP row', err: e });
    }
  }

  async verifyOtp(phoneRaw: string, codeRaw: string): Promise<{ token: string; user: AuthUser }> {
    const e164 = saudiLocalNineToE164(phoneRaw);
    if (!e164) {
      throw new BadRequestException('أدخل رقم جوال سعودي صالح (9 أرقام تبدأ بـ 5).');
    }

    await this.consumeOtp(loginPhoneDestinationKey(e164), codeRaw);

    const user = await this.findOrCreateUserByPhone(e164);
    const token = signSessionToken(user.id);
    return { token, user: toAuthUser(user) };
  }

  // Validates the code against the stored hash and burns it on success. Throws a
  // user-facing BadRequestException for every failure mode.
  private async consumeOtp(destinationKey: string, codeRaw: string): Promise<void> {
    const code = String(codeRaw ?? '').replace(/\s+/g, '').trim();
    if (!/^\d{4}$/.test(code)) {
      throw new BadRequestException('أدخل رمز التحقق المكوّن من 4 أرقام.');
    }

    await this.prisma.customerLoginOtp.deleteMany({ where: { expiresAt: { lt: new Date() } } });

    const row = await this.prisma.customerLoginOtp.findUnique({ where: { destinationKey } });
    if (!row) {
      throw new BadRequestException('لم يُعثر على رمز لهذا الرقم. اطلب رمزاً جديداً.');
    }
    if (row.expiresAt.getTime() < Date.now()) {
      await this.discardOtp(destinationKey);
      throw new BadRequestException('انتهت صلاحية الرمز. اطلب رمزاً جديداً.');
    }
    if (row.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
      await this.discardOtp(destinationKey);
      throw new BadRequestException('تجاوزت عدد المحاولات. اطلب رمزاً جديداً.');
    }

    const match = await bcrypt.compare(code, row.codeHash);
    if (!match) {
      await this.prisma.customerLoginOtp.update({
        where: { destinationKey },
        data: { verifyAttempts: { increment: 1 } },
      });
      throw new BadRequestException('رمز التحقق غير صحيح.');
    }

    await this.prisma.customerLoginOtp.delete({ where: { destinationKey } });
  }

  // Passwordless mobile login has no separate signup step — first successful
  // OTP verify for a new phone number creates the account on the spot. User.email
  // is NOT NULL + unique in the shared schema, so a new phone-only account gets a
  // deterministic placeholder the customer can replace later from their profile.
  private async findOrCreateUserByPhone(e164: string) {
    const existing = await this.prisma.user.findUnique({ where: { phone: e164 } });
    if (existing) return existing;

    const placeholderEmail = placeholderEmailForPhone(e164);
    try {
      return await this.prisma.user.create({
        data: { phone: e164, email: placeholderEmail, updatedAt: new Date() },
      });
    } catch (e) {
      const raceWinner = await this.prisma.user.findUnique({ where: { phone: e164 } });
      if (raceWinner) return raceWinner;
      // Not a signup race, so the real cause (DB down, constraint) would otherwise vanish.
      this.logger.error({ msg: 'Account creation failed', phone: maskPhone(e164), err: e });
      throw new BadRequestException('تعذّر إنشاء الحساب. حاول مرة أخرى.');
    }
  }

  async getProfile(userId: number): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('الجلسة غير صالحة.');
    return toAuthUser(user);
  }

  // Session tokens are stateless and live 30 days, so a deleted account's token
  // keeps verifying. Called by AuthGuard on every request to cut that off.
  async assertAccountActive(userId: number): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user || user.email.endsWith(DELETED_ACCOUNT_EMAIL_DOMAIN)) {
      throw new UnauthorizedException('الجلسة غير صالحة.');
    }
  }

  // Step 1 of changing the login number: prove the caller controls the NEW number.
  async sendChangePhoneOtp(userId: number, phoneRaw: string): Promise<{ ok: true }> {
    const e164 = saudiLocalNineToE164(phoneRaw);
    if (!e164) {
      throw new BadRequestException('أدخل رقم جوال سعودي صالح (9 أرقام تبدأ بـ 5).');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
    if (!user) throw new UnauthorizedException('الجلسة غير صالحة.');
    if (user.phone === e164) {
      throw new BadRequestException('هذا هو رقم جوالك الحالي.');
    }
    await this.assertPhoneAvailable(e164);

    await this.issueOtp(e164, changePhoneDestinationKey(userId, e164), {
      siteKey: null,
      fallback: DEFAULT_WHATSAPP_TEMPLATE_CHANGE_PHONE,
    });
    return { ok: true };
  }

  // Step 2: the code is bound to (user, new number), so it can't be replayed for
  // another number or by another account.
  async verifyChangePhone(userId: number, phoneRaw: string, codeRaw: string): Promise<AuthUser> {
    const e164 = saudiLocalNineToE164(phoneRaw);
    if (!e164) {
      throw new BadRequestException('أدخل رقم جوال سعودي صالح (9 أرقام تبدأ بـ 5).');
    }

    await this.consumeOtp(changePhoneDestinationKey(userId, e164), codeRaw);

    const current = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!current) throw new UnauthorizedException('الجلسة غير صالحة.');
    // Re-checked after the code is burned: the number may have been claimed
    // between the send and the verify.
    await this.assertPhoneAvailable(e164);

    const oldPhone = current.phone;
    try {
      const [updated] = await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: userId },
          data: {
            phone: e164,
            // A phone-only account's email is derived from its number. Left as is, the
            // old number's placeholder stays taken and a later signup on that number
            // would fail the unique-email constraint.
            ...(current.email.endsWith(PHONE_PLACEHOLDER_EMAIL_DOMAIN)
              ? { email: placeholderEmailForPhone(e164) }
              : {}),
            updatedAt: new Date(),
          },
        }),
        // Coupon limits and "my coupons" are keyed by phone. Carry this customer's own
        // redemptions over so the change neither hides their history nor resets a
        // per-customer limit. Scoped to their bookings so a number's other past users
        // are left alone.
        ...(oldPhone
          ? [
              this.prisma.couponRedemption.updateMany({
                where: { customerPhone: oldPhone, BookingRequest: { customerId: userId } },
                data: { customerPhone: e164 },
              }),
            ]
          : []),
      ]);
      return toAuthUser(updated);
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new ConflictException('هذا الرقم مرتبط بحساب آخر.');
      }
      throw e;
    }
  }

  private async assertPhoneAvailable(e164: string): Promise<void> {
    const taken = await this.prisma.user.findUnique({ where: { phone: e164 }, select: { id: true } });
    if (taken) throw new ConflictException('هذا الرقم مرتبط بحساب آخر.');
  }

  /**
   * حذف الحساب (مطلوب من متجر آبل). مش DELETE حقيقي: الجدول مشترك مع موقع
   * الشركة والحجوزات بتشاور عليه، وسجلات الحجز والفواتير لازم تفضل. فبنمسح كل
   * بيانات الحساب الشخصية (الجوال، الاسم، الإيميل، بيانات وصور الهوية والرخصة،
   * الإشعارات) ونعلّم الصف بدومين إيميل محذوف.
   *
   * اللي بيفضل: صفوف BookingRequest نفسها — فيها نسخة من اسم العميل وجواله
   * وصور الهوية وقت الحجز، وهي سجل تعاقدي/مالي. لو القانون ما بيطلبش الاحتفاظ بيها
   * لازم تتمسح من الأدمن بعد انتهاء مدة الاحتفاظ.
   */
  async deleteAccount(userId: number): Promise<{ ok: true }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
    if (!user || user.email.endsWith(DELETED_ACCOUNT_EMAIL_DOMAIN)) {
      throw new UnauthorizedException('الجلسة غير صالحة.');
    }

    const openBookings = await this.prisma.bookingRequest.count({
      where: {
        customerId: userId,
        kind: 'DIRECT',
        OR: [
          { NOT: { status: { in: NON_BLOCKING_BOOKING_STATUSES } } },
          // مُلغى أو مرتجع لكن فلوس العميل لسه ماترجعتلوش.
          { refundDueToCustomerSar: { gt: 0 }, refundDueSettledAt: null },
        ],
      },
    });
    if (openBookings > 0) {
      throw new ConflictException(
        'لا يمكن حذف الحساب وعندك حجز جارٍ أو مبلغ مسترد قيد المعالجة. أنهِ الحجز أو الغِه أولاً، ثم أعد المحاولة.',
      );
    }

    const openSubscriptions = await this.prisma.userSubscription.count({
      where: { userId, status: { in: ['PENDING', 'ACTIVE', 'SUSPENDED'] } },
    });
    if (openSubscriptions > 0) {
      throw new ConflictException('لا يمكن حذف الحساب وعندك اشتراك قائم. تواصل معنا لإنهائه أولاً.');
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          phone: null,
          name: null,
          email: `deleted-${userId}${DELETED_ACCOUNT_EMAIL_DOMAIN}`,
          passwordHash: null,
          idDocumentKind: null,
          nationalIdNumber: null,
          passportNumber: null,
          licenseNumber: null,
          licenseExpiryDate: null,
          idCardImageUrl: null,
          driverLicenseImageUrl: null,
          updatedAt: new Date(),
        },
      }),
      this.prisma.notificationPreference.deleteMany({ where: { userId } }),
      // حذف مش فك ربط: الجهاز ممكن يفضل مسجّل كمجهول (زي الخروج)، لكن حساب اتمسح
      // مايبقاش ليه أثر — ولو صاحبه سجّل تاني التطبيق هيعيد تسجيل الجهاز لوحده.
      this.prisma.pushDevice.deleteMany({ where: { userId } }),
    ]);

    return { ok: true };
  }

  // The phone is the verified OTP identity, so it isn't editable here — it only
  // changes through sendChangePhoneOtp/verifyChangePhone.
  async updateProfile(userId: number, data: { name?: string; email?: string }): Promise<AuthUser> {
    const name = data.name?.trim();
    const email = data.email?.trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('البريد الإلكتروني غير صالح.');
    }

    try {
      const user = await this.prisma.user.update({
        where: { id: userId },
        data: {
          ...(name ? { name } : {}),
          ...(email ? { email } : {}),
          updatedAt: new Date(),
        },
      });
      return toAuthUser(user);
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new BadRequestException('البريد الإلكتروني مستخدم بالفعل لحساب آخر.');
      }
      throw e;
    }
  }

  // Lets a customer view/fix the ID + license kept on their account without making
  // a booking (BookingsService.createBooking is otherwise the only writer). Runs the
  // same validateKyc the booking path uses, so the account can't hold data a booking
  // would later reject.
  async updateKyc(userId: number, kyc: BookingKycDto): Promise<AuthUser> {
    const check = validateKyc(kyc);
    if (!check.valid) throw new BadRequestException(check.error);

    const licenseExpiryDate = new Date(kyc.licenseExpiryIso);
    if (Number.isNaN(licenseExpiryDate.getTime())) {
      throw new BadRequestException('تاريخ انتهاء الرخصة غير صالح.');
    }
    const startOfTodayUtc = new Date();
    startOfTodayUtc.setUTCHours(0, 0, 0, 0);
    if (licenseExpiryDate.getTime() < startOfTodayUtc.getTime()) {
      throw new BadRequestException('رخصة القيادة منتهية الصلاحية.');
    }
    // The URLs come from the client and end up rendered in the admin panel.
    for (const url of [kyc.idImageUri, kyc.licenseImageUri]) {
      if (!/^https:\/\//i.test(url)) throw new BadRequestException('رابط الصورة غير صالح.');
    }

    const isVisitor = kyc.idKind === 'visitor';
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        idDocumentKind: ID_KIND_TO_DOCUMENT_KIND[kyc.idKind],
        // Only the number that matches the kind is kept, so switching citizen →
        // visitor doesn't leave a stale national ID behind.
        nationalIdNumber: isVisitor ? null : kyc.nationalIdNumber ?? null,
        passportNumber: isVisitor ? (kyc.passportNumber ?? '').trim().toUpperCase() : null,
        licenseNumber: kyc.licenseNumber,
        licenseExpiryDate,
        idCardImageUrl: kyc.idImageUri,
        driverLicenseImageUrl: kyc.licenseImageUri,
        updatedAt: new Date(),
      },
    });
    return toAuthUser(user);
  }

  async getNotificationPreferences(userId: number): Promise<{ bookingUpdates: boolean; promotions: boolean }> {
    const row = await this.prisma.notificationPreference.findUnique({ where: { userId } });
    return { bookingUpdates: row?.bookingUpdates ?? true, promotions: row?.promotions ?? false };
  }

  async updateNotificationPreferences(
    userId: number,
    data: { bookingUpdates?: boolean; promotions?: boolean },
  ): Promise<{ bookingUpdates: boolean; promotions: boolean }> {
    const row = await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: {
        userId,
        bookingUpdates: data.bookingUpdates ?? true,
        promotions: data.promotions ?? false,
        updatedAt: new Date(),
      },
      update: {
        ...(data.bookingUpdates !== undefined ? { bookingUpdates: data.bookingUpdates } : {}),
        ...(data.promotions !== undefined ? { promotions: data.promotions } : {}),
        updatedAt: new Date(),
      },
    });
    return { bookingUpdates: row.bookingUpdates, promotions: row.promotions };
  }

  /**
   * التوكن مفتاح فريد عالمياً مش لكل مستخدم: لو نفس الموبايل سجّل عليه حساب
   * تاني، الصف بينتقل للحساب الجديد بدل ما يتعمل صف تاني — وإلا الجهاز يفضل
   * مربوط بالحسابين ويستقبل إشعارات حجوزات مش بتاعة اللي داخل دلوقتي.
   */
  async registerPushToken(userId: number, expoPushToken: string, platform?: string): Promise<{ ok: true }> {
    const now = new Date();
    await this.prisma.pushDevice.upsert({
      where: { token: expoPushToken },
      create: {
        userId,
        token: expoPushToken,
        platform: platform ?? 'unknown',
        createdAt: now,
        lastSeenAt: now,
      },
      update: {
        userId,
        ...(platform ? { platform } : {}),
        lastSeenAt: now,
      },
    });
    return { ok: true };
  }

  /**
   * تسجيل جهاز قبل تسجيل الدخول — عشان نقدر نبعتله عروض. مفيش مصادقة هنا
   * بطبيعة الحال، فالحماية في حتتين: صيغة التوكن متحقَّق منها في الـ DTO،
   * والمسار عليه حد معدّل في الكنترولر.
   *
   * مهم: `userId` بيتساب زي ما هو لو الصف موجود — عشان جهاز صاحبه مسجّل دخول
   * ما يترجعش مجهول لمجرد إن التطبيق اتفتح تاني.
   */
  async registerAnonymousPushToken(expoPushToken: string, platform?: string): Promise<{ ok: true }> {
    const now = new Date();
    await this.prisma.pushDevice.upsert({
      where: { token: expoPushToken },
      create: {
        userId: null,
        token: expoPushToken,
        platform: platform ?? 'unknown',
        createdAt: now,
        lastSeenAt: now,
      },
      update: {
        ...(platform ? { platform } : {}),
        lastSeenAt: now,
      },
    });
    return { ok: true };
  }

  /**
   * الخروج بيفك الربط ولا بيحذف: الجهاز يفضل مسجّل كمجهول فيوصله العروض،
   * ومايوصلهوش إشعارات حجوزات الحساب اللي خرج منه.
   * مقيّد بالمستخدم الحالي — من غير القيد ده أي حساب يعرف توكن جهاز تاني
   * يقدر يفصله عن صاحبه.
   */
  async removePushToken(userId: number, expoPushToken: string): Promise<{ ok: true }> {
    await this.prisma.pushDevice.updateMany({
      where: { token: expoPushToken, userId },
      data: { userId: null, lastSeenAt: new Date() },
    });
    return { ok: true };
  }

  resolveUserIdFromToken(token: string): number {
    const uid = verifySessionToken(token);
    if (!uid) throw new UnauthorizedException('الجلسة غير صالحة أو منتهية.');
    return uid;
  }
}
