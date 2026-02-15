import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MODEL_ID = "claude-3-haiku-20240307";
const MODEL_TAG = "haiku";

// Input limits
const MAX_DEALS_PER_REQUEST = 100;
const MAX_NOTES_CANONICAL_LENGTH = 50_000;

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

// Helper: call Claude API for a list of deals and return { index: summary }
async function callClaude(
  apiKey: string,
  dealsList: string,
  dealCount: number
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

Return a JSON object where keys are the deal numbers ("1", "2", etc.) and values are the summary strings. You must include all ${dealCount} deals.

${dealsList}`,
        },
        {
          role: "assistant",
          content: "{",
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
  const rawText = result.content?.[0]?.text || "}";
  // Prepend the "{" we used as prefill
  const text = "{" + rawText;

  try {
    return JSON.parse(text);
  } catch {
    console.error("Failed to parse Claude response as JSON:", text.slice(0, 500));
    // Try extracting JSON from the response (in case of markdown fences)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        // fall through
      }
    }
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

    if (deals.length > MAX_DEALS_PER_REQUEST) {
      return new Response(
        JSON.stringify({ error: `Too many deals: ${deals.length} exceeds limit of ${MAX_DEALS_PER_REQUEST}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate fields on new-format deals
    for (let i = 0; i < deals.length; i++) {
      const d = deals[i];
      if (d.deal_key !== undefined) {
        if (typeof d.deal_key !== "string" || d.deal_key.trim() === "") {
          return new Response(
            JSON.stringify({ error: `deals[${i}].deal_key must be a non-empty string` }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        if (typeof d.notes_hash !== "string" || d.notes_hash.trim() === "") {
          return new Response(
            JSON.stringify({ error: `deals[${i}].notes_hash must be a non-empty string` }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        if (typeof d.notes_canonical === "string" && d.notes_canonical.length > MAX_NOTES_CANONICAL_LENGTH) {
          return new Response(
            JSON.stringify({ error: `deals[${i}].notes_canonical exceeds ${MAX_NOTES_CANONICAL_LENGTH} character limit` }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }
    }

    // Detect payload format
    const isNewFormat = deals[0]?.deal_key !== undefined;

    if (!isNewFormat) {
      // ==================== LEGACY PATH ====================
      const legacyDeals = deals as LegacyDeal[];
      const dealsList = legacyDeals
        .map(
          (d, i) =>
            `Deal ${i + 1}: "${d.dealName}"\nNotes:\n${d.notes.map((n: string) => `- ${n}`).join("\n")}`
        )
        .join("\n\n");

      const indexedSummaries = await callClaude(apiKey, dealsList, legacyDeals.length);

      // Map numeric indices back to deal names for legacy response format
      const summaries: Record<string, string> = {};
      for (let i = 0; i < legacyDeals.length; i++) {
        const summary = indexedSummaries[String(i + 1)];
        if (summary) {
          summaries[legacyDeals[i].dealName] = summary;
        }
      }

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

      const newSummaries = await callClaude(apiKey, dealsList, misses.length);

      // 4. Store new summaries in cache and add to results
      const rowsToInsert: { deal_key: string; notes_hash: string; model: string; summary: string }[] = [];

      for (let i = 0; i < misses.length; i++) {
        const deal = misses[i];
        const summary = newSummaries[String(i + 1)] || "";
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
