import { HttpException, HttpStatus } from '@nestjs/common';
import { AppErrorCode } from './app-error-code.enum';

export interface DomainExceptionOptions {
  /** Optional structured details (safe to expose to clients/logs). */
  details?: Record<string, unknown>;
  /** Underlying cause for logging (never serialized to the client). */
  cause?: unknown;
}

/**
 * Base class for all application/domain errors.
 *
 * Extends Nest's HttpException so the HTTP layer can render it, while carrying
 * a stable `errorCode` (AppErrorCode) for programmatic handling. The chat
 * layer (later phases) will map these to friendly Indonesian replies instead
 * of HTTP responses.
 */
export class DomainException extends HttpException {
  readonly errorCode: AppErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    errorCode: AppErrorCode,
    message: string,
    status: HttpStatus = HttpStatus.UNPROCESSABLE_ENTITY,
    options?: DomainExceptionOptions,
  ) {
    super({ errorCode, message, details: options?.details }, status, {
      cause: options?.cause,
    });
    this.errorCode = errorCode;
    this.details = options?.details;
  }
}

/** 404 — an entity referenced by the user does not exist. */
export class EntityNotFoundException extends DomainException {
  constructor(
    message = 'Data tidak ditemukan',
    errorCode: AppErrorCode = AppErrorCode.NOT_FOUND,
    details?: Record<string, unknown>,
  ) {
    super(errorCode, message, HttpStatus.NOT_FOUND, { details });
  }
}

/** 409 — a uniqueness / state conflict. */
export class ConflictException extends DomainException {
  constructor(message = 'Data sudah ada', details?: Record<string, unknown>) {
    super(AppErrorCode.CONFLICT, message, HttpStatus.CONFLICT, { details });
  }
}

/** 422 — the request was understood but a business rule rejected it. */
export class BusinessRuleException extends DomainException {
  constructor(errorCode: AppErrorCode, message: string, details?: Record<string, unknown>) {
    super(errorCode, message, HttpStatus.UNPROCESSABLE_ENTITY, { details });
  }
}
