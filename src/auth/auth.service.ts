import { BadRequestException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

import { PrismaService } from '../prisma/prisma.service';
import { EvolutionWhatsAppService } from './evolution-whatsapp.service';
import { e164ToEvolutionWhatsAppNumber, saudiLocalNineToE164 } from './phone.util';
import { signSessionToken, verifySessionToken } from './session.util';

// Same constants as rentcar's lib/customer-login-otp.ts.
const OTP_LEN = 4;
const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 45 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;

const SITE_KEY_BOOKING_OTP_CHANNEL = 'booking_otp_channel';
const SITE_KEY_WHATSAPP_TEMPLATE_LOGIN_OTP = 'whatsapp_template_customer_login_otp';
const DEFAULT_WHATSAPP_TEMPLATE_LOGIN_OTP =
  'رمز تسجيل الدخول في روائس لتأجير السيارات: {otp}\n\nصالح لمدة 10 دقائق.';

function loginPhoneDestinationKey(e164: string): string {
  return `login:phone:${e164}`;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: EvolutionWhatsAppService,
  ) {}

  private async getOtpChannel(): Promise<'OFF' | 'SMS' | 'EMAIL' | 'WHATSAPP'> {
    const row = await this.prisma.siteSetting.findUnique({ where: { key: SITE_KEY_BOOKING_OTP_CHANNEL } });
    const v = String(row?.value ?? '').trim().toUpperCase();
    return v === 'SMS' || v === 'EMAIL' || v === 'WHATSAPP' ? v : 'OFF';
  }

  async sendOtp(phoneRaw: string): Promise<{ ok: true }> {
    const e164 = saudiLocalNineToE164(phoneRaw);
    if (!e164) {
      throw new BadRequestException('أدخل رقم جوال سعودي صالح (9 أرقام تبدأ بـ 5).');
    }

    const channel = await this.getOtpChannel();
    if (channel === 'OFF') {
      throw new BadRequestException('خدمة رمز تسجيل الدخول غير مفعّلة من لوحة التحكم.');
    }
    if (channel !== 'WHATSAPP') {
      throw new BadRequestException('قناة إرسال الرمز الحالية غير مدعومة في التطبيق بعد.');
    }

    const waNumber = e164ToEvolutionWhatsAppNumber(e164);
    if (!waNumber) {
      throw new BadRequestException('رقم الجوال غير صالح لإرسال واتساب.');
    }

    const destinationKey = loginPhoneDestinationKey(e164);

    await this.prisma.customerLoginOtp.deleteMany({ where: { expiresAt: { lt: new Date() } } });

    const existing = await this.prisma.customerLoginOtp.findUnique({
      where: { destinationKey },
      select: { lastSentAt: true },
    });
    if (existing) {
      const elapsed = Date.now() - existing.lastSentAt.getTime();
      if (elapsed < RESEND_COOLDOWN_MS) {
        const retryAfterSec = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
        throw new HttpException(
          { error: `انتظر ${retryAfterSec} ثانية قبل طلب رمز جديد.`, retryAfterSec },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const otp = randomDigits(OTP_LEN);
    const codeHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    const templateRow = await this.prisma.siteSetting.findUnique({
      where: { key: SITE_KEY_WHATSAPP_TEMPLATE_LOGIN_OTP },
    });
    const message = (templateRow?.value || DEFAULT_WHATSAPP_TEMPLATE_LOGIN_OTP).replace(/\{otp\}/g, otp);

    await this.prisma.customerLoginOtp.upsert({
      where: { destinationKey },
      create: { destinationKey, codeHash, expiresAt, verifyAttempts: 0, lastSentAt: new Date() },
      update: { codeHash, expiresAt, verifyAttempts: 0, lastSentAt: new Date() },
    });

    try {
      await this.whatsapp.sendText(waNumber, message);
    } catch (e) {
      await this.prisma.customerLoginOtp.delete({ where: { destinationKey } }).catch(() => {});
      throw new BadRequestException('تعذّر إرسال رمز التحقق عبر واتساب. حاول لاحقاً.');
    }

    return { ok: true };
  }

  async verifyOtp(phoneRaw: string, codeRaw: string): Promise<{ token: string; user: AuthUser }> {
    const e164 = saudiLocalNineToE164(phoneRaw);
    if (!e164) {
      throw new BadRequestException('أدخل رقم جوال سعودي صالح (9 أرقام تبدأ بـ 5).');
    }
    const code = String(codeRaw ?? '').replace(/\s+/g, '').trim();
    if (!/^\d{4}$/.test(code)) {
      throw new BadRequestException('أدخل رمز التحقق المكوّن من 4 أرقام.');
    }

    const destinationKey = loginPhoneDestinationKey(e164);
    await this.prisma.customerLoginOtp.deleteMany({ where: { expiresAt: { lt: new Date() } } });

    const row = await this.prisma.customerLoginOtp.findUnique({ where: { destinationKey } });
    if (!row) {
      throw new BadRequestException('لم يُعثر على رمز لهذا الرقم. اطلب رمزاً جديداً.');
    }
    if (row.expiresAt.getTime() < Date.now()) {
      await this.prisma.customerLoginOtp.delete({ where: { destinationKey } }).catch(() => {});
      throw new BadRequestException('انتهت صلاحية الرمز. اطلب رمزاً جديداً.');
    }
    if (row.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
      await this.prisma.customerLoginOtp.delete({ where: { destinationKey } }).catch(() => {});
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

    const user = await this.findOrCreateUserByPhone(e164);
    const token = signSessionToken(user.id);
    return { token, user: toAuthUser(user) };
  }

  // Passwordless mobile login has no separate signup step — first successful
  // OTP verify for a new phone number creates the account on the spot. User.email
  // is NOT NULL + unique in the shared schema, so a new phone-only account gets a
  // deterministic placeholder the customer can replace later from their profile.
  private async findOrCreateUserByPhone(e164: string) {
    const existing = await this.prisma.user.findUnique({ where: { phone: e164 } });
    if (existing) return existing;

    const placeholderEmail = `${e164.replace('+', '')}@phone.rawaes.app`;
    try {
      return await this.prisma.user.create({
        data: { phone: e164, email: placeholderEmail, updatedAt: new Date() },
      });
    } catch {
      const raceWinner = await this.prisma.user.findUnique({ where: { phone: e164 } });
      if (raceWinner) return raceWinner;
      throw new BadRequestException('تعذّر إنشاء الحساب. حاول مرة أخرى.');
    }
  }

  async getProfile(userId: number): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('الجلسة غير صالحة.');
    return toAuthUser(user);
  }

  // Phone is intentionally not editable here — it's the verified OTP
  // identity for the account; changing it would need a fresh OTP flow.
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

  resolveUserIdFromToken(token: string): number {
    const uid = verifySessionToken(token);
    if (!uid) throw new UnauthorizedException('الجلسة غير صالحة أو منتهية.');
    return uid;
  }
}
