import { redact, redactString } from "./redact.js";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug" | "trace";
export type LogFields = Record<string, unknown>;

/**
 * Minimal structured logger contract. Compatible in spirit with pino/winston/bunyan: adapt
 * yours with a few lines. Implementations decide their own level filtering.
 */
export interface Logger {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  trace(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

const LEVEL_RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
type EmitLevel = Exclude<LogLevel, "silent">;

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && value in LEVEL_RANK;
}

class SilentLogger implements Logger {
  error(): void {}
  warn(): void {}
  info(): void {}
  debug(): void {}
  trace(): void {}
  child(): Logger {
    return this;
  }
}

/** The default logger: discards everything. The library never writes to the console unless asked. */
export const silentLogger: Logger = new SilentLogger();

export interface ConsoleLoggerOptions {
  level?: LogLevel;
  format?: "pretty" | "json";
  /** Output sink. Defaults to process.stderr so stdout stays free for the application. */
  write?: (line: string) => void;
  now?: () => Date;
}

class ConsoleLogger implements Logger {
  readonly #options: Required<ConsoleLoggerOptions>;
  readonly #rank: number;
  readonly #bindings: LogFields;

  constructor(options: Required<ConsoleLoggerOptions>, bindings: LogFields) {
    this.#options = options;
    this.#rank = LEVEL_RANK[options.level];
    this.#bindings = bindings;
  }

  #log(level: EmitLevel, message: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] > this.#rank) return;
    const merged = fields ? { ...this.#bindings, ...fields } : this.#bindings;
    const time = this.#options.now().toISOString();
    if (this.#options.format === "json") {
      this.#options.write(`${JSON.stringify({ time, level, msg: message, ...merged })}\n`);
      return;
    }
    const suffix = Object.keys(merged).length > 0 ? ` ${JSON.stringify(merged)}` : "";
    this.#options.write(`${time} ${level.toUpperCase().padEnd(5)} ${message}${suffix}\n`);
  }

  error(message: string, fields?: LogFields): void {
    this.#log("error", message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.#log("warn", message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.#log("info", message, fields);
  }
  debug(message: string, fields?: LogFields): void {
    this.#log("debug", message, fields);
  }
  trace(message: string, fields?: LogFields): void {
    this.#log("trace", message, fields);
  }
  child(bindings: LogFields): Logger {
    return new ConsoleLogger(this.#options, { ...this.#bindings, ...bindings });
  }
}

/** A simple stderr logger. Output passes through redaction because the client wraps every logger. */
export function createConsoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  return new ConsoleLogger(
    {
      level: options.level ?? "info",
      format: options.format ?? "pretty",
      write: options.write ?? ((line) => process.stderr.write(line)),
      now: options.now ?? (() => new Date()),
    },
    {},
  );
}

class RedactingLogger implements Logger {
  readonly #inner: Logger;

  constructor(inner: Logger) {
    this.#inner = inner;
  }

  #safe(level: EmitLevel, message: string, fields?: LogFields): void {
    try {
      const redactedFields = fields === undefined ? undefined : (redact(fields) as LogFields);
      this.#inner[level](redactString(message), redactedFields);
    } catch {
      // A broken user logger must never break the client.
    }
  }

  error(message: string, fields?: LogFields): void {
    this.#safe("error", message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.#safe("warn", message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.#safe("info", message, fields);
  }
  debug(message: string, fields?: LogFields): void {
    this.#safe("debug", message, fields);
  }
  trace(message: string, fields?: LogFields): void {
    this.#safe("trace", message, fields);
  }
  child(bindings: LogFields): Logger {
    try {
      return new RedactingLogger(this.#inner.child(redact(bindings) as LogFields));
    } catch {
      return this;
    }
  }
}

/**
 * Wraps any logger so that messages and fields are redacted and exceptions thrown by the
 * logger are swallowed. The client applies this to every logger it is given.
 */
export function createRedactingLogger(inner: Logger): Logger {
  return inner instanceof RedactingLogger || inner === silentLogger ? inner : new RedactingLogger(inner);
}
