import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MODEL_ID = "claude-3-haiku-20240307";
const MODEL_TAG = "haiku";

interface LegacyDeal {
  dealName: string;
  notes: string[];
}

interface CachedDeal {
  deal_key: string;
  notes_hash: string;
  notes_canonical: string;
  dealName: string;
}

// Helper: call Claude API for a list of deals and return { dealName: summary }
async function callClaude(
  apiKey: string,
  dealsList: string
): Promise<Record<string, string>> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL_ID,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: `You are summarizing CRM deal notes for a sales dashboard. For each deal below, write a very condensed 1-2 sentence executive summary capturing the key status, actions, and next steps. Be direct and factual.

Return ONLY a JSON object where keys are the exact deal names and values are the summary strings. No markdown, no code fences, just the JSON object.

${dealsList}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("Claude API error:", response.status, errText);
    throw new Error(`Claude API call failed: ${response.status}`);
  }

  const result = await response.json();
  const text = result.content?.[0]?.text || "{}";

  try {
    return JSON.parse(text);
  } catch {
    console.error("Failed to parse Claude response as JSON:", text);
    return {};
  }
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { deals } = await req.json();

    if (!deals || !Array.isArray(deals) || deals.length === 0) {
      return new Response(
        JSON.stringify({ error: "No deals provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Detect payload format
    const isNewFormat = deals[0]?.deal_key !== undefined;

    if (!isNewFormat) {
      // ==================== LEGACY PATH (unchanged) ====================
      const dealsList = (deals as LegacyDeal[])
        .map(
          (d, i) =>
            `Deal ${i + 1}: "${d.dealName}"\nNotes:\n${d.notes.map((n: string) => `- ${n}`).join("\n")}`
        )
        .join("\n\n");

      const summaries = await callClaude(apiKey, dealsList);

      return new Response(JSON.stringify({ summaries }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ==================== NEW CACHE-FIRST PATH ====================
    const typedDeals = deals as CachedDeal[];

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1. Check cache for all deal_keys
    const dealKeys = typedDeals.map((d) => d.deal_key);
    const { data: cachedRows, error: cacheError } = await supabase
      .from("deal_summary_cache")
      .select("deal_key, notes_hash, summary")
      .eq("model", MODEL_TAG)
      .in("deal_key", dealKeys);

    if (cacheError) {
      console.error("Cache lookup error:", cacheError);
    }

    // Build cache map keyed by "deal_key||notes_hash" for exact match
    const cacheMap = new Map<string, string>();
    for (const row of cachedRows || []) {
      cacheMap.set(`${row.deal_key}||${row.notes_hash}`, row.summary);
    }

    // 2. Split hits vs misses
    const results: { deal_key: string; notes_hash: string; summary: string; cached: boolean }[] = [];
    const misses: CachedDeal[] = [];

    for (const deal of typedDeals) {
      const cacheKey = `${deal.deal_key}||${deal.notes_hash}`;
      const cached = cacheMap.get(cacheKey);
      if (cached) {
        results.push({ deal_key: deal.deal_key, notes_hash: deal.notes_hash, summary: cached, cached: true });
      } else {
        misses.push(deal);
      }
    }

    console.log(`Cache: ${results.length} hits, ${misses.length} misses out of ${typedDeals.length} deals`);

    // 3. Call Claude for misses only
    if (misses.length > 0) {
      const dealsList = misses
        .map(
          (d, i) => {
            // Use notes_canonical (notes joined with \n---\n) as bullet points
            const noteLines = d.notes_canonical
              .split("\n---\n")
              .map((n: string) => `- ${n.trim()}`)
              .join("\n");
            return `Deal ${i + 1}: "${d.dealName}"\nNotes:\n${noteLines}`;
          }
        )
        .join("\n\n");

      const newSummaries = await callClaude(apiKey, dealsList);

      // 4. Store new summaries in cache and add to results
      const rowsToInsert: { deal_key: string; notes_hash: string; model: string; summary: string }[] = [];

      for (const deal of misses) {
        const summary = newSummaries[deal.dealName] || "";
        results.push({ deal_key: deal.deal_key, notes_hash: deal.notes_hash, summary, cached: false });

        if (summary) {
          rowsToInsert.push({
            deal_key: deal.deal_key,
            notes_hash: deal.notes_hash,
            model: MODEL_TAG,
            summary,
          });
        }
      }

      if (rowsToInsert.length > 0) {
        const { error: insertError } = await supabase
          .from("deal_summary_cache")
          .upsert(rowsToInsert, { onConflict: "deal_key,notes_hash,model" });

        if (insertError) {
          console.error("Cache insert error:", insertError);
        } else {
          console.log(`Cached ${rowsToInsert.length} new summaries`);
        }
      }
    }

    return new Response(JSON.stringify({ summaries: results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
