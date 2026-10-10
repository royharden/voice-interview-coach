import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// Service-role client for the daily cap counter. Only service_role can
// call increment_usage (EXECUTE revoked from PUBLIC, anon, authenticated).
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const adminClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const TTS_CAP = 200;

async function checkDailyCap(): Promise<boolean> {
  try {
    const { data, error } = await adminClient.rpc("increment_usage", {
      p_fn: "tts",
      p_cap: TTS_CAP,
    });
    if (error) {
      console.error("increment_usage error:", error.message);
      return false;
    }
    return data === true;
  } catch (err) {
    console.error("increment_usage failed:", err);
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { text } = (await req.json()) as { text?: string };
    const input = (text ?? "").trim();
    if (!input) {
      return new Response(JSON.stringify({ error: "text is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "OPENAI_API_KEY is not configured" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const allowed = await checkDailyCap();
    if (!allowed) {
      return new Response(
        JSON.stringify({ error: "daily_cap", message: "Daily TTS call cap reached." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const baseUrl = Deno.env.get("OPENAI_BASE_URL") || "https://api.openai.com/v1";
    const model = Deno.env.get("OPENAI_TTS_MODEL") || "gpt-4o-mini-tts";
    const voice = Deno.env.get("OPENAI_TTS_VOICE") || "alloy";

    const res = await fetch(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, voice, input: input.slice(0, 4000), response_format: "mp3" }),
    });

    if (!res.ok) {
      const text = await res.text();
      return new Response(JSON.stringify({ error: `TTS HTTP ${res.status}: ${text.slice(0, 200)}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(res.body, {
      headers: {
        ...corsHeaders,
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
