import { runtimeEnv } from "@/lib/runtime";
import { mainMenuMarkup, telegram } from "@/lib/telegram";

async function checkGemini(apiKey: string): Promise<number> {
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
    { headers: { "x-goog-api-key": apiKey } },
  );
  return response.status;
}

export async function POST(request: Request): Promise<Response> {
  const env = runtimeEnv();
  if (String(env.SETUP_ENABLED).toLowerCase() !== "true") {
    return Response.json({ ok: false }, { status: 404 });
  }

  const secret = env.WEBHOOK_SECRET?.trim();
  const missing = [
    !env.TELEGRAM_BOT_TOKEN?.trim() ? "TELEGRAM_BOT_TOKEN" : "",
    !env.GEMINI_API_KEY?.trim() ? "GEMINI_API_KEY" : "",
    !secret ? "WEBHOOK_SECRET" : "",
  ].filter(Boolean);
  if (missing.length || !secret) {
    return Response.json(
      { ok: false, status: "missing_secrets", missing },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const geminiStatus = await checkGemini(env.GEMINI_API_KEY!.trim());
  if (geminiStatus < 200 || geminiStatus >= 300) {
    return Response.json(
      { ok: false, status: "gemini_key_failed", provider_status: geminiStatus },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const origin = new URL(request.url).origin;
    const webhookUrl = `${origin}/api/telegram/${secret}`;
    const webhook = await telegram(env, "setWebhook", {
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: [
        "message",
        "callback_query",
        "poll",
        "poll_answer",
        "my_chat_member",
      ],
      drop_pending_updates: true,
      max_connections: 1,
    });
    await telegram(env, "setMyCommands", {
      commands: [
        { command: "start", description: "شروع و راهنما" },
        { command: "home", description: "لغو حالت فعلی و خانه" },
        { command: "go", description: "پایان ارسال عکس و شروع آزمون" },
        { command: "chatquiz", description: "ساخت آزمون از متن ChatGPT" },
        { command: "status", description: "راهنمای وضعیت پردازش" },
        { command: "help", description: "راهنمای ارسال PDF" },
        { command: "cancel", description: "راهنمای لغو پردازش" },
      ],
    });
    await telegram(env, "setMyDescription", {
      description:
        "PDF آزمون را می‌خوانم و سؤال‌های دارای پاسخ صریح را به Quiz واقعی تلگرام تبدیل می‌کنم؛ فارسی، انگلیسی و فایل‌های اسکن‌شده پشتیبانی می‌شوند.",
    });
    await telegram(env, "setMyShortDescription", {
      short_description: "تبدیل PDF آزمون فارسی به Quiz تلگرام",
    });
    const bot = (await telegram(env, "getMe", {})) as {
      username?: string;
      id?: number;
      can_join_groups?: boolean;
      supports_inline_queries?: boolean;
    };
    let notified = false;
    const ownerId = Number(env.OWNER_ID || "267516215");
    if (Number.isFinite(ownerId)) {
      try {
        await telegram(env, "sendMessage", {
          chat_id: ownerId,
          text: "\u200fنسخهٔ جدید ربات فعال شد ✅\nPDFهای کتابی و طولانی حالا بخش‌به‌بخش پردازش می‌شوند، پیام‌ها راست‌چین شده‌اند و Quiz پاسخ درست را ثبت می‌کند. لطفاً PDF را دوباره بفرست.",
          reply_markup: mainMenuMarkup(),
        });
        notified = true;
      } catch (error) {
        console.warn("Owner notification was not delivered", error);
      }
    }
    return Response.json(
      {
        ok: true,
        webhook: Boolean(webhook),
        gemini: true,
        bot: bot.username || bot.id || null,
        can_join_groups: bot.can_join_groups ?? null,
        notified,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("Bot setup failed", error);
    return Response.json(
      { ok: false, status: "telegram_setup_failed" },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
