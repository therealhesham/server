import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

// Mirrors rentcar's lib/mobile-app-whatsapp-otp-config.ts exactly — same
// MobileAppSetting key/shape, edited from rentcar's "إعدادات تطبيق الموبايل"
// admin page. This is the sole source of truth: no .env fallback, so a
// credential change on the admin page takes effect immediately without
// touching or redeploying this server.
const MOBILE_APP_KEY_WHATSAPP_OTP_CONFIG = 'mobile_app_whatsapp_otp_config_v1';

interface WhatsAppOtpConfig {
  enabled: boolean;
  apiBaseUrl: string;
  apiKey: string;
  instanceName: string;
}

const EMPTY_CONFIG: WhatsAppOtpConfig = { enabled: false, apiBaseUrl: '', apiKey: '', instanceName: '' };

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return fallback;
}

function asString(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function normalizeConfig(raw: unknown): WhatsAppOtpConfig {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    enabled: asBool(o.enabled, EMPTY_CONFIG.enabled),
    apiBaseUrl: asString(o.apiBaseUrl, EMPTY_CONFIG.apiBaseUrl).trim(),
    apiKey: asString(o.apiKey, EMPTY_CONFIG.apiKey).trim(),
    instanceName: asString(o.instanceName, EMPTY_CONFIG.instanceName).trim(),
  };
}

@Injectable()
export class EvolutionWhatsAppService {
  constructor(private readonly prisma: PrismaService) {}

  private async getConfig(): Promise<WhatsAppOtpConfig> {
    const row = await this.prisma.mobileAppSetting.findUnique({
      where: { key: MOBILE_APP_KEY_WHATSAPP_OTP_CONFIG },
      select: { value: true },
    });
    if (!row?.value?.trim()) return EMPTY_CONFIG;
    try {
      return normalizeConfig(JSON.parse(row.value));
    } catch {
      return EMPTY_CONFIG;
    }
  }

  async isConfigured(): Promise<boolean> {
    const c = await this.getConfig();
    return c.enabled && Boolean(c.apiBaseUrl && c.apiKey && c.instanceName);
  }

  async sendText(number: string, text: string): Promise<void> {
    const c = await this.getConfig();
    if (!(c.enabled && c.apiBaseUrl && c.apiKey && c.instanceName)) {
      throw new Error('خدمة واتساب لرمز تسجيل الدخول غير مفعّلة من لوحة تحكم إعدادات تطبيق الموبايل.');
    }
    const base = c.apiBaseUrl.replace(/\/+$/, '');
    const url = `${base}/message/sendText/${encodeURIComponent(c.instanceName)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: c.apiKey },
        body: JSON.stringify({ number, text, options: { linkPreview: false } }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 500)}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
