// Minimal pino-style JSON-lines logger (one object per line on stdout). Callers must never
// pass secrets (HMAC secret, API key, TOTP secret, access token) in fields.

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 20, info: 30, warn: 40, error: 50 };

export interface LoggerOptions {
  level?: LogLevel;
  base?: LogFields;
  write?: (line: string) => void;
  now?: () => number;
}

export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) {
    const out: LogFields = { name: err.name, message: err.message };
    const extra = err as Error & { kind?: unknown; code?: unknown; httpStatus?: unknown };
    if (extra.kind !== undefined) out.kind = extra.kind;
    if (extra.code !== undefined) out.code = extra.code;
    if (extra.httpStatus !== undefined) out.httpStatus = extra.httpStatus;
    return out;
  }
  return { message: String(err) };
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const min = LEVELS[opts.level ?? "info"];
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = opts.now ?? Date.now;
  const base = opts.base ?? {};

  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (LEVELS[level] < min) return;
    let line: string;
    try {
      line = JSON.stringify({ level, time: new Date(now()).toISOString(), msg, ...base, ...fields });
    } catch {
      line = JSON.stringify({ level, time: new Date(now()).toISOString(), msg, ...base, logError: "unserializable fields" });
    }
    write(line);
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) => createLogger({ ...opts, base: { ...base, ...fields } }),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
