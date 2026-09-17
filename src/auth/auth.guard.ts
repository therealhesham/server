import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

import { AuthService } from './auth.service';

// Reusable Bearer-token guard for future protected routes (bookings, account)
// — reads the session token this module issues, not a cookie, since the app
// has no browser to hold one.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const header = String(request.headers['authorization'] ?? '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new UnauthorizedException('مطلوب تسجيل الدخول.');

    request.userId = this.authService.resolveUserIdFromToken(token);
    return true;
  }
}
