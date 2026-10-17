import { ApiProperty } from '@nestjs/swagger';
import { AppErrorCode } from '../exceptions/app-error-code.enum';

/** Consistent error envelope returned for every failed HTTP request. */
export class ErrorResponseDto {
  @ApiProperty({ example: 404 })
  statusCode!: number;

  @ApiProperty({ enum: AppErrorCode, example: AppErrorCode.NOT_FOUND })
  errorCode!: AppErrorCode;

  @ApiProperty({ example: 'Data tidak ditemukan' })
  message!: string;

  @ApiProperty({
    required: false,
    type: Object,
    additionalProperties: true,
    description: 'Optional structured error details',
  })
  details?: Record<string, unknown>;

  @ApiProperty({ example: '2026-07-12T15:12:01.000Z' })
  timestamp!: string;

  @ApiProperty({ example: '/health' })
  path!: string;

  @ApiProperty({ required: false, example: 'a1b2c3d4-...' })
  requestId?: string;
}
