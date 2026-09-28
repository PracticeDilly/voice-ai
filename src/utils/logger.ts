import { config } from "../config/env.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const rank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function shouldLog(level: LogLevel): boolean {
  return rank[level] >= rank[config.LOG_LEVEL];
}

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, nestedValue: unknown) => (
      typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue
    ));
  } catch (error) {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      message: "Logger serialization failed",
      meta: { error: String(error) }
    });
  }
}

function write(level: LogLevel, message: string, meta?: unknown): void {
  if (!shouldLog(level)) {
    return;
  }
  const line = {
    timestamp: new Date().toISOString(),
    level,
    message,
    meta
  };
  const serialized = serialize(line);
  if (level === "error") {
    console.error(serialized);
    return;
  }

  console.log(serialized);
}

export const logger = {
  debug: (message: string, meta?: unknown) => write("debug", message, meta),
  info: (message: string, meta?: unknown) => write("info", message, meta),
  warn: (message: string, meta?: unknown) => write("warn", message, meta),
  error: (message: string, meta?: unknown) => write("error", message, meta)
};
