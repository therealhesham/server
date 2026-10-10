import { IsString, MinLength } from 'class-validator';

export class PlaceDetailsQueryDto {
  @IsString()
  @MinLength(1)
  placeId!: string;
}
