import { Module } from '@nestjs/common';

import { DriverAuthGuard } from './driver-auth.guard';
import { DriverController } from './driver.controller';
import { DriverService } from './driver.service';

@Module({
  controllers: [DriverController],
  providers: [DriverService, DriverAuthGuard],
})
export class DriverModule {}
