import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

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

    // Build prompt with all deals
    const dealsList = deals
      .map(
        (d: { dealName: string; notes: string[] }, i: number) =>
          `Deal ${i + 1}: "${d.dealName}"\nNotes:\n${d.notes.map((n: string) => `- ${n}`).join("\n")}`
      )
      .join("\n\n");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
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
      return new Response(
        JSON.stringify({ error: "Claude API call failed", status: response.status }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const result = await response.json();
    const text = result.content?.[0]?.text || "{}";

    // Parse the JSON response from Claude
    let summaries: Record<string, string>;
    try {
      summaries = JSON.parse(text);
    } catch {
      console.error("Failed to parse Claude response as JSON:", text);
      summaries = {};
    }

    return new Response(JSON.stringify({ summaries }), {
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
