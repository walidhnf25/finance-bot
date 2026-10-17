import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

/** The server entry point. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  configureApp(app, { swagger: true });
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  const port = config.get<number>('app.port', 3000);
  const host = config.get<string>('app.host', '127.0.0.1');
  const isProduction = config.get<boolean>('app.isProduction', false);

  // Loopback by default: the API has no login, so it is not reachable from the network.
  await app.listen(port, host);

  const logger = app.get(Logger);
  logger.log(`Application listening on ${host}:${port} (production=${isProduction})`);
}

void bootstrap();
