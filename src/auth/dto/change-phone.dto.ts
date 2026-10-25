import { IsString } from 'class-validator';

export class SendChangePhoneOtpDto {
  @IsString()
  phone!: string;
}

export class VerifyChangePhoneDto {
  @IsString()
  phone!: string;

  @IsString()
  otp!: string;
}
