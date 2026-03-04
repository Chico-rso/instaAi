import pino, { Logger } from "pino";

export type AppLogger = Logger;

export function createLogger(level: string): AppLogger {
  return pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
