import { Type } from 'class-transformer';
import { IsInt } from 'class-validator';

export class CreateSessionDto {
  @Type(() => Number)
  @IsInt()
  bookingRequestId!: number;
}
