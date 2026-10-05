import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';

import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user.decorator';
import { CouponsService } from './coupons.service';
import { ValidateCouponDto } from './dto/validate-coupon.dto';

@Controller('coupons')
export class CouponsController {
  constructor(private readonly couponsService: CouponsService) {}

  @Post('validate')
  @UseGuards(AuthGuard)
  validate(@CurrentUserId() userId: number, @Body() dto: ValidateCouponDto) {
    return this.couponsService.validate(userId, dto);
  }

  @Get('mine')
  @UseGuards(AuthGuard)
  getMine(@CurrentUserId() userId: number) {
    return this.couponsService.getMine(userId);
  }
}
