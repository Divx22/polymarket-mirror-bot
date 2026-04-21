// Detects how a Polymarket weather market resolves integer-temp buckets:
// rounded (9.5≤T<10.5 → "10°C"), floor (10.0≤T<11.0 → "10°C"),
// ceiling (9.0<T≤10.0 → "10°C"), or unknown.
//
// Steps:
// 1. Fetch the polymarket URL HTML
// 2. Strip down to text & look for "Resolution"/"Resolution details" section
// 3. Send the snippet + bucket labels to Lovable AI (Gemini 2.5 Flash)
//    asking for a JSON classification.
// 4. Save result to weather_markets.resolution_method.
//
// Body: { market_id?: string, all_pending?: boolean }
// - market_id: classify a single market
// - all_pending: classify every active market with NULL resolution_method (cap 25/run)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;

type Method = "rounded" | "floor" | "ceiling" | "unknown";

async function fetchResolutionText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; WeatherEdgeBot/1.0)",
        Accept: "text/html",
      },
    });
    if (!r.ok) return null;
    const html = await r.text();
    // Strip scripts/styles
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
    // Try to find "Resolution" section; otherwise return last 4000 chars (rules tend to be near bottom)
    const idx = stripped.search(/resolution\s*details|how it resolves|this market resolves|rules/i);
    if (idx >= 0) return stripped.slice(idx, idx + 3000);
    return stripped.slice(-4000);
  } catch {
    return null;
  }
}

async function classifyWithAI(args: {
  question: string;
  bucketLabels: string[];
  resolutionText: string;
}): Promise<{ method: Method; notes: string }> {
  const prompt = `You are analyzing a Polymarket weather market resolution rule.

Market question: "${args.question}"
Bucket labels (each represents one resolution outcome): ${args.bucketLabels.slice(0, 12).join(", ")}

Resolution rules excerpt (may be noisy/contain extra page text):
"""
${args.resolutionText.slice(0, 3000)}
"""

Each integer-temp bucket like "10°C" maps a continuous measured temperature to one bucket.
Classify the mapping convention:
- "rounded": standard rounding (e.g. 9.5 ≤ T < 10.5 → "10°C")
- "floor": truncation (e.g. 10.0 ≤ T < 11.0 → "10°C")
- "ceiling": round up (e.g. 9.0 < T ≤ 10.0 → "10°C")
- "unknown": rules don't make this clear

Look for explicit phrases like "rounded to the nearest", "to the nearest whole degree",
"floor", "rounded down", "rounded up", or look at how thresholds are described.
If the rules mention "official high/low from station X reported as integer", that's
usually rounded (NWS and most stations report rounded integers).

Respond with ONLY a JSON object: {"method": "...", "notes": "<one short sentence why>"}`;

  const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`AI gateway ${r.status}: ${txt.slice(0, 200)}`);
  }
  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content ?? "{}";
  let parsed: { method?: string; notes?: string } = {};
  try {
    parsed = JSON.parse(content);
  } catch {
    // sometimes wrapped in code fences
    const m = content.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  }
  const method = (["rounded", "floor", "ceiling", "unknown"].includes(parsed.method ?? "")
    ? parsed.method
    : "unknown") as Method;
  return { method, notes: (parsed.notes ?? "").toString().slice(0, 500) };
}

async function classifyOne(supabase: any, marketId: string): Promise<{ ok: boolean; method?: Method; error?: string }> {
  const { data: market, error: mErr } = await supabase
    .from("weather_markets")
    .select("id, market_question, polymarket_url")
    .eq("id", marketId)
    .maybeSingle();
  if (mErr || !market) return { ok: false, error: "market not found" };
  if (!market.polymarket_url) {
    await supabase
      .from("weather_markets")
      .update({
        resolution_method: "unknown",
        resolution_method_detected_at: new Date().toISOString(),
        resolution_method_notes: "no polymarket_url",
      })
      .eq("id", marketId);
    return { ok: true, method: "unknown" };
  }

  const { data: outcomes } = await supabase
    .from("weather_outcomes")
    .select("label")
    .eq("market_id", marketId)
    .order("display_order");
  const bucketLabels = (outcomes ?? []).map((o: any) => o.label);

  const text = await fetchResolutionText(market.polymarket_url);
  if (!text) {
    await supabase
      .from("weather_markets")
      .update({
        resolution_method: "unknown",
        resolution_method_detected_at: new Date().toISOString(),
        resolution_method_notes: "could not fetch polymarket page",
      })
      .eq("id", marketId);
    return { ok: true, method: "unknown" };
  }

  try {
    const { method, notes } = await classifyWithAI({
      question: market.market_question,
      bucketLabels,
      resolutionText: text,
    });
    await supabase
      .from("weather_markets")
      .update({
        resolution_method: method,
        resolution_method_detected_at: new Date().toISOString(),
        resolution_method_notes: notes,
      })
      .eq("id", marketId);
    return { ok: true, method };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json().catch(() => ({}));

    if (body?.market_id) {
      const result = await classifyOne(supabase, body.market_id);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: result.ok ? 200 : 400,
      });
    }

    if (body?.all_pending) {
      const { data: pending } = await supabase
        .from("weather_markets")
        .select("id")
        .eq("active", true)
        .is("resolution_method", null)
        .limit(25);
      const ids = (pending ?? []).map((m: any) => m.id);
      const results: any[] = [];
      for (const id of ids) {
        const r = await classifyOne(supabase, id);
        results.push({ id, ...r });
        await new Promise((res) => setTimeout(res, 800)); // throttle
      }
      return new Response(JSON.stringify({ processed: results.length, results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "provide market_id or all_pending" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
