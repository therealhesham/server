import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateContactMessageDto {
  @IsString()
  @MinLength(2, { message: 'اكتب اسمك.' })
  @MaxLength(100)
  name!: string;

  // 9-digit Saudi mobile, same input the login screen takes.
  @IsString()
  phone!: string;

  // ContactMessage.email is NOT NULL, but a phone-only account has no real email —
  // so it's optional here and stored as '' when absent.
  @IsOptional()
  @IsEmail({}, { message: 'البريد الإلكتروني غير صالح.' })
  @MaxLength(255)
  email?: string;

  @IsString()
  @MinLength(2, { message: 'اختر موضوع الرسالة.' })
  @MaxLength(255)
  subject!: string;

  @IsString()
  @MinLength(5, { message: 'اكتب رسالتك.' })
  @MaxLength(2000, { message: 'الرسالة طويلة جداً (الحد 2000 حرف).' })
  message!: string;
}
