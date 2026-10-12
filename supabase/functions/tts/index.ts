import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const FN_NAME = "tts";

// Request limits, enforced before the paid call.
const MAX_BODY_BYTES = 8 * 1024;
const MAX_TEXT_CHARS = 4000;
const OPENAI_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Daily cap. Every paid TTS fetch is counted through increment_usage, which
// only service_role can execute.
// ---------------------------------------------------------------------------

const DEFAULT_DAILY_CAP = 200;

function dailyCap(): number {
  const raw = (Deno.env.get("DAILY_CALL_LIMIT") ?? "").trim();
  if (!/^\d{1,10}$/.test(raw)) return DEFAULT_DAILY_CAP;
  const n = Number(raw);
  return n <= 2_147_483_647 ? n : DEFAULT_DAILY_CAP;
}

let adminClient: SupabaseClient | null = null;

// Service-role client built only from env; null if either var is missing.
function getAdminClient(): SupabaseClient | null {
  if (adminClient) return adminClient;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  adminClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return adminClient;
}

type CountResult = "ok" | "capped" | "error";

// Fails closed: only a literal `true` from the RPC allows the call.
async function countPaidCall(admin: SupabaseClient): Promise<CountResult> {
  const cap = dailyCap();
  if (cap <= 0) return "capped";
  try {
    const { data, error } = await admin.rpc("increment_usage", { p_fn: FN_NAME, p_cap: cap });
    if (error) {
      console.error("increment_usage error:", error.message);
      return "error";
    }
    return data === true ? "ok" : "capped";
  } catch (err) {
    console.error("increment_usage failed:", err);
    return "error";
  }
}

// ---------------------------------------------------------------------------
// Body parsing with a hard byte limit
// ---------------------------------------------------------------------------

type BodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response };

async function readJsonBody(req: Request, maxBytes: number): Promise<BodyResult> {
  const tooLarge = (): BodyResult => ({ ok: false, response: json({ error: "payload_too_large" }, 413) });
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (req.body) {
    const reader = req.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return tooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, response: json({ error: "invalid_json" }, 400) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, response: json({ error: "invalid_body" }, 400) };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const admin = getAdminClient();
  if (!admin) {
    console.error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set");
    return json({ error: "server_not_configured" }, 503);
  }

  try {
    const parsed = await readJsonBody(req, MAX_BODY_BYTES);
    if (!parsed.ok) return parsed.response;

    const text = parsed.body.text ?? "";
    if (typeof text !== "string") {
      return json({ error: "invalid_field_type" }, 400);
    }
    const input = text.trim();
    if (!input) {
      return json({ error: "text is required" }, 400);
    }
    if (input.length > MAX_TEXT_CHARS) {
      return json({ error: "text_too_long" }, 422);
    }

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      return json({ error: "not_configured" }, 503);
    }

    // Model, voice and base URL come only from env, never from the request.
    const baseUrl = Deno.env.get("OPENAI_BASE_URL") || "https://api.openai.com/v1";
    const model = Deno.env.get("OPENAI_TTS_MODEL") || "gpt-4o-mini-tts";
    const voice = Deno.env.get("OPENAI_TTS_VOICE") || "alloy";

    // Count right before the paid fetch. No retries.
    const counted = await countPaidCall(admin);
    if (counted === "capped") {
      return json({ error: "daily_limit", message: "Daily TTS call cap reached." }, 429);
    }
    if (counted === "error") {
      return json({ error: "usage_counter_unavailable" }, 503);
    }

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/audio/speech`, {
        method: "POST",
        signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, voice, input, response_format: "mp3" }),
      });
    } catch (err) {
      console.error("TTS request failed:", err);
      return json({ error: "upstream_error" }, 502);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`TTS HTTP ${res.status}:`, detail.slice(0, 500));
      return json({ error: "upstream_error" }, 502);
    }

    return new Response(res.body, {
      headers: {
        ...corsHeaders,
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("tts failed:", err);
    return json({ error: "internal_error" }, 500);
  }
});
