import { supabase } from "@/integrations/supabase/client";

const slugCache = new Map<string, string>();

type CacheRow = { asset_id: string; data: any; market_id: string | null };

function urlFromCache(assetId: string, data: any, marketId: string | null): string {
  const slug = data?.eventSlug ?? data?.slug;
  if (slug) return `https://polymarket.com/event/${slug}`;
  if (marketId) return `https://polymarket.com/market/${marketId}`;
  return `https://polymarket.com/markets?q=${assetId}`;
}

export function getCachedMarketUrl(assetId: string): string | null {
  return slugCache.get(assetId) ?? null;
}

export async function prefetchMarketUrls(assetIds: string[]): Promise<void> {
  const missing = Array.from(new Set(assetIds.filter((id) => id && !slugCache.has(id))));
  if (missing.length === 0) return;
  const { data } = await supabase
    .from("markets_cache")
    .select("asset_id,data,market_id")
    .in("asset_id", missing);
  const byId = new Map<string, CacheRow>();
  (data ?? []).forEach((r: any) => byId.set(r.asset_id, r));
  for (const id of missing) {
    const row = byId.get(id);
    slugCache.set(id, urlFromCache(id, row?.data, row?.market_id ?? null));
  }
}

export async function getMarketUrl(assetId: string): Promise<string> {
  const cached = slugCache.get(assetId);
  if (cached) return cached;
  await prefetchMarketUrls([assetId]);
  return slugCache.get(assetId) ?? `https://polymarket.com/markets?q=${assetId}`;
}

/** Synchronous copy that works inside iframes / restricted clipboard contexts. */
export function copyTextSync(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) return true;
  } catch {
    /* fall through */
  }
  // Best-effort async clipboard
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
    return true;
  }
  return false;
}
