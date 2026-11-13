import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { AppConfig } from '../../config/config.module.js';

/** Paths that must never reach logs (docs/04 §5). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-step-up-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
  '*.secret',
  '*.totpCode',
  '*.apiKey',
];

const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
          // Honour a well-formed inbound request id (from the BFF/nginx), otherwise mint one.
          genReqId: (req, res) => {
            const inbound = req.headers['x-request-id'];
            const id = typeof inbound === 'string' && REQUEST_ID_RE.test(inbound) ? inbound : randomUUID();
            res.setHeader('x-request-id', id);
            return id;
          },
          autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
          serializers: {
            req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
          },
        },
      }),
    }),
  ],
})
export class LoggerModule {}
