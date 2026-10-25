import { BadRequestException, Injectable } from '@nestjs/common';

import { saudiLocalNineToE164 } from '../auth/phone.util';
import { PrismaService } from '../prisma/prisma.service';
import { CreateContactMessageDto } from './dto/create-contact-message.dto';

// Writes into the same ContactMessage table the website's contact form uses, so
// the messages land in the inbox the support team already works from.
@Injectable()
export class ContactService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateContactMessageDto): Promise<{ ok: true }> {
    const phone = saudiLocalNineToE164(dto.phone);
    if (!phone) {
      throw new BadRequestException('أدخل رقم جوال سعودي صالح (9 أرقام تبدأ بـ 5).');
    }

    await this.prisma.contactMessage.create({
      data: {
        name: dto.name.trim(),
        phone,
        email: dto.email?.trim().toLowerCase() ?? '',
        subject: dto.subject.trim(),
        message: dto.message.trim(),
        status: 'NEW',
        locale: 'ar',
        updatedAt: new Date(),
      },
    });
    return { ok: true };
  }
}
