import { supabase } from "@/integrations/supabase/client";

// Cache slug lookups in-memory so we don't hit DB repeatedly per render.
const slugCache = new Map<string, string | null>();

type CacheRow = { asset_id: string; data: any; market_id: string | null };

export async function getMarketUrl(assetId: string): Promise<string> {
  if (slugCache.has(assetId)) {
    const slug = slugCache.get(assetId);
    if (slug) return `https://polymarket.com/event/${slug}`;
  } else {
    const { data } = await supabase
      .from("markets_cache")
      .select("asset_id,data,market_id")
      .eq("asset_id", assetId)
      .maybeSingle<CacheRow>();
    const d = data?.data ?? {};
    const slug = d.eventSlug ?? d.slug ?? null;
    slugCache.set(assetId, slug);
    if (slug) return `https://polymarket.com/event/${slug}`;
    if (data?.market_id) return `https://polymarket.com/market/${data.market_id}`;
  }
  // Fallback: Polymarket search by token id
  return `https://polymarket.com/markets?q=${assetId}`;
}

export async function copyMarketLink(assetId: string): Promise<string> {
  const url = await getMarketUrl(assetId);
  await navigator.clipboard.writeText(url);
  return url;
}
