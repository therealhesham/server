import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';

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
}
