import { Body, Controller, Get, Header, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';

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

  // Where Geidea's HPP redirects the in-app browser after checkout (success
  // or failure). The app itself never reads this page — it only reacts to
  // the browser closing — so this just gives the customer something sensible
  // to look at instead of a blank tab before they tap back into the app.
  @Get('return')
  @Header('Content-Type', 'text/html; charset=utf-8')
  returnPage() {
    return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>رواء</title></head>
<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0b0b0b;color:#fff;text-align:center;padding:24px">
<div><p style="font-size:18px">تمت العملية — يمكنك الرجوع إلى التطبيق الآن.</p></div>
</body></html>`;
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
