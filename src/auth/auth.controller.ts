import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { CurrentUserId } from './current-user.decorator';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { RegisterPushTokenDto, RemovePushTokenDto } from './dto/push-token.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('send-otp')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  sendOtp(@Body() dto: SendOtpDto) {
    return this.authService.sendOtp(dto.phone);
  }

  @Post('verify-otp')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto.phone, dto.otp);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentUserId() userId: number) {
    return this.authService.getProfile(userId);
  }

  @Patch('me')
  @UseGuards(AuthGuard)
  updateMe(@CurrentUserId() userId: number, @Body() dto: UpdateProfileDto) {
    return this.authService.updateProfile(userId, dto);
  }

  @Get('notification-preferences')
  @UseGuards(AuthGuard)
  getNotificationPreferences(@CurrentUserId() userId: number) {
    return this.authService.getNotificationPreferences(userId);
  }

  @Patch('notification-preferences')
  @UseGuards(AuthGuard)
  updateNotificationPreferences(@CurrentUserId() userId: number, @Body() dto: UpdateNotificationPreferencesDto) {
    return this.authService.updateNotificationPreferences(userId, dto);
  }

  @Post('push-token')
  @UseGuards(AuthGuard)
  registerPushToken(@CurrentUserId() userId: number, @Body() dto: RegisterPushTokenDto) {
    return this.authService.registerPushToken(userId, dto.expoPushToken, dto.platform);
  }

  // بلا AuthGuard عن قصد: الجهاز لسه ماعندوش حساب. الحد المعدّل هنا لأن المسار
  // مفتوح — صيغة التوكن وحدها لا تكفي لمنع إغراق الجدول.
  @Post('push-token/anonymous')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  registerAnonymousPushToken(@Body() dto: RegisterPushTokenDto) {
    return this.authService.registerAnonymousPushToken(dto.expoPushToken, dto.platform);
  }

  @Post('push-token/remove')
  @UseGuards(AuthGuard)
  removePushToken(@CurrentUserId() userId: number, @Body() dto: RemovePushTokenDto) {
    return this.authService.removePushToken(userId, dto.expoPushToken);
  }
}
