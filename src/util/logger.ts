import pino from "pino";
import { env } from "../config/env";

// Pretty logs when attached to a TTY, plain JSON otherwise. Import pino-pretty
// lazily so production/non-TTY runs don't require it.
let stream: NodeJS.WritableStream | undefined;
if (process.stdout.isTTY) {
  try {
    const pretty = (await import("pino-pretty")).default;
    stream = pretty({
      colorize: true,
      translateTime: "SYS:HH:MM:ss",
      ignore: "pid,hostname",
    });
  } catch {
    stream = undefined;
  }
}

export const logger = stream
  ? pino({ level: env.LOG_LEVEL }, stream)
  : pino({ level: env.LOG_LEVEL });

export type Logger = typeof logger;
