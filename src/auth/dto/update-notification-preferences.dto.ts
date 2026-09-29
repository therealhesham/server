import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateNotificationPreferencesDto {
  @IsOptional()
  @IsBoolean()
  bookingUpdates?: boolean;

  @IsOptional()
  @IsBoolean()
  promotions?: boolean;
}
