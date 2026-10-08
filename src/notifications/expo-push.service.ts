import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
// Expo بتقبل ١٠٠ رسالة كحد أقصى في الطلب الواحد.
const CHUNK_SIZE = 100;
const REQUEST_TIMEOUT_MS = 15_000;

export interface PushPayload {
  title: string;
  body: string;
  /// بيتسلّم للتطبيق لما المستخدم يضغط الإشعار — `bookingId` بيفتح شاشة الحجز.
  data?: Record<string, string | number>;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

@Injectable()
export class ExpoPushService {
  private readonly logger = new Logger(ExpoPushService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * بيبعت لكل أجهزة المستخدم. بيبلع كل الأخطاء عن قصد: الإشعار مكمِّل
   * للعملية مش جزء منها، ومحصلش إن فشل إشعار يرجّع حجز مدفوع.
   */
  async sendToUser(userId: number, payload: PushPayload): Promise<void> {
    try {
      // المستخدم اللي قافل تحديثات الحجز مش بيتبعتله — التفضيل ده هو نفسه
      // اللي بتعرضه شاشة الإشعارات في التطبيق.
      const prefs = await this.prisma.notificationPreference.findUnique({ where: { userId } });
      if (prefs && !prefs.bookingUpdates) return;

      const devices = await this.prisma.pushDevice.findMany({ where: { userId }, select: { token: true } });
      if (devices.length === 0) return;

      await this.send(devices.map((d) => d.token), payload);
    } catch (e) {
      this.logger.warn(`فشل إرسال إشعار للمستخدم ${userId}: ${(e as Error).message}`);
    }
  }

  private async send(tokens: string[], payload: PushPayload): Promise<void> {
    for (let i = 0; i < tokens.length; i += CHUNK_SIZE) {
      const chunk = tokens.slice(i, i + CHUNK_SIZE);
      const messages = chunk.map((to) => ({
        to,
        title: payload.title,
        body: payload.body,
        data: payload.data ?? {},
        sound: 'default',
        // لازم تطابق القناة اللي التطبيق بيعرّفها، وإلا أندرويد يستخدم
        // القناة الافتراضية بأولوية أقل.
        channelId: 'booking-updates',
      }));

      const tickets = await this.post(messages);
      await this.dropDeadTokens(chunk, tickets);
    }
  }

  private async post(messages: unknown[]): Promise<ExpoTicket[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Expo رفض الطلب (${res.status})`);
      }
      const body = (await res.json()) as { data?: ExpoTicket[] };
      return body.data ?? [];
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * التوكن بيموت لما المستخدم يمسح التطبيق أو يشيل صلاحية الإشعارات. من غير
   * تنظيف، الجدول بيمتلئ بتوكنات ميتة وكل إرسال بيضيّع وقت عليها.
   */
  private async dropDeadTokens(tokens: string[], tickets: ExpoTicket[]): Promise<void> {
    const dead = tokens.filter(
      (_, i) => tickets[i]?.status === 'error' && tickets[i]?.details?.error === 'DeviceNotRegistered',
    );
    if (dead.length === 0) return;
    await this.prisma.pushDevice.deleteMany({ where: { token: { in: dead } } });
    this.logger.log(`تم حذف ${dead.length} توكن غير مسجَّل`);
  }
}
