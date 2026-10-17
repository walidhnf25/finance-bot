/**
 * Stable, machine-readable error codes returned to API clients and used
 * internally to classify failures. Keep values stable — they are a contract.
 * Domain-specific codes are added by their owning modules in later phases.
 */
export enum AppErrorCode {
  // Generic
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  UNPROCESSABLE = 'UNPROCESSABLE',
  FORBIDDEN = 'FORBIDDEN',
  BAD_REQUEST = 'BAD_REQUEST',

  // Domain (finance / parsing) — populated as features land
  PARSE_FAILED = 'PARSE_FAILED',
  AMOUNT_REQUIRED = 'AMOUNT_REQUIRED',
  TRANSACTION_NOT_FOUND = 'TRANSACTION_NOT_FOUND',
  CATEGORY_NOT_FOUND = 'CATEGORY_NOT_FOUND',
  BUDGET_NOT_FOUND = 'BUDGET_NOT_FOUND',
}
