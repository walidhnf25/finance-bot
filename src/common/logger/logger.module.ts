import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Structured logging via Pino.
 * - Pretty, colorized output in dev; single-line JSON in prod.
 * - Injects/propagates an `x-request-id` correlation id per request.
 * - Redacts sensitive fields.
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const level = config.get<string>('log.level', 'info');
        const pretty = config.get<boolean>('log.pretty', false);

        return {
          pinoHttp: {
            level,
            genReqId: (req: IncomingMessage, res: ServerResponse) => {
              const existing = req.headers['x-request-id'];
              const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
              res.setHeader('x-request-id', id);
              return id;
            },
            // Disabled: LoggingInterceptor is the single source of request logs.
            autoLogging: false,
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.body.password',
                '*.password',
                '*.token',
              ],
              remove: true,
            },
            transport: pretty
              ? {
                  target: 'pino-pretty',
                  options: {
                    singleLine: true,
                    colorize: true,
                    translateTime: 'SYS:standard',
                    ignore: 'pid,hostname,req,res',
                  },
                }
              : undefined,
          },
        };
      },
    }),
  ],
})
export class LoggerModule {}
