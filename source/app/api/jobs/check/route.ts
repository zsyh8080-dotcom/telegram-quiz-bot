import { after } from "next/server";
import { runtimeEnv } from "@/lib/runtime";
import { runAutomaticPdfCheck, type AutomaticPdfCheck } from "@/lib/telegram";

function validPayload(value: unknown): value is AutomaticPdfCheck {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<AutomaticPdfCheck>;
  const tracked = payload.tracked;
  return (
    Number.isSafeInteger(payload.chat_id) &&
    Number.isSafeInteger(payload.message_id) &&
    Boolean(tracked?.job) &&
    typeof tracked?.job?.id === "string" &&
    typeof tracked?.job?.started_at === "number" &&
    typeof tracked?.offset === "number" &&
    Number.isSafeInteger(tracked?.requester_id)
  );
}

export async function POST(request: Request): Promise<Response> {
  const env = runtimeEnv();
  const expected = env.WEBHOOK_SECRET?.trim();
  if (!expected || request.headers.get("x-bot-internal-secret") !== expected) {
    return Response.json({ ok: false }, { status: 403 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!validPayload(payload)) {
    return Response.json(
      { ok: false, error: "invalid_payload" },
      { status: 400 },
    );
  }

  const origin = new URL(request.url).origin;
  after(async () => {
    try {
      await runAutomaticPdfCheck(env, origin, payload);
    } catch (error) {
      console.error("Automatic PDF monitor failed", error);
    }
  });
  return Response.json(
    { ok: true },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}
