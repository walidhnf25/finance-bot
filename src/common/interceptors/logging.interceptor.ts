import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

/**
 * Logs one structured line per HTTP request on completion (or error), including
 * method, path, status and duration. Pino-http autoLogging is disabled so this
 * is the single source of request logs. Health checks are logged at debug to
 * keep monitoring noise down.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<Request & { id?: string }>();
    const res = http.getResponse<Response>();
    const start = process.hrtime.bigint();

    const finish = (): void => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      const payload = {
        method: req.method,
        path: req.url,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        requestId: req.id,
      };
      const isHealth = req.url.startsWith('/health');
      const msg = `${req.method} ${req.url} ${res.statusCode} ${payload.durationMs}ms`;
      if (isHealth) {
        this.logger.debug(payload, msg);
      } else {
        this.logger.log(payload, msg);
      }
    };

    return next.handle().pipe(
      tap({
        next: finish,
        error: finish,
      }),
    );
  }
}
