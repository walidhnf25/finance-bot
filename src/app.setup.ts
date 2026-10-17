import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';

/** App-wide setup for the server (main.ts). */
export function configureApp(app: INestApplication, options: { swagger: boolean }): void {
  // Use Pino as the app-wide logger.
  app.useLogger(app.get(Logger));
  app.flushLogs();

  // No DTO-decorator validation pipe: the only body-taking route is the Telegram webhook, whose payload
  // is authenticated by its secret and then shape-checked by toIncomingMessage().

  const config = app.get(ConfigService);
  if (options.swagger && config.get<boolean>('swagger.enabled', false)) {
    const swaggerPath = config.get<string>('swagger.path', 'docs');
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Finance Bot API')
      .setDescription('Telegram finance-tracking chatbot — admin & ops API')
      .setVersion('0.1.0')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup(swaggerPath, app, document);
  }
}
