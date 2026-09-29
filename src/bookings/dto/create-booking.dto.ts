import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class BookingKycDto {
  @IsIn(['citizen', 'resident', 'visitor'])
  idKind!: 'citizen' | 'resident' | 'visitor';

  @IsOptional()
  @IsString()
  nationalIdNumber?: string;

  @IsOptional()
  @IsString()
  passportNumber?: string;

  @IsString()
  licenseNumber!: string;

  @IsISO8601()
  licenseExpiryIso!: string;

  @IsString()
  idImageUri!: string;

  @IsString()
  licenseImageUri!: string;
}

export class CreateBookingDto {
  @Type(() => Number)
  @IsInt()
  carModelId!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  pickupBranchId?: number;

  @Type(() => Number)
  @IsInt()
  returnBranchId!: number;

  @IsIn(['branch', 'delivery'])
  pickupMode!: 'branch' | 'delivery';

  @IsISO8601()
  pickupAt!: string;

  @IsISO8601()
  returnAt!: string;

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  addonIds?: number[];

  @IsOptional()
  @IsString()
  deliveryAddress?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  deliveryLat?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  deliveryLng?: number;

  // The branch servicing the delivery (for computing distance × its real
  // deliveryFeePerKmSar server-side) — required when pickupMode is
  // 'delivery'. The fee itself is never accepted from the client; see
  // BookingsService.computeDeliveryFee.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  deliveryBranchId?: number;

  @IsString()
  fullName!: string;

  @IsString()
  ageBand!: string;

  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @ValidateNested()
  @Type(() => BookingKycDto)
  kyc!: BookingKycDto;

  @IsOptional()
  @IsString()
  paymentMethodId?: string;

  @IsOptional()
  @IsBoolean()
  termsAccepted?: boolean;

  // The exact "mobile app - ios/android" string stored on the booking is
  // decided server-side (BookingsService) — the client only reports which OS
  // it's running on, not the final stored label.
  @IsOptional()
  @IsIn(['ios', 'android'])
  platform?: 'ios' | 'android';

  // Re-validated server-side (BookingsService.createBooking) against the
  // same CouponsService.resolveCoupon used for the checkout preview — the
  // discount is never accepted as a number from the client.
  @IsOptional()
  @IsString()
  couponCode?: string;
}
