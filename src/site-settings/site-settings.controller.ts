import { Controller, Get } from '@nestjs/common';
import { SiteSettingsService } from './site-settings.service';

@Controller()
export class SiteSettingsController {
  constructor(private readonly siteSettingsService: SiteSettingsService) {}

  @Get('payment-methods')
  async listEnabledPaymentMethods() {
    return { enabled: await this.siteSettingsService.listEnabledPaymentMethods() };
  }

  // The same active terms the website shows, managed from the admin panel.
  @Get('rental-terms')
  async listRentalTerms() {
    return { terms: await this.siteSettingsService.listRentalTerms() };
  }

  @Get('contact-info')
  async getContactInfo() {
    return this.siteSettingsService.getContactInfo();
  }

  @Get('booking-widget-tabs')
  async getBookingWidgetTabs() {
    return this.siteSettingsService.getBookingWidgetTabFlags();
  }

  @Get('booking-cancel-button')
  async getBookingCancelButton() {
    return { enabled: await this.siteSettingsService.getBookingCancelButtonEnabled() };
  }
}
