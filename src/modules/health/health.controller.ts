import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthReport, HealthService } from './health.service';

/** The one thing of the HTTP response this controller needs to change. */
interface StatusSetter {
  status(code: number): unknown;
}

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness: the process is running (touches no dependency)' })
  live() {
    return this.health.live();
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness: PostgreSQL reachable and all migrations applied' })
  async ready(@Res({ passthrough: true }) res: StatusSetter): Promise<HealthReport> {
    const report = await this.health.ready();
    // 503 WITH the report: whoever sees the failing check also sees which check failed and why
    // (the details are fixed, non-sensitive sentences; raw driver errors never reach this body).
    if (report.status === 'down') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }

  /** Backwards-compatible alias of readiness. */
  @Get()
  @ApiOperation({ summary: 'Alias of /health/ready' })
  check(@Res({ passthrough: true }) res: StatusSetter): Promise<HealthReport> {
    return this.ready(res);
  }
}
