import { IsString, MaxLength, MinLength } from 'class-validator';

export class DriverLoginDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  phone!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}
