import { env as bindings } from "cloudflare:workers";

export type RuntimeEnv = {
  TELEGRAM_BOT_TOKEN?: string;
  GEMINI_API_KEY?: string;
  BLUESMINDS_API_KEY?: string;
  BLUESMINDS_MODEL?: string;
  MISTRAL_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  TOKENROUTER_API_KEY?: string;
  TOKENROUTER_BACKUP_API_KEY?: string;
  TOKENROUTER_MODEL?: string;
  FORGE_API_KEY?: string;
  FORGE_MODEL?: string;
  GROQ_API_KEY?: string;
  GROQ_BACKUP_API_KEY?: string;
  GROQ_MODEL?: string;
  SAMBANOVA_API_KEY?: string;
  SAMBANOVA_BACKUP_API_KEY?: string;
  SAMBANOVA_MODEL?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_BACKUP_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  MISTRAL_BACKUP_API_KEY?: string;
  MISTRAL_CHAT_MODEL?: string;
  CUSTOM_OPENAI_API_KEY?: string;
  OCR_SPACE_API_KEY?: string;
  WEBHOOK_SECRET?: string;
  SETUP_ENABLED?: string;
  ADMIN_USER_ID?: string;
  OWNER_ID?: string;
  PUBLIC_ACCESS?: string;
  DIAGNOSTIC_SECRET?: string;
};

export function runtimeEnv(): RuntimeEnv {
  return bindings as RuntimeEnv;
}

export function configured(env: RuntimeEnv): boolean {
  return Boolean(
    env.TELEGRAM_BOT_TOKEN?.trim() &&
      (env.GEMINI_API_KEY?.trim() ||
        env.BLUESMINDS_API_KEY?.trim() ||
        env.MISTRAL_API_KEY?.trim() ||
        env.OPENROUTER_API_KEY?.trim() ||
        env.TOKENROUTER_API_KEY?.trim() ||
        env.FORGE_API_KEY?.trim() ||
        env.GROQ_API_KEY?.trim() ||
        env.SAMBANOVA_API_KEY?.trim() ||
        env.DEEPSEEK_API_KEY?.trim() ||
        env.CUSTOM_OPENAI_API_KEY?.trim()) &&
      env.WEBHOOK_SECRET?.trim(),
  );
}
