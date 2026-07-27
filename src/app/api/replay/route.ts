import { NextRequest, NextResponse } from "next/server";
import { sendMessages, type Provider } from "@/lib/send";

export const runtime = "nodejs";
export const maxDuration = 300;

interface ReplayRequestBody {
  /** provider of the VERIFYING (trusted) endpoint — anthropic official or bedrock */
  provider?: Provider;
  apiKey?: string; // anthropic official key
  region?: string; // bedrock
  bedrockApiKey?: string;
  model?: string;
  thinkingBlocks: Array<Record<string, unknown>>;
}

/**
 * Signature verification by replay:
 * send a fresh turn to the TRUSTED endpoint (official Anthropic or Bedrock),
 * including the captured assistant turn with its thinking block(s) — signature
 * intact. The server validates the signature cryptographically:
 *  - accepted (2xx)             => genuinely issued by Anthropic for this model
 *  - 400 signature/thinking err => forged, modified, or from another provider
 */
export async function POST(req: NextRequest) {
  let body: ReplayRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { thinkingBlocks } = body;
  if (!Array.isArray(thinkingBlocks) || thinkingBlocks.length === 0) {
    return NextResponse.json(
      { ok: false, error: "non-empty thinkingBlocks are required" },
      { status: 400 },
    );
  }

  const provider: Provider = body.provider ?? "anthropic";
  const model = body.model?.trim() || "claude-opus-5";

  const messages = [
    {
      role: "user",
      content:
        "A rope hangs over a frictionless pulley, with a 3kg mass on one side and a 5kg mass on the other. Compute the acceleration of the system and the tension in the rope. Show your reasoning step by step, then give the final numeric answers.",
    },
    { role: "assistant", content: thinkingBlocks },
    { role: "user", content: "Reply with exactly one word: received." },
  ];

  try {
    const { httpStatus, text, latencyMs } = await sendMessages(
      {
        provider,
        baseUrl: provider === "anthropic" ? "https://api.anthropic.com" : undefined,
        apiKey: body.apiKey,
        region: body.region,
        bedrockApiKey: body.bedrockApiKey,
        payload: {
          model,
          max_tokens: 1024,
          thinking: { type: "adaptive" },
          messages,
        },
      },
      120_000,
    );

    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }

    const errMsg =
      (json as { error?: { message?: string; type?: string }; message?: string } | null)?.error
        ?.message ??
      (json as { message?: string } | null)?.message ??
      (httpStatus < 200 || httpStatus >= 300 ? text.slice(0, 2000) : null);
    const errType = (json as { error?: { type?: string } } | null)?.error?.type ?? null;

    const signatureRelated = !!errMsg && /signature|thinking|redacted|tamper|invalid.*block/i.test(errMsg);
    const ok = httpStatus >= 200 && httpStatus < 300;

    return NextResponse.json({
      ok,
      verdict: ok ? "accepted" : signatureRelated ? "signature_rejected" : "other_error",
      httpStatus,
      latencyMs,
      errorType: errType,
      error: errMsg,
      model: (json as { model?: string } | null)?.model ?? null,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      verdict: "network_error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
