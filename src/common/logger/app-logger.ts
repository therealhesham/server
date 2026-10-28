import type { LoggerService } from '@nestjs/common';

// Every `new Logger(Ctx).warn(...)` already in the codebase is routed here once
// main.ts installs this logger, so they all become structured without being edited.
//
// Production (or LOG_FORMAT=json) → one JSON object per line on stdout/stderr, which
// Coolify/Docker log collectors can parse and filter by level/context/requestId.
// Otherwise → a readable single line for local development.

export type LogLevel = 'verbose' | 'debug' | 'log' | 'warn' | 'error' | 'fatal';
const LEVELS: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];

export type LogWriter = (level: LogLevel, line: string) => void;

const defaultWriter: LogWriter = (level, line) => {
  (level === 'error' || level === 'fatal' ? process.stderr : process.stdout).write(`${line}\n`);
};

// Field names whose values never reach the logs, whatever they hold.
const SENSITIVE_KEY = /(pass(word)?|secret|token|authorization|api[-_]?key|otp)/i;

// Secrets that can sneak into free text (error messages, stack traces, URLs).
const REDACTIONS: [RegExp, string][] = [
  [/Bearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]'],
  [/ExponentPushToken\[[^\]]*\]/g, 'ExponentPushToken[redacted]'],
  [/((?:api[-_]?key|secret|password|token|apikey)=)[^&\s"']+/gi, '$1[redacted]'],
  // Saudi mobile numbers in any of the shapes the app handles: +9665…, 9665…, 05…, 5…
  [/(?<!\d)(?:\+?966|0)?5\d{8}(?!\d)/g, '[phone]'],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

const MAX_DEPTH = 4;

function serializeError(err: Error): Record<string, unknown> {
  return { name: err.name, message: redact(err.message), stack: err.stack ? redact(err.stack) : undefined };
}

function serialize(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return serializeError(value);
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => serialize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : serialize(v, depth + 1);
  }
  return out;
}

const looksLikeStack = (s: string) => /\n\s+at /.test(s);

export interface LogEntry {
  time: string;
  level: LogLevel;
  context?: string;
  msg: string;
  [field: string]: unknown;
}

// Nest calls logger.log(message, context) and logger.error(message, stack?, context?);
// `message` may be a string, an Error, or a plain object of fields (our convention:
// `{ msg: '...', orderId, err }`).
export function buildEntry(level: LogLevel, message: unknown, params: unknown[], now = new Date()): LogEntry {
  let context: string | undefined;
  let stack: string | undefined;
  const strings = params.filter((p): p is string => typeof p === 'string');
  if (level === 'error' || level === 'fatal') {
    if (strings.length >= 2) [stack, context] = [strings[strings.length - 2], strings[strings.length - 1]];
    else if (strings.length === 1) {
      if (looksLikeStack(strings[0])) stack = strings[0];
      else context = strings[0];
    }
  } else if (strings.length >= 1) {
    context = strings[strings.length - 1];
  }

  let msg: string;
  let fields: Record<string, unknown> = {};
  if (message instanceof Error) {
    msg = message.message;
    fields = { err: message };
  } else if (message !== null && typeof message === 'object') {
    const { msg: m, message: legacy, ...rest } = message as Record<string, unknown>;
    msg = String(m ?? legacy ?? '');
    fields = rest;
  } else {
    msg = String(message);
  }

  const entry: LogEntry = { time: now.toISOString(), level, context, msg: redact(msg) };
  for (const [k, v] of Object.entries(fields)) {
    entry[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : serialize(v);
  }
  if (stack && entry.stack === undefined) entry.stack = redact(stack);
  return entry;
}

function formatPretty(entry: LogEntry): string {
  const { time, level, context, msg, stack, ...fields } = entry;
  const extra = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
  const head = `${time} ${level.toUpperCase().padEnd(5)} [${context ?? 'App'}] ${msg}${extra}`;
  return typeof stack === 'string' ? `${head}\n${stack}` : head;
}

export class AppLogger implements LoggerService {
  private readonly json: boolean;
  private readonly threshold: number;

  constructor(
    private readonly write: LogWriter = defaultWriter,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    const production = env.NODE_ENV === 'production';
    this.json = env.LOG_FORMAT ? env.LOG_FORMAT === 'json' : production;
    const wanted = (env.LOG_LEVEL ?? '').toLowerCase() as LogLevel;
    this.threshold = LEVELS.indexOf(LEVELS.includes(wanted) ? wanted : production ? 'log' : 'debug');
  }

  private emit(level: LogLevel, message: unknown, params: unknown[]) {
    if (LEVELS.indexOf(level) < this.threshold) return;
    const entry = buildEntry(level, message, params);
    this.write(level, this.json ? JSON.stringify(entry) : formatPretty(entry));
  }

  verbose(message: unknown, ...params: unknown[]) {
    this.emit('verbose', message, params);
  }
  debug(message: unknown, ...params: unknown[]) {
    this.emit('debug', message, params);
  }
  log(message: unknown, ...params: unknown[]) {
    this.emit('log', message, params);
  }
  warn(message: unknown, ...params: unknown[]) {
    this.emit('warn', message, params);
  }
  error(message: unknown, ...params: unknown[]) {
    this.emit('error', message, params);
  }
  fatal(message: unknown, ...params: unknown[]) {
    this.emit('fatal', message, params);
  }
}
