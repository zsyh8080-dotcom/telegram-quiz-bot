import {
  advanceQuizExtraction,
  cancelQuizExtraction,
  detectPdfPageCount,
  startNextQuizBatch,
  startQuizExtraction,
  type GeminiJob,
} from "@/lib/gemini";
import { runtimeEnv } from "@/lib/runtime";
import { mainMenuMarkup, telegram } from "@/lib/telegram";

const MAX_BYTES = 20 * 1024 * 1024;

function allowed(request: Request): ReturnType<typeof runtimeEnv> | null {
  const env = runtimeEnv();
  const expected = env.DIAGNOSTIC_SECRET?.trim();
  const supplied = request.headers.get("x-diagnostic-secret");
  return expected && supplied === expected ? env : null;
}

function jobFrom(value: unknown): GeminiJob | null {
  if (!value || typeof value !== "object") return null;
  const job = value as GeminiJob;
  if (
    !["file", "interaction"].includes(job.kind) ||
    typeof job.id !== "string" ||
    typeof job.started_at !== "number" ||
    typeof job.page_start !== "number" ||
    typeof job.page_end !== "number"
  )
    return null;
  return job;
}

export async function POST(request: Request): Promise<Response> {
  const env = allowed(request);
  if (!env?.GEMINI_API_KEY?.trim()) {
    return Response.json({ ok: false }, { status: 404 });
  }

  try {
    if (request.headers.get("content-type")?.includes("application/pdf")) {
      const buffer = await request.arrayBuffer();
      if (!buffer.byteLength || buffer.byteLength > MAX_BYTES) {
        return Response.json(
          { ok: false, error: "invalid_size" },
          { status: 400 },
        );
      }
      const job = await startQuizExtraction(
        buffer,
        request.headers.get("x-filename") || "diagnostic.pdf",
        env.GEMINI_API_KEY.trim(),
      );
      return Response.json({
        ok: true,
        detected_pages: detectPdfPageCount(buffer) ?? null,
        job,
      });
    }

    const body = (await request.json()) as { action?: string; job?: unknown };
    if (body.action === "activate") {
      const webhookSecret = env.WEBHOOK_SECRET?.trim();
      if (!webhookSecret || !env.TELEGRAM_BOT_TOKEN?.trim()) {
        return Response.json(
          { ok: false, error: "telegram_not_configured" },
          { status: 503 },
        );
      }
      const origin = new URL(request.url).origin;
      await telegram(env, "setWebhook", {
        url: `${origin}/api/telegram/${webhookSecret}`,
        secret_token: webhookSecret,
        allowed_updates: ["message", "callback_query", "my_chat_member"],
        drop_pending_updates: false,
        max_connections: 10,
      });
      await telegram(env, "setMyCommands", {
        commands: [
          { command: "start", description: "شروع و راهنما" },
          { command: "menu", description: "نمایش منوی اصلی" },
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
        can_join_groups?: boolean;
        can_read_all_group_messages?: boolean;
      };
      const ownerId = Number(env.OWNER_ID || "267516215");
      if (Number.isFinite(ownerId)) {
        await telegram(env, "sendMessage", {
          chat_id: ownerId,
          text: "\u200fنسخهٔ جدید ربات فعال شد ✅\nPDFهای طولانی حالا بخش‌به‌بخش پردازش می‌شوند و پیام‌ها راست‌چین شده‌اند. PDF را دوباره بفرست.",
          reply_markup: mainMenuMarkup(),
        }).catch(() => undefined);
      }
      return Response.json({ ok: true, status: "activated", bot });
    }
    if (body.action === "webhook_info") {
      return Response.json({
        ok: true,
        status: "webhook_info",
        info: await telegram(env, "getWebhookInfo", {}),
      });
    }
    const job = jobFrom(body.job);
    if (!job)
      return Response.json(
        { ok: false, error: "invalid_job" },
        { status: 400 },
      );

    if (body.action === "cancel") {
      await cancelQuizExtraction(job, env.GEMINI_API_KEY.trim());
      return Response.json({ ok: true, status: "cancelled" });
    }
    if (body.action === "next") {
      const next = await startNextQuizBatch(job, env.GEMINI_API_KEY.trim());
      return Response.json({
        ok: true,
        status: next ? "processing" : "finished",
        job: next,
      });
    }

    const result = await advanceQuizExtraction(job, env.GEMINI_API_KEY.trim());
    if (result.status !== "completed") {
      return Response.json({ ok: true, ...result });
    }
    return Response.json({
      ok: true,
      status: result.status,
      job: result.job,
      question_count: result.questions.length,
      sample: result.questions.slice(0, 3),
    });
  } catch (error) {
    console.error("PDF diagnostic failed", error);
    return Response.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "diagnostic_failed",
      },
      { status: 502 },
    );
  }
}
