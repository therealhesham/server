import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

import type { RequestWithContext } from './request-logger';

// Replaces Nest's default filter, whose behaviour it mirrors exactly for responses
// (HttpException → its own body/status; http-errors-style objects → their statusCode;
// anything else → a bare 500) but fixes what the default leaves unlogged:
//  - explicit 5xx HttpExceptions (e.g. the 502 for an unreachable cancel service) were
//    never logged at all;
//  - unknown errors were logged without the request that caused them.
// 4xx are expected client errors and stay out of the error log (the request log
// already records them).
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<RequestWithContext>();

    let status = 500;
    let body: string | object = { statusCode: 500, message: 'Internal server error' };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      body = typeof response === 'string' ? { statusCode: status, message: response } : response;
    } else if (isHttpErrorLike(exception)) {
      status = exception.statusCode;
      body = { statusCode: status, message: exception.message };
    }

    if (status >= 500) {
      this.logger.error({
        msg: `${req.method} ${req.originalUrl.split('?')[0]} failed with ${status}`,
        requestId: req.requestId,
        userId: req.userId,
        status,
        err: exception instanceof Error ? exception : new Error(String(exception)),
      });
    }

    httpAdapter.reply(ctx.getResponse(), body, status);
  }
}

// body-parser and similar middleware throw plain errors carrying a statusCode.
function isHttpErrorLike(e: unknown): e is { statusCode: number; message: string } {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { statusCode?: unknown }).statusCode === 'number' &&
    typeof (e as { message?: unknown }).message === 'string'
  );
}
