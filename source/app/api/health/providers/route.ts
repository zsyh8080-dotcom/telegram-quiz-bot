import {
  extractPdfTextWithGemini,
  extractPdfTextWithBluesMinds,
  getOpenRouterKeyInfo,
  listBluesMindsModels,
} from "@/lib/gemini";
import { runtimeEnv } from "@/lib/runtime";
import {
  activeBluesMindsApiKey,
  activeGeminiApiKey,
  activeOpenRouterApiKey,
} from "@/lib/secure-config";

export async function GET(request: Request): Promise<Response> {
  const env = runtimeEnv();
  if (new URL(request.url).searchParams.get("provider") === "openrouter") {
    const openRouterKey = await activeOpenRouterApiKey(env);
    if (!openRouterKey) {
      return Response.json(
        { ok: false, openrouter: false, code: "O-NOT-CONFIGURED" },
        { status: 503, headers: { "cache-control": "public, max-age=60" } },
      );
    }
    try {
      const info = await getOpenRouterKeyInfo(openRouterKey, 5_000);
      return Response.json(
        {
          ok: true,
          openrouter: true,
          model: env.OPENROUTER_MODEL?.trim() || "openrouter/free",
          free_tier: info.is_free_tier,
        },
        { headers: { "cache-control": "public, max-age=300" } },
      );
    } catch (error) {
      const code = /AUTH|401|403/i.test(String(error))
        ? "O-AUTH"
        : "O-UNAVAILABLE";
      return Response.json(
        { ok: false, openrouter: false, code },
        { status: 503, headers: { "cache-control": "public, max-age=60" } },
      );
    }
  }
  const key = await activeBluesMindsApiKey(env);
  if (!key) {
    return Response.json(
      { ok: false, bluesminds: false, code: "B-NOT-CONFIGURED" },
      { status: 503, headers: { "cache-control": "public, max-age=60" } },
    );
  }
  try {
    const models = await listBluesMindsModels(key, 5_000);
    return Response.json(
      {
        ok: true,
        bluesminds: true,
        available_models: models.ids.length,
        model_ids: models.ids.slice(0, 10),
      },
      { headers: { "cache-control": "public, max-age=300" } },
    );
  } catch (error) {
    const detail = String(error);
    const code = /AUTH|401|403/i.test(detail)
      ? "B-AUTH"
      : /QUOTA|429/i.test(detail)
        ? "B-QUOTA"
        : "B-UNAVAILABLE";
    return Response.json(
      { ok: false, bluesminds: false, code },
      { status: 503, headers: { "cache-control": "public, max-age=60" } },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const env = runtimeEnv();
  const expected = env.DIAGNOSTIC_SECRET?.trim();
  if (!expected || request.headers.get("x-diagnostic-secret") !== expected) {
    return Response.json({ ok: false }, { status: 403 });
  }
  const input = (await request.json().catch(() => ({}))) as {
    provider?: unknown;
  };
  const provider = input.provider === "bluesminds" ? "bluesminds" : "gemini";
  const sample = [
    "--- PDF PAGE 1 ---",
    "1. پایتخت ایران کدام شهر است؟",
    "1) تهران",
    "2) شیراز",
    "3) تبریز",
    "4) رشت",
    "پاسخ صریح: گزینه 1؛ تهران پاسخ درست است.",
  ].join("\n");
  if (provider === "gemini") {
    const key = await activeGeminiApiKey(env);
    if (!key)
      return Response.json(
        { ok: false, provider, code: "G-NOT-CONFIGURED" },
        { status: 503 },
      );
    try {
      const questions = await extractPdfTextWithGemini(sample, key, {
        page_start: 1,
        page_end: 1,
        total_pages: 1,
      });
      return Response.json({
        ok: questions.length > 0,
        provider,
        quiz_questions: questions.length,
      });
    } catch (error) {
      const detail = String(error);
      const code =
        detail.match(/\[G-([A-Z]+)\]/)?.[1] ??
        (/Timeout/i.test(detail) ? "TIMEOUT" : "OUTPUT");
      console.warn("Gemini deep health probe failed", detail.slice(0, 300));
      return Response.json(
        { ok: false, provider, code: `G-${code}` },
        { status: 503 },
      );
    }
  }
  const key = await activeBluesMindsApiKey(env);
  if (!key)
    return Response.json(
      { ok: false, provider, code: "B-NOT-CONFIGURED" },
      { status: 503 },
    );
  try {
    const questions = await extractPdfTextWithBluesMinds(
      sample,
      key,
      { page_start: 1, page_end: 1, total_pages: 1 },
      env.BLUESMINDS_MODEL,
    );
    return Response.json({
      ok: questions.length > 0,
      provider,
      quiz_questions: questions.length,
    });
  } catch (error) {
    const detail = String(error);
    const code = /AUTH|401|403/i.test(detail)
      ? "B-AUTH"
      : /QUOTA|429/i.test(detail)
        ? "B-QUOTA"
        : /UPSTREAM|5\d\d/i.test(detail)
          ? "B-UPSTREAM"
          : "B-OUTPUT";
    console.warn("BluesMinds deep health probe failed", detail.slice(0, 300));
    return Response.json({ ok: false, code }, { status: 503 });
  }
}
