import { isLoopbackPeer, isMetricsHostAllowed, MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let metrics: MetricsService;
  beforeEach(() => {
    metrics = new MetricsService();
  });
  afterEach(() => metrics.close());

  it('counts by declared label values and renders the Prometheus text format', () => {
    metrics.inc('updates_total', { outcome: 'processed' });
    metrics.inc('updates_total', { outcome: 'processed' });
    metrics.inc('updates_total', { outcome: 'duplicate' });
    const text = metrics.render();
    expect(text).toContain('# TYPE updates_total counter');
    expect(text).toContain('updates_total{outcome="processed"} 2');
    expect(text).toContain('updates_total{outcome="duplicate"} 1');
  });

  it('turns an undeclared label value into "other": user ids and text can never become a series', () => {
    metrics.inc('updates_total', { outcome: '1233082130' });
    metrics.inc('updates_total', { outcome: 'beli kopi 25rb' });
    metrics.inc('updates_total', { outcome: 'x'.repeat(10_000) });
    const text = metrics.render();
    expect(text).toContain('updates_total{outcome="other"} 3');
    expect(text).not.toContain('1233082130');
    expect(text).not.toContain('kopi');
  });

  it('keeps the series bounded however many different values are tried', () => {
    for (let i = 0; i < 5_000; i += 1) metrics.inc('receipts_total', { outcome: `v${i}` });
    const series = metrics
      .render()
      .split('\n')
      .filter((l) => l.startsWith('receipts_total{'));
    expect(series).toHaveLength(1);
    expect(series[0]).toBe('receipts_total{outcome="other"} 5000');
  });

  it('ignores metrics that are not declared, wrong types and nonsense values without throwing', () => {
    expect(() => {
      metrics.inc('nope' as never);
      metrics.inc('message_latency_ms'); // a histogram is not a counter
      metrics.observe('updates_total', 5); // a counter is not a histogram
      metrics.observe('message_latency_ms', Number.NaN);
      metrics.observe('message_latency_ms', -1);
    }).not.toThrow();
    const text = metrics.render();
    expect(text).not.toContain('nope');
    expect(text).not.toContain('message_latency_ms_count');
  });

  it('records histograms with cumulative buckets, sum and count', () => {
    metrics.observe('message_latency_ms', 3);
    metrics.observe('message_latency_ms', 80);
    metrics.observe('message_latency_ms', 90_000);
    const text = metrics.render();
    expect(text).toContain('message_latency_ms_bucket{le="5"} 1');
    expect(text).toContain('message_latency_ms_bucket{le="100"} 2');
    expect(text).toContain('message_latency_ms_bucket{le="+Inf"} 3');
    expect(text).toContain('message_latency_ms_count 3');
    expect(text).toContain('message_latency_ms_sum 90083');
  });

  it('histograms that declare no labels carry only the bucket bound', () => {
    metrics.observe('receipt_duration_ms', 12);
    // receipt_duration_ms declares no labels, so lines carry only "le"
    expect(metrics.render()).toContain('receipt_duration_ms_bucket{le="25"} 1');
  });

  it('time() records the duration even when the operation throws', async () => {
    await expect(
      metrics.time('receipt_duration_ms', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(metrics.render()).toContain('receipt_duration_ms_count 1');
  });

  it('reads gauges only when rendered, and omits one that throws', () => {
    let depth = 0;
    metrics.registerGauge('ocr_queue_depth', () => depth);
    depth = 4;
    expect(metrics.render()).toContain('ocr_queue_depth 4');
    metrics.registerGauge('ai_breaker_open', () => {
      throw new Error('unreadable');
    });
    const text = metrics.render();
    expect(text).not.toContain('ai_breaker_open ');
    expect(text).toContain('uptime_seconds');
  });

  it('exposes process gauges and never anything that looks like a secret or a URL', () => {
    const text = metrics.render();
    expect(text).toContain('process_resident_memory_bytes');
    expect(text).toContain('event_loop_delay_p99_ms');
    expect(text).not.toMatch(/postgres(ql)?:\/\//i);
    expect(text).not.toMatch(/\d{8,10}:[A-Za-z0-9_-]{30,}/);
  });
});

describe('isMetricsHostAllowed', () => {
  it.each(['127.0.0.1:3100', 'localhost:3100', '[::1]:3100', '127.0.0.1', 'LOCALHOST'])(
    'accepts %s',
    (host) => expect(isMetricsHostAllowed(host)).toBe(true),
  );
  it.each([
    undefined,
    '',
    'evil.example.com',
    'evil.example.com:3100',
    '127.0.0.1.evil.com',
    'localhost.evil.com',
    '192.168.1.5:3100',
    '0.0.0.0:3100',
    'localhost:99999999',
  ])('refuses %s (DNS rebinding and LAN names)', (host) =>
    expect(isMetricsHostAllowed(host)).toBe(false),
  );
});

describe('isLoopbackPeer', () => {
  it.each(['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1'])('accepts %s', (a) =>
    expect(isLoopbackPeer(a)).toBe(true),
  );
  it.each([
    undefined,
    '',
    '192.168.1.20',
    '10.0.0.5',
    '::ffff:10.0.0.5',
    '8.8.8.8',
    '127.0.0.1.evil',
    'localhost',
  ])('refuses %s', (a) => expect(isLoopbackPeer(a)).toBe(false));
});
