import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

const logger = new Logger('Http');

// Probes hit these every few seconds; logging them would bury real traffic.
const SKIP_PATHS = new Set(['/health', '/health/live']);

const SAFE_REQUEST_ID = /^[\w.-]{1,64}$/;

export type RequestWithContext = Request & { requestId?: string; userId?: number };

// One line per request: who (userId), what (method + path, never the query string or
// body — they carry tokens and personal data), how it ended (status, duration). The
// requestId is echoed in the X-Request-Id response header and repeated on error logs,
// so a customer's failed request can be traced to its exact stack trace.
export function requestLogger(req: RequestWithContext, res: Response, next: NextFunction) {
  const incoming = req.headers['x-request-id'];
  const requestId = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const path = req.originalUrl.split('?')[0];
  if (SKIP_PATHS.has(path)) return next();

  const startedAt = process.hrtime.bigint();
  let reported = false;
  const report = (aborted: boolean) => {
    if (reported) return;
    reported = true;
    const status = res.statusCode;
    const fields = {
      msg: `${req.method} ${path} ${aborted ? 'aborted' : status}`,
      requestId,
      method: req.method,
      path,
      status,
      durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10,
      userId: req.userId,
      ...(aborted ? { aborted: true } : {}),
    };
    // 5xx get their own error entry (with stack) from AllExceptionsFilter.
    if (aborted || status >= 400) logger.warn(fields);
    else logger.log(fields);
  };

  res.on('finish', () => report(false));
  res.on('close', () => report(!res.writableFinished));
  next();
}
