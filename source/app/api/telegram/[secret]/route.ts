import { after } from "next/server";
import { runtimeEnv } from "@/lib/runtime";
import {
  checkGeminiQuotaRecovery,
  ensureTelegramWebhookFeatures,
  processTelegramUpdate,
  type TelegramUpdate,
} from "@/lib/telegram";
import { claimTelegramUpdate } from "@/lib/update-dedupe";

export async function POST(
  request: Request,
  context: { params: Promise<{ secret: string }> },
): Promise<Response> {
  const env = runtimeEnv();
  const { secret } = await context.params;
  const expected = env.WEBHOOK_SECRET?.trim();
  const header = request.headers.get("x-telegram-bot-api-secret-token");
  if (!expected || secret !== expected || header !== expected) {
    return Response.json({ ok: false }, { status: 403 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  if (!(await claimTelegramUpdate(update.update_id, request.url))) {
    return Response.json(
      { ok: true, duplicate: true },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const origin = new URL(request.url).origin;
  after(async () => {
    try {
      const backgroundTask = await processTelegramUpdate(env, update, origin);
      if (backgroundTask) await backgroundTask();
    } catch (error) {
      console.error("Telegram update failed", error);
    }
    try {
      await ensureTelegramWebhookFeatures(env, origin);
    } catch (error) {
      console.warn("Telegram webhook feature refresh failed", error);
    }
    try {
      await checkGeminiQuotaRecovery(env);
    } catch (error) {
      console.warn("Gemini recovery monitor failed", error);
    }
  });
  return Response.json(
    { ok: true },
    { headers: { "cache-control": "no-store" } },
  );
}
