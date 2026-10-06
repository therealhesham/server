/**
 * نداء مسارات `/api/internal/*` على rentcar.
 *
 * الإلغاء والاسترداد منطق مالي مكتوب ومجرَّب في rentcar — إعادة كتابته هنا
 * معناها حسابان للمبلغ المسترد يفترقا أول ما الإدارة تغيّر شريحة خصم. فبدل
 * كده الـ API ده بيتحقق من هوية العميل بتوكنه، ويمرّر رقمه لـ rentcar بسرّ
 * بين الخوادم.
 */
import { HttpException, InternalServerErrorException } from '@nestjs/common';

const INTERNAL_AUTH_HEADER = 'x-internal-secret';
const TIMEOUT_MS = 20_000;

function requireConfig(): { baseUrl: string; secret: string } {
  const baseUrl = (process.env.RENTCAR_INTERNAL_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const secret = (process.env.INTERNAL_API_SECRET ?? '').trim();
  if (!baseUrl || !secret) {
    throw new InternalServerErrorException(
      'خدمة الإلغاء غير مهيّأة. (RENTCAR_INTERNAL_BASE_URL / INTERNAL_API_SECRET)',
    );
  }
  return { baseUrl, secret };
}

export async function callRentcarInternal<T>(path: string, customerId: number): Promise<T> {
  const { baseUrl, secret } = requireConfig();

  // مهلة صريحة: من غيرها طلب معلّق على rentcar بيعلّق طلب العميل في التطبيق
  // لحد ما الموبايل نفسه يقطع، والعميل مش عارف هل الإلغاء اتنفّذ ولا لأ.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [INTERNAL_AUTH_HEADER]: secret },
      body: JSON.stringify({ customerId }),
      signal: controller.signal,
    });
  } catch {
    throw new HttpException('تعذّر الوصول لخدمة الإلغاء. حاول مرة أخرى.', 502);
  } finally {
    clearTimeout(timer);
  }

  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || body.ok === false) {
    // رسائل السياسة العربية بتتمرّر للعميل زي ما هي عشان تطابق نص الموقع.
    // أما أخطاء الإعداد (401/503) فبتتحوّل لرسالة عامة — مش شأن العميل.
    const isPolicyError = res.status === 400 || res.status === 404;
    throw new HttpException(
      isPolicyError && body.error ? body.error : 'تعذّر تنفيذ الطلب. حاول مرة أخرى.',
      isPolicyError ? res.status : 502,
    );
  }
  return body as T;
}

export interface CancelPreviewResponse {
  ok: true;
  preview: { paidInclTax: number; refundInclTax: number; methodLabel: string } | null;
}

export interface CancelResponse {
  ok: true;
  refundInclTaxSar: number;
  deductDays: number;
  paymentMethod: string | null;
}

export interface InvoiceResponse {
  ok: true;
  invoice: Record<string, unknown>;
}
