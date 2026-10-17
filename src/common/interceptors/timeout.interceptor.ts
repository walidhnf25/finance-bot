import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  RequestTimeoutException,
} from '@nestjs/common';
import { Observable, throwError, TimeoutError } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Bounds HTTP request handling time. If a handler exceeds the limit the request
 * is failed with 408 rather than hanging a connection open indefinitely.
 */
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    // The Telegram webhook runs the whole message pipeline (a receipt photo can take minutes of OCR/AI,
    // each step bounded by its own timeout). Cutting it at 15 s would make Telegram redeliver the update
    // while the first run is still going. Every other route stays bounded.
    const url = context.switchToHttp().getRequest<{ url?: string }>().url ?? '';
    if (url.startsWith('/telegram/webhook')) {
      return next.handle();
    }
    return next.handle().pipe(
      timeout(this.timeoutMs),
      catchError((err: unknown) => {
        if (err instanceof TimeoutError) {
          return throwError(() => new RequestTimeoutException('Permintaan melebihi batas waktu'));
        }
        return throwError(() => err);
      }),
    );
  }
}
