import { Module } from '@nestjs/common';

import { ExpoPushService } from './expo-push.service';

@Module({
  providers: [ExpoPushService],
  exports: [ExpoPushService],
})
export class NotificationsModule {}
