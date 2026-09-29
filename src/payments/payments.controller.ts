import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';

import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user.decorator';
import { CreateSessionDto } from './dto/create-session.dto';
import { PaymentsService } from './payments.service';

@Controller('payments/geidea')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('session')
  @UseGuards(AuthGuard)
  createSession(@CurrentUserId() userId: number, @Body() dto: CreateSessionDto) {
    return this.paymentsService.createSession(userId, dto.bookingRequestId);
  }

  @Get('reconcile/:bookingId')
  @UseGuards(AuthGuard)
  reconcile(@CurrentUserId() userId: number, @Param('bookingId', ParseIntPipe) bookingId: number) {
    return this.paymentsService.reconcile(userId, bookingId);
  }

  // Public — called by Geidea's servers, not the app. We never trust this
  // body beyond the orderId; PaymentsService re-fetches the order itself.
  @Post('webhook')
  async webhook(@Body() body: { order?: { orderId?: string }; orderId?: string }) {
    const orderId = String(body?.order?.orderId ?? body?.orderId ?? '').trim();
    if (!orderId) return { received: true, ignored: 'missing orderId' };
    try {
      const result = await this.paymentsService.handleWebhookOrderId(orderId);
      return { received: true, ...result };
    } catch {
      // Geidea retries on non-2xx — surface as received but unhandled so it
      // doesn't hammer retries for a permanently-bad orderId.
      return { received: true, handled: false };
    }
  }
}
