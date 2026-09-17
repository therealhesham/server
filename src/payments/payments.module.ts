import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { GeideaService } from './geidea.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [AuthModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, GeideaService],
})
export class PaymentsModule {}
