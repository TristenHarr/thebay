import { existsSync } from "node:fs";
import { z } from "zod";

// Load .env (Node 20.12+). Harmless if the file is absent.
if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* ignore */
  }
}

const truthy = (v: string | undefined) => v === "1" || v?.toLowerCase() === "true";

const EnvSchema = z.object({
  OPENROUTER_API_KEY: z.string().optional().default(""),
  OPENROUTER_MODEL: z.string().default("google/gemini-2.0-flash-001"),
  AI_BATCH_SIZE: z.coerce.number().int().positive().default(20),
  EVENTBRITE_TOKEN: z.string().optional().default(""),
  AIRTABLE_TOKEN: z.string().optional().default(""),
  DATABASE_PATH: z.string().default("./data/eventers.db"),
  PORT: z.coerce.number().int().positive().default(8787),
  SCRAPE_CRON: z.string().default("0 7 * * *"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

const parsed = EnvSchema.parse(process.env);

export const env = {
  ...parsed,
  BROWSER_HEADFUL: truthy(process.env.BROWSER_HEADFUL),
};
export type Env = typeof env;

export const aiEnabled = (): boolean => env.OPENROUTER_API_KEY.trim().length > 0;
