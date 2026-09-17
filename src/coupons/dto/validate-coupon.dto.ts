import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString } from 'class-validator';

export class ValidateCouponDto {
  @IsString()
  code!: string;

  @Type(() => Number)
  @IsInt()
  carModelId!: number;

  @Type(() => Number)
  @IsInt()
  returnBranchId!: number;

  @IsISO8601()
  pickupAt!: string;

  @IsISO8601()
  returnAt!: string;

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  addonIds?: number[];

  @IsIn(['branch', 'delivery'])
  pickupMode!: 'branch' | 'delivery';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  deliveryBranchId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  deliveryLat?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  deliveryLng?: number;
}
