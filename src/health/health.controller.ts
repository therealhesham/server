import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { HealthService } from './health.service';

// Public and unauthenticated on purpose — uptime monitors and the container
// HEALTHCHECK call these. Responses carry no versions, hosts or error text.
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  // Liveness — "is the process responsive?". Use for the container HEALTHCHECK.
  @Get('live')
  live() {
    return this.healthService.live();
  }

  // Readiness — 200 when the database answers, 503 when it doesn't. Use for uptime
  // monitoring / load-balancer checks.
  @Get()
  async ready() {
    const report = await this.healthService.check();
    if (report.status !== 'ok') throw new ServiceUnavailableException(report);
    return report;
  }
}
