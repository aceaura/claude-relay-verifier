import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

interface ReplayRequestBody {
  apiKey: string;
  model?: string;
  thinkingBlocks: Array<Record<string, unknown>>;
  /** Also replay against the relay instead of official API (for cross-checks) */
  baseUrl?: string;
}

/**
 * Signature verification by replay:
 * We send a fresh turn to the (official) Anthropic API, including the captured
 * assistant turn with its thinking block(s) — signature intact. The official
 * server validates the signature cryptographically:
 *  - Accepted (2xx)              => the thinking block was genuinely issued by Anthropic for this model
 *  - 400 signature/tamper error  => forged, modified, or issued by something else
 *
 * We deliberately send an INVALID tool-free follow-up asking for a 1-word reply
 * to keep cost near zero. The validation of the signature happens during
 * request processing — a signature failure surfaces as a 400.
 */
export async function POST(req: NextRequest) {
  let body: ReplayRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { apiKey, thinkingBlocks } = body;
  if (!apiKey || !Array.isArray(thinkingBlocks) || thinkingBlocks.length === 0) {
    return NextResponse.json(
      { ok: false, error: "apiKey and non-empty thinkingBlocks are required" },
      { status: 400 },
    );
  }

  const model = body.model?.trim() || "claude-opus-5";
  const base = (body.baseUrl?.trim() || "https://api.anthropic.com").replace(/\/+$/, "").replace(/\/v1$/, "");

  const messages = [
    {
      role: "user",
      content:
        "A rope hangs over a frictionless pulley, with a 3kg mass on one side and a 5kg mass on the other. Compute the acceleration of the system and the tension in the rope. Show your reasoning step by step, then give the final numeric answers.",
    },
    { role: "assistant", content: thinkingBlocks },
    { role: "user", content: "Reply with exactly one word: received." },
  ];

  const started = Date.now();
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        thinking: { type: "adaptive" },
        messages,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const latencyMs = Date.now() - started;
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }

    const errMsg =
      (json as { error?: { message?: string; type?: string } } | null)?.error?.message ??
      (!res.ok ? text.slice(0, 2000) : null);
    const errType = (json as { error?: { type?: string } } | null)?.error?.type ?? null;

    const signatureRelated =
      !!errMsg &&
      /signature|thinking|redacted|tamper|invalid.*block/i.test(errMsg);

    return NextResponse.json({
      ok: res.ok,
      verdict: res.ok ? "accepted" : signatureRelated ? "signature_rejected" : "other_error",
      httpStatus: res.status,
      latencyMs,
      errorType: errType,
      error: errMsg,
      model: (json as { model?: string } | null)?.model ?? null,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      verdict: "network_error",
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
