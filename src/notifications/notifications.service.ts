import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

const LIST_LIMIT = 50;

export interface InboxNotification {
  id: number;
  title: string;
  body: string;
  bookingId: number | null;
  isRead: boolean;
  createdAt: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * بيسجّل الإشعار في صندوق العميل. بيبلع الأخطاء عن قصد زي الـ push: الصندوق
   * مكمِّل للعملية، وفشله مالوش حق يرجّع حجز مدفوع.
   */
  async record(userId: number, input: { title: string; body: string; bookingId?: number }): Promise<void> {
    try {
      await this.prisma.customerNotification.create({
        data: { userId, title: input.title, body: input.body, bookingId: input.bookingId ?? null },
      });
    } catch (e) {
      this.logger.warn(`فشل تسجيل إشعار للمستخدم ${userId}: ${(e as Error).message}`);
    }
  }

  async list(userId: number): Promise<{ items: InboxNotification[]; unreadCount: number }> {
    const [rows, unreadCount] = await Promise.all([
      this.prisma.customerNotification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: LIST_LIMIT,
      }),
      this.unreadCount(userId),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        bookingId: r.bookingId,
        isRead: r.isRead,
        createdAt: r.createdAt.toISOString(),
      })),
      unreadCount,
    };
  }

  unreadCount(userId: number): Promise<number> {
    return this.prisma.customerNotification.count({ where: { userId, isRead: false } });
  }

  async markRead(userId: number, id: number): Promise<{ ok: true }> {
    // `userId` في الشرط مش اختياري: من غيره أي عميل يقدر يعلّم إشعار غيره.
    const { count } = await this.prisma.customerNotification.updateMany({
      where: { id, userId },
      data: { isRead: true },
    });
    if (count === 0) throw new NotFoundException('الإشعار غير موجود.');
    return { ok: true };
  }

  async markAllRead(userId: number): Promise<{ ok: true }> {
    await this.prisma.customerNotification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
    return { ok: true };
  }
}
