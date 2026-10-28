import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

import { AuthService } from './auth.service';

// Reusable Bearer-token guard for future protected routes (bookings, account)
// — reads the session token this module issues, not a cookie, since the app
// has no browser to hold one.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header = String(request.headers['authorization'] ?? '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new UnauthorizedException('مطلوب تسجيل الدخول.');

    const userId = this.authService.resolveUserIdFromToken(token);
    // A signed token outlives account deletion, so check the account is still live.
    await this.authService.assertAccountActive(userId);
    request.userId = userId;
    return true;
  }
}
