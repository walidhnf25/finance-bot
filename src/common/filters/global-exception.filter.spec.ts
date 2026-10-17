import { ArgumentsHost, BadRequestException, HttpStatus, NotFoundException } from '@nestjs/common';
import { AppErrorCode } from '../exceptions/app-error-code.enum';
import { BusinessRuleException, ConflictException } from '../exceptions/domain.exception';
import { GlobalExceptionFilter } from './global-exception.filter';

interface Captured {
  status?: number;
  body?: Record<string, unknown>;
}

function run(exception: unknown, request: object = {}): Captured {
  const out: Captured = {};
  const response = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      out.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ url: '/x', headers: {}, ...request }),
    }),
  } as unknown as ArgumentsHost;
  new GlobalExceptionFilter().catch(exception, host);
  return out;
}

describe('GlobalExceptionFilter', () => {
  it('renders a domain error with its stable code and details', () => {
    const r = run(
      new BusinessRuleException(AppErrorCode.AMOUNT_REQUIRED, 'Nominal wajib', { f: 1 }),
    );
    expect(r.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(r.body).toMatchObject({
      errorCode: AppErrorCode.AMOUNT_REQUIRED,
      message: 'Nominal wajib',
      details: { f: 1 },
      path: '/x',
    });
  });

  it.each([
    [new NotFoundException('hilang'), 404, AppErrorCode.NOT_FOUND],
    [new ConflictException('ada'), 409, AppErrorCode.CONFLICT],
    [new BadRequestException('buruk'), 400, AppErrorCode.VALIDATION_ERROR],
  ])('maps %p to %i / %s', (error, status, code) => {
    const r = run(error);
    expect(r.status).toBe(status);
    expect(r.body?.errorCode).toBe(code);
  });

  it('turns ValidationPipe messages into one stable message plus a details list', () => {
    const r = run(
      new BadRequestException({ message: ['a salah', 'b salah'], error: 'Bad Request' }),
    );
    expect(r.body).toMatchObject({
      message: 'Validasi gagal',
      details: { errors: ['a salah', 'b salah'] },
    });
  });

  it('NEVER leaks the message, stack or type of an unexpected error', () => {
    const secret = 'connection to postgresql://user:hunter2@db:5432 failed';
    const r = run(new Error(secret));
    expect(r.status).toBe(500);
    expect(r.body?.errorCode).toBe(AppErrorCode.INTERNAL_ERROR);
    expect(JSON.stringify(r.body)).not.toContain('hunter2');
    expect(JSON.stringify(r.body)).not.toContain('postgresql');
    expect(r.body).not.toHaveProperty('stack');
    expect(run('a thrown string').status).toBe(500);
    expect(run(undefined).status).toBe(500);
  });

  it('echoes the request id from the request or the x-request-id header', () => {
    expect(run(new Error('x'), { id: 'req-1' }).body?.requestId).toBe('req-1');
    expect(run(new Error('x'), { headers: { 'x-request-id': 'hdr-9' } }).body?.requestId).toBe(
      'hdr-9',
    );
    expect(run(new Error('x')).body).not.toHaveProperty('requestId');
  });
});
