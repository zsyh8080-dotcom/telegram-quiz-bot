import {
  loadEncryptedProviderSecret,
  saveEncryptedProviderSecret,
  type SecretProvider,
} from "./bot-state.ts";
import type { RuntimeEnv } from "./runtime.ts";
import { splitProviderKeys } from "./key-rotator.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

async function encryptionKey(env: RuntimeEnv): Promise<CryptoKey> {
  const seed = env.WEBHOOK_SECRET?.trim();
  if (!seed) throw new Error("Secret encryption is not configured");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(seed));
  return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function saveProviderApiKey(
  env: RuntimeEnv,
  provider: SecretProvider,
  apiKey: string,
): Promise<void> {
  const key = await encryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(apiKey),
  );
  await saveEncryptedProviderSecret(provider, {
    version: 1,
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(ciphertext)),
    updated_at: Date.now(),
  });
}

async function loadProviderOverride(
  env: RuntimeEnv,
  provider: SecretProvider,
): Promise<string | null> {
  const encrypted = await loadEncryptedProviderSecret(provider);
  if (!encrypted || encrypted.version !== 1) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(encrypted.iv) },
      await encryptionKey(env),
      fromBase64(encrypted.ciphertext),
    );
    return decoder.decode(plaintext).trim();
  } catch {
    return null;
  }
}

export async function saveGeminiApiKey(
  env: RuntimeEnv,
  apiKey: string,
): Promise<void> {
  await saveProviderApiKey(env, "gemini", apiKey);
}

export async function saveBluesMindsApiKey(
  env: RuntimeEnv,
  apiKey: string,
): Promise<void> {
  await saveProviderApiKey(env, "bluesminds", apiKey);
}

export async function saveMistralApiKey(
  env: RuntimeEnv,
  apiKey: string,
): Promise<void> {
  await saveProviderApiKey(env, "mistral", apiKey);
}

export async function saveOpenRouterApiKey(
  env: RuntimeEnv,
  apiKey: string,
): Promise<void> {
  await saveProviderApiKey(env, "openrouter", apiKey);
}

export async function saveTokenRouterApiKey(
  env: RuntimeEnv,
  apiKey: string,
): Promise<void> {
  await saveProviderApiKey(env, "tokenrouter", apiKey);
}

export async function saveForgeApiKey(
  env: RuntimeEnv,
  apiKey: string,
): Promise<void> {
  await saveProviderApiKey(env, "forge", apiKey);
}

export async function saveGroqApiKey(
  env: RuntimeEnv,
  apiKey: string,
): Promise<void> {
  await saveProviderApiKey(env, "groq", apiKey);
}

export async function saveSambaNovaApiKey(
  env: RuntimeEnv,
  apiKey: string,
): Promise<void> {
  await saveProviderApiKey(env, "sambanova", apiKey);
}

export async function saveDeepSeekApiKey(
  env: RuntimeEnv,
  apiKey: string,
): Promise<void> {
  await saveProviderApiKey(env, "deepseek", apiKey);
}

export async function saveCustomOpenAiApiKey(
  env: RuntimeEnv,
  apiKey: string,
): Promise<void> {
  await saveProviderApiKey(env, "custom", apiKey);
}

export async function activeGeminiApiKey(
  env: RuntimeEnv,
): Promise<string | null> {
  return (
    (await loadProviderOverride(env, "gemini")) ??
    env.GEMINI_API_KEY?.trim() ??
    null
  );
}

export async function activeBluesMindsApiKey(
  env: RuntimeEnv,
): Promise<string | null> {
  return (
    (await loadProviderOverride(env, "bluesminds")) ??
    env.BLUESMINDS_API_KEY?.trim() ??
    null
  );
}

export async function activeMistralApiKey(
  env: RuntimeEnv,
): Promise<string | null> {
  return (
    (await loadProviderOverride(env, "mistral")) ??
    env.MISTRAL_API_KEY?.trim() ??
    null
  );
}

export async function activeMistralApiKeys(env: RuntimeEnv): Promise<string[]> {
  return splitProviderKeys(
    await loadProviderOverride(env, "mistral"),
    env.MISTRAL_API_KEY,
    env.MISTRAL_BACKUP_API_KEY,
  );
}

export async function activeOpenRouterApiKey(
  env: RuntimeEnv,
): Promise<string | null> {
  return (
    (await loadProviderOverride(env, "openrouter")) ??
    env.OPENROUTER_API_KEY?.trim() ??
    null
  );
}

export async function activeTokenRouterApiKeys(
  env: RuntimeEnv,
): Promise<string[]> {
  const candidates = [
    await loadProviderOverride(env, "tokenrouter"),
    env.TOKENROUTER_API_KEY?.trim(),
    env.TOKENROUTER_BACKUP_API_KEY?.trim(),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(candidates)];
}

export async function activeCustomOpenAiApiKey(
  env: RuntimeEnv,
): Promise<string | null> {
  return (
    (await loadProviderOverride(env, "custom")) ??
    env.CUSTOM_OPENAI_API_KEY?.trim() ??
    null
  );
}

export async function activeForgeApiKey(
  env: RuntimeEnv,
): Promise<string | null> {
  return (
    (await loadProviderOverride(env, "forge")) ??
    env.FORGE_API_KEY?.trim() ??
    null
  );
}

export async function activeGroqApiKey(
  env: RuntimeEnv,
): Promise<string | null> {
  return (await activeGroqApiKeys(env))[0] ?? null;
}

export async function activeGroqApiKeys(env: RuntimeEnv): Promise<string[]> {
  return splitProviderKeys(
    await loadProviderOverride(env, "groq"),
    env.GROQ_API_KEY,
    env.GROQ_BACKUP_API_KEY,
  );
}

export async function activeSambaNovaApiKeys(
  env: RuntimeEnv,
): Promise<string[]> {
  return splitProviderKeys(
    await loadProviderOverride(env, "sambanova"),
    env.SAMBANOVA_API_KEY,
    env.SAMBANOVA_BACKUP_API_KEY,
  );
}

export async function activeDeepSeekApiKeys(
  env: RuntimeEnv,
): Promise<string[]> {
  return splitProviderKeys(
    await loadProviderOverride(env, "deepseek"),
    env.DEEPSEEK_API_KEY,
    env.DEEPSEEK_BACKUP_API_KEY,
  );
}

export async function geminiConfigured(env: RuntimeEnv): Promise<boolean> {
  return Boolean(await activeGeminiApiKey(env));
}

export async function bluesMindsConfigured(env: RuntimeEnv): Promise<boolean> {
  return Boolean(await activeBluesMindsApiKey(env));
}

export async function mistralConfigured(env: RuntimeEnv): Promise<boolean> {
  return Boolean(await activeMistralApiKey(env));
}

export async function openRouterConfigured(env: RuntimeEnv): Promise<boolean> {
  return Boolean(await activeOpenRouterApiKey(env));
}

export async function tokenRouterConfigured(env: RuntimeEnv): Promise<boolean> {
  return (await activeTokenRouterApiKeys(env)).length > 0;
}

export async function forgeConfigured(env: RuntimeEnv): Promise<boolean> {
  return Boolean(await activeForgeApiKey(env));
}

export async function groqConfigured(env: RuntimeEnv): Promise<boolean> {
  return (await activeGroqApiKeys(env)).length > 0;
}

export async function sambaNovaConfigured(env: RuntimeEnv): Promise<boolean> {
  return (await activeSambaNovaApiKeys(env)).length > 0;
}

export async function deepSeekConfigured(env: RuntimeEnv): Promise<boolean> {
  return (await activeDeepSeekApiKeys(env)).length > 0;
}

export async function customOpenAiConfigured(
  env: RuntimeEnv,
): Promise<boolean> {
  return (await activeCustomOpenAiApiKey(env)) !== null;
}
