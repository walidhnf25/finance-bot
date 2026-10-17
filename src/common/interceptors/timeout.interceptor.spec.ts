import { CallHandler, ExecutionContext, RequestTimeoutException } from '@nestjs/common';
import { lastValueFrom, map, NEVER, of, timer } from 'rxjs';
import { TimeoutInterceptor } from './timeout.interceptor';

const contextFor = (url: string, type: 'http' | 'rpc' = 'http'): ExecutionContext =>
  ({
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => ({ url }) }),
  }) as unknown as ExecutionContext;

const handler = (stream: CallHandler['handle']): CallHandler => ({ handle: stream });

describe('TimeoutInterceptor', () => {
  const interceptor = new TimeoutInterceptor(30);

  it('lets a fast request through untouched', async () => {
    const out = await lastValueFrom(
      interceptor.intercept(
        contextFor('/health'),
        handler(() => of('ok')),
      ),
    );
    expect(out).toBe('ok');
  });

  it('fails a request that exceeds the limit with 408', async () => {
    await expect(
      lastValueFrom(
        interceptor.intercept(
          contextFor('/health'),
          handler(() => NEVER),
        ),
      ),
    ).rejects.toBeInstanceOf(RequestTimeoutException);
  });

  // Regression: the webhook runs the whole message pipeline (OCR/AI can take minutes). A 15 s cut
  // made Telegram redeliver the update while the first run was still going.
  it('does NOT cut the Telegram webhook, whose work is bounded by its own timeouts', async () => {
    const slow = () => timer(120).pipe(map(() => 'done')); // 4x longer than the 30 ms limit
    const out = await lastValueFrom(
      interceptor.intercept(contextFor('/telegram/webhook'), handler(slow)),
    );
    expect(out).toBe('done');
    // the same slow handler on any other route IS cut off
    await expect(
      lastValueFrom(interceptor.intercept(contextFor('/health'), handler(slow))),
    ).rejects.toBeInstanceOf(RequestTimeoutException);
  });

  it('still bounds other routes that merely look similar', async () => {
    await expect(
      lastValueFrom(
        interceptor.intercept(
          contextFor('/telegram/other'),
          handler(() => NEVER),
        ),
      ),
    ).rejects.toBeInstanceOf(RequestTimeoutException);
    await expect(
      lastValueFrom(
        interceptor.intercept(
          contextFor('/x/telegram/webhook'),
          handler(() => NEVER),
        ),
      ),
    ).rejects.toBeInstanceOf(RequestTimeoutException);
  });

  it('ignores non-HTTP contexts', async () => {
    const out = await lastValueFrom(
      interceptor.intercept(
        contextFor('/x', 'rpc'),
        handler(() => of(1)),
      ),
    );
    expect(out).toBe(1);
  });
});
