import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

// توكن Expo له شكل ثابت. التحقق منه هنا بيمنع تخزين قيم عشوائية تفضل في
// الجدول للأبد — Expo مش هترجّع DeviceNotRegistered لحاجة مش توكن أصلاً.
const EXPO_TOKEN = /^ExponentPushToken\[[A-Za-z0-9._-]+\]$/;

export class RegisterPushTokenDto {
  @IsString()
  @MaxLength(255)
  @Matches(EXPO_TOKEN, { message: 'صيغة توكن الإشعارات غير صحيحة.' })
  expoPushToken!: string;

  @IsOptional()
  @IsIn(['android', 'ios', 'web'])
  platform?: string;
}

export class RemovePushTokenDto {
  @IsString()
  @MaxLength(255)
  expoPushToken!: string;
}
