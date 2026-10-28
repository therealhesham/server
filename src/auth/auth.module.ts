import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { EvolutionWhatsAppService } from './evolution-whatsapp.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, EvolutionWhatsAppService],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
