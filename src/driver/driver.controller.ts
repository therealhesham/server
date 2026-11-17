import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { CurrentDriver, DriverContext } from './current-driver.decorator';
import { DriverAuthGuard } from './driver-auth.guard';
import { DriverService } from './driver.service';
import { DriverLoginDto } from './dto/driver-login.dto';

@Controller('driver')
export class DriverController {
  constructor(private readonly driverService: DriverService) {}

  // Tight limit: this is a password endpoint (customer auth is OTP-based and throttled
  // separately).
  @Post('auth/login')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  login(@Body() dto: DriverLoginDto) {
    return this.driverService.login(dto.phone, dto.password);
  }

  @Get('me')
  @UseGuards(DriverAuthGuard)
  me(@CurrentDriver() driver: DriverContext) {
    return this.driverService.me(driver.id);
  }

  @Get('trips')
  @UseGuards(DriverAuthGuard)
  trips(@CurrentDriver() driver: DriverContext) {
    return this.driverService.listTrips(driver.id);
  }

  @Get('trips/:bookingId')
  @UseGuards(DriverAuthGuard)
  trip(
    @CurrentDriver() driver: DriverContext,
    @Param('bookingId', ParseIntPipe) bookingId: number,
    @Query('type') type?: string,
  ) {
    return this.driverService.getTrip(driver.id, bookingId, type);
  }
}
