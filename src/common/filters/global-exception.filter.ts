import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ErrorResponseDto } from '../dto/error-response.dto';
import { AppErrorCode } from '../exceptions/app-error-code.enum';
import { DomainException } from '../exceptions/domain.exception';

/**
 * Catches every unhandled error and renders a consistent {@link ErrorResponseDto}.
 * Maps domain errors and Nest HttpExceptions to the right
 * status + stable error code. Logs 5xx as error and 4xx as warn (with requestId).
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();

    const { statusCode, errorCode, message, details } = this.resolve(exception);

    const requestId = request.id ?? (request.headers['x-request-id'] as string | undefined);

    const body: ErrorResponseDto = {
      statusCode,
      errorCode,
      message,
      ...(details ? { details } : {}),
      timestamp: new Date().toISOString(),
      path: request.url,
      ...(requestId ? { requestId } : {}),
    };

    const logPayload = { statusCode, errorCode, path: request.url, requestId };
    if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error({ ...logPayload, err: exception }, `Unhandled error: ${message}`);
    } else {
      this.logger.warn(logPayload, `Handled error: ${message}`);
    }

    response.status(statusCode).json(body);
  }

  private resolve(exception: unknown): {
    statusCode: number;
    errorCode: AppErrorCode;
    message: string;
    details?: Record<string, unknown>;
  } {
    if (exception instanceof DomainException) {
      return {
        statusCode: exception.getStatus(),
        errorCode: exception.errorCode,
        message: exception.message,
        details: exception.details,
      };
    }

    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: AppErrorCode.INTERNAL_ERROR,
      message: 'Terjadi kesalahan internal',
    };
  }

  private fromHttpException(exception: HttpException): {
    statusCode: number;
    errorCode: AppErrorCode;
    message: string;
    details?: Record<string, unknown>;
  } {
    const statusCode = exception.getStatus();
    const res = exception.getResponse();

    // ValidationPipe returns { message: string[], error, statusCode }
    let message = exception.message;
    let details: Record<string, unknown> | undefined;
    if (typeof res === 'object' && res !== null) {
      const r = res as Record<string, unknown>;
      if (Array.isArray(r.message)) {
        message = 'Validasi gagal';
        details = { errors: r.message };
      } else if (typeof r.message === 'string') {
        message = r.message;
      }
    }

    return {
      statusCode,
      errorCode: this.statusToErrorCode(statusCode),
      message,
      details,
    };
  }

  private statusToErrorCode(status: number): AppErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return AppErrorCode.VALIDATION_ERROR;
      case HttpStatus.NOT_FOUND:
        return AppErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return AppErrorCode.CONFLICT;
      case HttpStatus.FORBIDDEN:
        return AppErrorCode.FORBIDDEN;
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return AppErrorCode.UNPROCESSABLE;
      default:
        return status >= 500 ? AppErrorCode.INTERNAL_ERROR : AppErrorCode.BAD_REQUEST;
    }
  }
}
