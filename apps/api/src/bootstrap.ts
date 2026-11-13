import { type INestApplication, RequestMethod } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppConfig } from './config/config.module.js';

export const API_PREFIX = 'api/v1';

/** Shared by main.ts and the e2e tests so tests exercise the real HTTP pipeline. */
export function configureApp(app: INestApplication): void {
  const config = app.get(AppConfig);

  app.useLogger(app.get(Logger));
  // JSON bodies up to 3 MB: statement uploads (2 MB cap enforced by the import schema) plus envelope.
  (app as NestExpressApplication).useBodyParser('json', { limit: '3mb' });
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: config.get('CORS_ORIGINS'),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  app.setGlobalPrefix(API_PREFIX, {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'ready', method: RequestMethod.GET },
    ],
  });
  app.enableShutdownHooks();

  if (config.get('SWAGGER_ENABLED')) {
    const doc = new DocumentBuilder()
      .setTitle('KTrade Smart Trading Platform API')
      .setDescription(
        'Personal trading & portfolio platform. Money values are decimal strings. ' +
          'Every financial figure carries a provenance `source`. See docs/07-api-specification.md.',
      )
      .setVersion('1.0.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, doc), {
      jsonDocumentUrl: 'api/docs-json',
    });
  }
}
