import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UploadsController } from './uploads.controller';
import { SpacesService } from './spaces.service';

@Module({
  imports: [AuthModule],
  controllers: [UploadsController],
  providers: [SpacesService],
})
export class UploadsModule {}
