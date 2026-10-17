import { CallHandler, ExecutionContext, Logger } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { LoggingInterceptor } from './logging.interceptor';

const context = (url: string, type = 'http'): ExecutionContext =>
  ({
    getType: () => type,
    switchToHttp: () => ({
      getRequest: () => ({ method: 'GET', url, id: 'rid-1' }),
      getResponse: () => ({ statusCode: 200 }),
    }),
  }) as unknown as ExecutionContext;

const handler = (stream: CallHandler['handle']): CallHandler => ({ handle: stream });

describe('LoggingInterceptor', () => {
  let log: jest.SpyInstance;
  let debug: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('logs one structured line per request, with the request id and duration', async () => {
    await lastValueFrom(
      new LoggingInterceptor().intercept(
        context('/metrics'),
        handler(() => of(1)),
      ),
    );
    expect(log).toHaveBeenCalledTimes(1);
    const calls = log.mock.calls as unknown[][];
    const payload = calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      method: 'GET',
      path: '/metrics',
      statusCode: 200,
      requestId: 'rid-1',
    });
    expect(typeof payload.durationMs).toBe('number');
  });

  it('keeps health checks at debug level so monitoring does not flood the log', async () => {
    await lastValueFrom(
      new LoggingInterceptor().intercept(
        context('/health/ready'),
        handler(() => of(1)),
      ),
    );
    expect(log).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('still logs when the handler fails, and lets the error through', async () => {
    await expect(
      lastValueFrom(
        new LoggingInterceptor().intercept(
          context('/x'),
          handler(() => throwError(() => new Error('boom'))),
        ),
      ),
    ).rejects.toThrow('boom');
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('ignores non-HTTP contexts', async () => {
    await lastValueFrom(
      new LoggingInterceptor().intercept(
        context('/x', 'rpc'),
        handler(() => of(1)),
      ),
    );
    expect(log).not.toHaveBeenCalled();
  });
});
