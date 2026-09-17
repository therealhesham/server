import { BadRequestException, Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '../auth/auth.guard';
import { SpacesService } from './spaces.service';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly spacesService: SpacesService) {}

  // Matches rentcar's own /api/bookings/kyc-upload folder + response shape
  // ({ ok: true, url }) so the same file ends up in the same bucket/prefix
  // the web app's admin tools already trust.
  @Post('kyc')
  @UseGuards(AuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  async uploadKyc(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('اختر ملف صورة صالحاً.');
    const url = await this.spacesService.uploadImage(file, 'booking-kyc');
    return { ok: true, url };
  }
}
