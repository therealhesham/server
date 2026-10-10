import { IsString, MinLength } from 'class-validator';

export class AutocompleteQueryDto {
  @IsString()
  @MinLength(1)
  input!: string;
}
