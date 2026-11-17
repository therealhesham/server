import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { verifyDriverToken } from './driver-session.util';

// Bearer guard for driver routes. Independent from the customer AuthGuard.
//
// The driver row is re-read on every request: a signed token outlives the account,
// so disabling a driver in the admin panel must cut access immediately rather than
// at token expiry.
@Injectable()
export class DriverAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header = String(request.headers['authorization'] ?? '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new UnauthorizedException('مطلوب تسجيل الدخول.');

    const driverId = verifyDriverToken(token);
    if (!driverId) throw new UnauthorizedException('الجلسة غير صالحة أو منتهية.');

    const driver = await this.prisma.deliveryDriver.findUnique({
      where: { id: driverId },
      select: { id: true, isActive: true },
    });
    if (!driver || !driver.isActive) throw new UnauthorizedException('الجلسة غير صالحة.');

    request.driver = { id: driver.id };
    return true;
  }
}
