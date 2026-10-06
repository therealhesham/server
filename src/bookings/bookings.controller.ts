import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';

import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user.decorator';
import { BookingsService } from './bookings.service';
import { CreateBookingDto } from './dto/create-booking.dto';

@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Post()
  @UseGuards(AuthGuard)
  create(@CurrentUserId() userId: number, @Body() dto: CreateBookingDto) {
    return this.bookingsService.createBooking(userId, dto);
  }

  @Get('mine')
  @UseGuards(AuthGuard)
  getMine(@CurrentUserId() userId: number) {
    return this.bookingsService.getMine(userId);
  }

  // كام هيترد لو ألغى — يُعرض في رسالة التأكيد قبل التنفيذ.
  @Get(':id/cancel-preview')
  @UseGuards(AuthGuard)
  cancelPreview(@CurrentUserId() userId: number, @Param('id', ParseIntPipe) id: number) {
    return this.bookingsService.cancelPreview(userId, id);
  }

  @Post(':id/cancel')
  @UseGuards(AuthGuard)
  cancel(@CurrentUserId() userId: number, @Param('id', ParseIntPipe) id: number) {
    return this.bookingsService.cancel(userId, id);
  }

  @Get(':id/invoice')
  @UseGuards(AuthGuard)
  invoice(@CurrentUserId() userId: number, @Param('id', ParseIntPipe) id: number) {
    return this.bookingsService.invoice(userId, id);
  }
}
