import { Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';

import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user.decorator';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUserId() userId: number) {
    return this.notifications.list(userId);
  }

  // خفيف عن قصد: التطبيق بينادي عليه لعدّاد الجرس كل ما الشاشة الرئيسية تتفتح.
  @Get('unread-count')
  async unreadCount(@CurrentUserId() userId: number) {
    return { unreadCount: await this.notifications.unreadCount(userId) };
  }

  @Post('read-all')
  readAll(@CurrentUserId() userId: number) {
    return this.notifications.markAllRead(userId);
  }

  @Post(':id/read')
  read(@CurrentUserId() userId: number, @Param('id', ParseIntPipe) id: number) {
    return this.notifications.markRead(userId, id);
  }
}
