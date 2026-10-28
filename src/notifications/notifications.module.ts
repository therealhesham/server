import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ExpoPushService } from './expo-push.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [ExpoPushService, NotificationsService],
  exports: [ExpoPushService],
})
export class NotificationsModule {}
