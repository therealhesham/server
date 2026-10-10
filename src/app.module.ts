import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { FleetModule } from './fleet/fleet.module';
import { AddonsModule } from './addons/addons.module';
import { SiteSettingsModule } from './site-settings/site-settings.module';
import { UploadsModule } from './uploads/uploads.module';
import { AuthModule } from './auth/auth.module';
import { BookingsModule } from './bookings/bookings.module';
import { PaymentsModule } from './payments/payments.module';
import { CouponsModule } from './coupons/coupons.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PlacesModule } from './places/places.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    PrismaModule,
    FleetModule,
    AddonsModule,
    SiteSettingsModule,
    UploadsModule,
    AuthModule,
    BookingsModule,
    PaymentsModule,
    CouponsModule,
    NotificationsModule,
    PlacesModule,
  ],
})
export class AppModule {}
