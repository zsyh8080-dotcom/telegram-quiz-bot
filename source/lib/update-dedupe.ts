const UPDATE_TTL_MS = 30 * 60 * 1000;
const recentUpdates = new Map<number, number>();

type CacheWithDefault = CacheStorage & { default?: Cache };

function prune(now: number): void {
  for (const [updateId, expiresAt] of recentUpdates) {
    if (expiresAt <= now) recentUpdates.delete(updateId);
  }
}

export async function claimTelegramUpdate(
  updateId: number | undefined,
  requestUrl: string,
  now = Date.now(),
): Promise<boolean> {
  if (!Number.isSafeInteger(updateId) || updateId === undefined) return true;
  prune(now);
  if ((recentUpdates.get(updateId) ?? 0) > now) return false;
  recentUpdates.set(updateId, now + UPDATE_TTL_MS);

  try {
    const cache = (globalThis.caches as CacheWithDefault | undefined)?.default;
    if (!cache) return true;
    const key = new URL(requestUrl);
    key.pathname = `/__telegram_update_seen__/${updateId}`;
    key.search = "";
    key.hash = "";
    const request = new Request(key, { method: "GET" });
    if (await cache.match(request)) return false;
    await cache.put(
      request,
      new Response("1", {
        headers: { "Cache-Control": "public, max-age=1800" },
      }),
    );
  } catch {}
  return true;
}

export function resetTelegramUpdateClaimsForTest(): void {
  recentUpdates.clear();
}
