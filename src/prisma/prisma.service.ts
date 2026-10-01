import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// The DB host has brief, transient unreachability blips (a few seconds) —
// without a retry here, $connect() throws once, crashes the whole process
// (Nest has nothing left to catch it), and Docker's restart policy cycles
// the container while the API is completely down for in-flight requests.
// Retrying in-process rides out the blip instead of taking the API offline.
const MAX_CONNECT_ATTEMPTS = 8;
const RETRY_DELAY_MS = 2000;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
      try {
        await this.$connect();
        return;
      } catch (err) {
        if (attempt === MAX_CONNECT_ATTEMPTS) throw err;
        this.logger.warn(
          `Database connection attempt ${attempt}/${MAX_CONNECT_ATTEMPTS} failed, retrying in ${RETRY_DELAY_MS}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
