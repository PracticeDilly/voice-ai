import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8081),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  PUBLIC_WS_URL: z.string().url().optional(),
  SPRING_BOOT_BASE_URL: z.string().url(),
  SPRING_BOOT_SERVICE_TOKEN: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1).default("gpt-4.1-mini"),
  AI_MAX_SESSION_MINUTES: z.coerce.number().int().positive().default(20),
  AI_DEFAULT_OFFICE_TIMEZONE: z.string().default("America/Los_Angeles"),
  AI_END_OF_UTTERANCE_WINDOW_MS: z.coerce.number().int().positive().default(700),
  AI_PROCESSING_ACK_DELAY_MS: z.coerce.number().int().positive().default(4000),
  AI_PROCESSING_ACK_REPEAT_MS: z.coerce.number().int().positive().default(10000),
  AI_PROCESSING_SOUND_URL: z.string().url().optional(),
  AI_NO_INPUT_TIMEOUT_MS: z.coerce.number().int().positive().default(6000),
  AI_MAX_NO_INPUT_REPROMPTS: z.coerce.number().int().nonnegative().default(2),
  AI_MODEL_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  SPRING_BOOT_TIMEOUT_MS: z.coerce.number().int().positive().default(10000)
});

export type AppConfig = z.infer<typeof envSchema>;

export const config: AppConfig = envSchema.parse(process.env);
