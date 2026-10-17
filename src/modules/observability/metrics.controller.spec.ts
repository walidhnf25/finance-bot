import { ForbiddenException } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

const peer = (remoteAddress: string | undefined) => ({ socket: { remoteAddress } });

describe('MetricsController access', () => {
  const controller = new MetricsController(new MetricsService());

  it('serves a loopback peer that asks for a loopback host', () => {
    expect(controller.scrape('127.0.0.1:3100', peer('127.0.0.1'))).toContain('uptime_seconds');
    expect(controller.scrape('localhost:3100', peer('::1'))).toContain('uptime_seconds');
    expect(controller.scrape('localhost', peer('::ffff:127.0.0.1'))).toContain('uptime_seconds');
  });

  // Regression: with ALLOW_REMOTE_BIND a remote client could send "Host: localhost" and pass the
  // header check. The TCP peer address cannot be faked that way.
  it('refuses a remote peer even when it sends a loopback Host header', () => {
    for (const address of ['192.168.1.20', '10.0.0.7', '::ffff:10.0.0.7', undefined]) {
      expect(() => controller.scrape('localhost:3100', peer(address))).toThrow(ForbiddenException);
    }
  });

  it('refuses a loopback peer that asks for a foreign host (DNS rebinding from the owner browser)', () => {
    expect(() => controller.scrape('evil.example.com', peer('127.0.0.1'))).toThrow(
      ForbiddenException,
    );
    expect(() => controller.scrape(undefined, peer('127.0.0.1'))).toThrow(ForbiddenException);
  });
});
