import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

// Mirrors rentcar's lib/geidea/client.ts exactly — same live endpoints, same
// HMAC signature scheme (verified against the real API, not guessed from
// docs), so the credentials already provisioned for that project work here
// unchanged.
interface GeideaConfig {
  publicKey: string;
  apiPassword: string;
  apiBase: string;
  hppBase: string;
}

export interface GeideaSession {
  sessionId: string;
  redirectUrl: string;
  merchantReferenceId: string;
}

export interface GeideaOrder {
  orderId: string;
  status: string;
  detailedStatus: string;
  amount: number;
  currency: string;
  merchantReferenceId: string | null;
  paymentBrand: string | null;
}

@Injectable()
export class GeideaService {
  private getConfig(): GeideaConfig | null {
    const publicKey = process.env.GEIDEA_PUBLIC_KEY?.trim();
    const apiPassword = process.env.GEIDEA_API_PASSWORD?.trim();
    if (!publicKey || !apiPassword) return null;
    return {
      publicKey,
      apiPassword,
      apiBase: (process.env.GEIDEA_API_BASE?.trim() || 'https://api.ksamerchant.geidea.net').replace(/\/$/, ''),
      hppBase: (process.env.GEIDEA_HPP_BASE?.trim() || 'https://www.ksamerchant.geidea.net').replace(/\/$/, ''),
    };
  }

  isConfigured(): boolean {
    return this.getConfig() != null;
  }

  private formatAmount(amountSar: number): string {
    return (Math.round(amountSar * 100) / 100).toFixed(2);
  }

  private isoTimestamp(): string {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  private hmacBase64(data: string, key: string): string {
    return crypto.createHmac('sha256', key).update(data).digest('base64');
  }

  private async fetchJson<T>(cfg: GeideaConfig, path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<T> {
    const res = await fetch(`${cfg.apiBase}${path}`, {
      method: init.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${cfg.publicKey}:${cfg.apiPassword}`).toString('base64')}`,
      },
      body: init.body != null ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Geidea ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Geidea ${path} -> invalid JSON response`);
    }
  }

  // Amount always comes from the booking's own server-side price snapshot in
  // PaymentsService, never from the client — same rule rentcar's checkout enforces.
  async createCheckoutSession(args: { bookingRequestId: number; amountSar: number; language?: 'ar' | 'en' }): Promise<GeideaSession> {
    const cfg = this.getConfig();
    if (!cfg) throw new Error('Geidea غير مهيأة — أضف مفاتيح البيئة.');

    const amount = this.formatAmount(args.amountSar);
    const currency = 'SAR';
    const merchantReferenceId = `booking-${args.bookingRequestId}-${Date.now()}`;
    const timestamp = this.isoTimestamp();
    const signature = this.hmacBase64(`${cfg.publicKey}${amount}${currency}${merchantReferenceId}${timestamp}`, cfg.apiPassword);

    const data = await this.fetchJson<{
      session?: { id?: string };
      responseCode?: string;
      responseMessage?: string;
      detailedResponseMessage?: string;
    }>(cfg, '/payment-intent/api/v2/direct/session', {
      method: 'POST',
      body: {
        amount,
        currency,
        timestamp,
        merchantReferenceId,
        signature,
        paymentOperation: 'Pay',
        language: args.language ?? 'ar',
      },
    });

    const sessionId = data.session?.id;
    if (data.responseCode !== '000' || !sessionId) {
      throw new Error(`Geidea session failed: ${data.responseCode} ${data.detailedResponseMessage ?? data.responseMessage ?? ''}`);
    }

    return {
      sessionId,
      redirectUrl: `${cfg.hppBase}/hpp/checkout/?${sessionId}`,
      merchantReferenceId,
    };
  }

  private normalizeOrder(o: {
    orderId?: string;
    status?: string;
    detailedStatus?: string;
    amount?: number;
    totalAmount?: number;
    currency?: string;
    merchantReferenceId?: string;
    paymentMethod?: { brand?: string; wallet?: string | null } | null;
  }): GeideaOrder {
    const wallet = o.paymentMethod?.wallet?.trim();
    return {
      orderId: o.orderId ?? '',
      status: o.status ?? '',
      detailedStatus: o.detailedStatus ?? '',
      amount: Number(o.totalAmount ?? o.amount ?? 0),
      currency: o.currency ?? '',
      merchantReferenceId: o.merchantReferenceId ?? null,
      paymentBrand: wallet || o.paymentMethod?.brand?.trim() || null,
    };
  }

  // Server-to-server lookup — the source of truth for confirming a payment.
  // Never trust the webhook body itself, only the orderId it points to.
  async fetchOrder(orderId: string): Promise<GeideaOrder> {
    const cfg = this.getConfig();
    if (!cfg) throw new Error('Geidea غير مهيأة — أضف مفاتيح البيئة.');
    const data = await this.fetchJson<{ order?: Record<string, unknown>; responseCode?: string; responseMessage?: string }>(
      cfg,
      `/pgw/api/v1/direct/order/${encodeURIComponent(orderId)}`,
      { method: 'GET' },
    );
    const o = data.order;
    if (!o?.orderId) throw new Error(`Geidea order fetch failed: ${data.responseCode} ${data.responseMessage ?? ''}`);
    return this.normalizeOrder(o as any);
  }

  // Used to reconcile when the customer returns to the app before the
  // webhook arrives — looks up by our own merchantReferenceId instead.
  async fetchOrderByMerchantReference(merchantReferenceId: string): Promise<GeideaOrder | null> {
    const cfg = this.getConfig();
    if (!cfg) throw new Error('Geidea غير مهيأة — أضف مفاتيح البيئة.');
    const data = await this.fetchJson<{ orders?: Record<string, unknown>[] }>(
      cfg,
      `/pgw/api/v1/direct/order?Reference=${encodeURIComponent(merchantReferenceId)}&Take=1`,
      { method: 'GET' },
    );
    const o = data.orders?.find((x) => x.merchantReferenceId === merchantReferenceId);
    if (!o?.orderId) return null;
    return this.normalizeOrder(o as any);
  }
}
