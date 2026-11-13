import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { BrokerCapabilityUnavailableError } from '@ktrade/broker-sdk';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: string;
  instance?: string;
  requestId?: string;
  errors?: { path: string; message: string }[];
}

const TYPE_BASE = 'https://ktrade-platform.local/problems/';

/**
 * Maps every error to RFC 9457 `application/problem+json` (docs/07 §1).
 * Unknown errors become a generic 500 — internal messages and stacks are logged, never returned.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemDetails');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request & { id?: string }>();
    const res = http.getResponse<Response>();
    const problem = this.toProblem(exception);
    problem.instance = req.originalUrl;
    if (req.id) problem.requestId = String(req.id);

    if (problem.status >= 500) this.logger.error({ err: exception, requestId: req.id }, 'Unhandled error');

    res.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblem(exception: unknown): ProblemDetails {
    if (exception instanceof ZodError) {
      return {
        type: `${TYPE_BASE}validation`,
        title: 'Validation failed',
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: 'VALIDATION_FAILED',
        errors: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    }
    if (exception instanceof BrokerCapabilityUnavailableError) {
      return {
        type: `${TYPE_BASE}capability-unavailable`,
        title: 'Broker capability unavailable',
        status: HttpStatus.CONFLICT,
        code: exception.code,
        detail: exception.message,
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const detail =
        typeof body === 'string' ? body : ((body as { message?: string | string[] }).message ?? exception.message);
      const code = (typeof body === 'object' && (body as { code?: string }).code) || HttpStatus[status] || 'HTTP_ERROR';
      return {
        type: `${TYPE_BASE}${String(code).toLowerCase().replace(/_/g, '-')}`,
        title: exception.name.replace(/Exception$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'),
        status,
        code: String(code),
        detail: Array.isArray(detail) ? detail.join('; ') : detail,
      };
    }
    return {
      type: `${TYPE_BASE}internal`,
      title: 'Internal Server Error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
    };
  }
}
