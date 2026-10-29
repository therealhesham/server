import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, Min } from 'class-validator';

export class ListCarsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  branchId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  categoryId?: number;

  // لو الاتنين موجودين، كل سيارة بترجع بحالة توفّرها في الفترة دي (available)
  // — نفس فحص آخر خطوة الحجز، لكن قبلها. لو ناقص واحد منهم تتجاهل الاتنين.
  @IsOptional()
  @IsISO8601()
  pickupAt?: string;

  @IsOptional()
  @IsISO8601()
  returnAt?: string;
}
