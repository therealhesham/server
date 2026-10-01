import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// Without bounded waits, a transient DB blip makes a query hang until the OS
// socket finally gives up (~30s) before it fails — long enough that the mobile
// app's booking request times out and the user sees a generic "تعذّر تأكيد
// الحجز" with no booking created. Capping connect/socket/pool waits turns a
// blip into a fast, clean error the API returns (and the client can retry)
// instead of a long hang. These are MySQL connector params, appended to
// DATABASE_URL only when not already set so a Coolify override still wins.
const CONNECTION_TUNING: Record<string, string> = {
  connect_timeout: '10',
  pool_timeout: '10',
  socket_timeout: '15',
};

function tunedDatabaseUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    for (const [key, value] of Object.entries(CONNECTION_TUNING)) {
      if (!url.searchParams.has(key)) url.searchParams.set(key, value);
    }
    return url.toString();
  } catch {
    return raw;
  }
}

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

  constructor() {
    const url = tunedDatabaseUrl();
    super(url ? { datasourceUrl: url } : {});
  }

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
