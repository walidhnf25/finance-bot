import { Controller, ForbiddenException, Get, Header, Headers, Req } from '@nestjs/common';
import { isLoopbackPeer, isMetricsHostAllowed, MetricsService } from './metrics.service';

/**
 * `GET /metrics`: Prometheus text for the bot. Counters and timings only: no user ids, no amounts,
 * no message or receipt text (labels are restricted to declared sets, see MetricsService).
 *
 * The API listens on loopback only. Two more checks hold even if someone sets ALLOW_REMOTE_BIND: the TCP
 * peer must be loopback (a remote client cannot fake that), and the Host header must be a loopback name,
 * so a web page in the owner's browser cannot read it through DNS rebinding.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  scrape(
    @Headers('host') host: string | undefined,
    @Req() req: { socket?: { remoteAddress?: string } },
  ): string {
    if (!isLoopbackPeer(req.socket?.remoteAddress)) throw new ForbiddenException();
    if (!isMetricsHostAllowed(host)) throw new ForbiddenException();
    return this.metrics.render();
  }
}
