import { Body, Controller, Get, Logger, Param, ParseIntPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user.decorator';
import { CreateSessionDto } from './dto/create-session.dto';
import { PaymentsService } from './payments.service';

// Mirrors CreateSessionDto's redirectUrl restriction — only the app's own
// deep-link schemes are allowed as a redirect target here too, since this
// value arrives back from Geidea's redirect (an untrusted hop) rather than
// straight from our own validated request body.
const ALLOWED_REDIRECT_SCHEME = /^(rawaesapp|exp(\+[\w-]+)?):\/\//;

@Controller('payments/geidea')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('session')
  @UseGuards(AuthGuard)
  createSession(@CurrentUserId() userId: number, @Body() dto: CreateSessionDto) {
    return this.paymentsService.createSession(userId, dto.bookingRequestId, dto.redirectUrl);
  }

  // Where Geidea's HPP redirects the in-app browser after checkout (success
  // or failure). When the session carried a redirectUrl (the app's own deep
  // link, built via Linking.createURL), this bounces straight to it — the
  // WebBrowser.openAuthSessionAsync() call on the other end is watching for
  // exactly that navigation and closes the browser + returns control to the
  // app automatically. Without one (or if it fails validation), falls back
  // to a static page for the customer to close by hand.
  @Get('return')
  returnPage(@Query('redirect') redirect: string | undefined, @Res() res: Response) {
    if (redirect && ALLOWED_REDIRECT_SCHEME.test(redirect)) {
      return res.redirect(302, redirect);
    }
    return res
      .type('html')
      .send(`<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>رواء</title></head>
<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0b0b0b;color:#fff;text-align:center;padding:24px">
<div><p style="font-size:18px">تمت العملية — يمكنك الرجوع إلى التطبيق الآن.</p></div>
</body></html>`);
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
    if (!orderId) {
      this.logger.warn({ msg: 'Geidea webhook received without an orderId' });
      return { received: true, ignored: 'missing orderId' };
    }
    try {
      const result = await this.paymentsService.handleWebhookOrderId(orderId);
      return { received: true, ...result };
    } catch (e) {
      // The 200 below hides the failure from Geidea, so this log is the only record
      // that a payment confirmation may not have been applied to its booking.
      this.logger.error({ msg: 'Geidea webhook handling failed', orderId, err: e });
      // Geidea retries on non-2xx — surface as received but unhandled so it
      // doesn't hammer retries for a permanently-bad orderId.
      return { received: true, handled: false };
    }
  }
}
