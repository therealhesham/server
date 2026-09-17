import { Controller, Get } from '@nestjs/common';
import { SiteSettingsService } from './site-settings.service';

@Controller()
export class SiteSettingsController {
  constructor(private readonly siteSettingsService: SiteSettingsService) {}

  @Get('payment-methods')
  async listEnabledPaymentMethods() {
    return { enabled: await this.siteSettingsService.listEnabledPaymentMethods() };
  }

  @Get('booking-widget-tabs')
  async getBookingWidgetTabs() {
    return this.siteSettingsService.getBookingWidgetTabFlags();
  }
}
