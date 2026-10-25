import { Injectable, Logger } from '@nestjs/common';

import { errorReason } from '../common/logger/error-reason';
import { PrismaService } from '../prisma/prisma.service';

// A hung database must turn into a fast "down" answer, not a hung probe.
const DB_TIMEOUT_MS = 3_000;
// The endpoint is public, so cap how often it can reach the database. Failures are
// cached for less time so recovery shows up quickly.
const CACHE_OK_MS = 5_000;
const CACHE_FAIL_MS = 1_000;

export interface HealthReport {
  status: 'ok' | 'error';
  checks: { database: { status: 'up' | 'down'; latencyMs: number } };
  uptimeSec: number;
  timestamp: string;
}

function withTimeout<T>(work: PromiseLike<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`database check timed out after ${ms}ms`)), ms);
  });
  return Promise.race([Promise.resolve(work), timeout]).finally(() => clearTimeout(timer));
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private cached: { at: number; ttl: number; report: HealthReport } | null = null;
  private inflight: Promise<HealthReport> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  // Process-only: no dependencies, so a database blip never gets the container
  // restarted by an orchestrator (PrismaService already rides those out).
  live(): { status: 'ok'; uptimeSec: number } {
    return { status: 'ok', uptimeSec: Math.round(process.uptime()) };
  }

  // Readiness: can this instance actually serve requests (is the database reachable)?
  async check(): Promise<HealthReport> {
    if (this.cached && Date.now() - this.cached.at < this.cached.ttl) {
      return { ...this.cached.report, uptimeSec: Math.round(process.uptime()) };
    }
    // Concurrent probes share one query instead of each opening their own.
    this.inflight ??= this.run().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async run(): Promise<HealthReport> {
    const startedAt = Date.now();
    let up = true;
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, DB_TIMEOUT_MS);
    } catch (e) {
      up = false;
      // The response only says "down"; the reason stays in the logs.
      this.logger.error({ msg: 'Health check failed: database unreachable', reason: errorReason(e) });
    }

    const report: HealthReport = {
      status: up ? 'ok' : 'error',
      checks: { database: { status: up ? 'up' : 'down', latencyMs: Date.now() - startedAt } },
      uptimeSec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
    this.cached = { at: Date.now(), ttl: up ? CACHE_OK_MS : CACHE_FAIL_MS, report };
    return report;
  }
}
