import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches } from 'class-validator';

export class CreateSessionDto {
  @Type(() => Number)
  @IsInt()
  bookingRequestId!: number;

  // Where Geidea's hosted page should send the browser back to after payment —
  // built client-side via Linking.createURL() so it resolves correctly in both
  // Expo Go (exp://...) and the standalone build (rawaesapp://...). Restricted
  // to those schemes since it ends up in the return page's HTTP redirect.
  @IsOptional()
  @IsString()
  @Matches(/^(rawaesapp|exp(\+[\w-]+)?):\/\//)
  redirectUrl?: string;
}
