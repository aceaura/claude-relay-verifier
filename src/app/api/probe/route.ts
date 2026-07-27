import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

interface ProbeRequestBody {
  baseUrl: string;
  apiKey: string;
  model?: string;
  prompt?: string;
  maxTokens?: number;
  thinking?: boolean;
  display?: "summarized" | "omitted";
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

const DEFAULT_PROMPT =
  "A rope hangs over a frictionless pulley, with a 3kg mass on one side and a 5kg mass on the other. Compute the acceleration of the system and the tension in the rope. Show your reasoning step by step, then give the final numeric answers.";

function normalizeBaseUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, "");
  // Allow pasting with or without /v1 suffix
  if (u.endsWith("/v1")) u = u.slice(0, -3);
  return u;
}

export async function POST(req: NextRequest) {
  let body: ProbeRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { baseUrl, apiKey } = body;
  if (!baseUrl || !apiKey) {
    return NextResponse.json({ ok: false, error: "baseUrl and apiKey are required" }, { status: 400 });
  }

  const model = body.model?.trim() || "claude-opus-5";
  const prompt = body.prompt?.trim() || DEFAULT_PROMPT;
  const maxTokens = Math.min(Math.max(body.maxTokens ?? 16000, 256), 64000);
  const thinking = body.thinking !== false;
  const display = body.display ?? "summarized";
  const effort = body.effort ?? "max";

  const payload: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (thinking) {
    payload.thinking = { type: "adaptive", display };
    payload.output_config = { effort };
  }

  const url = `${normalizeBaseUrl(baseUrl)}/v1/messages`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(240_000),
    });
    const latencyMs = Date.now() - started;
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON response */
    }

    if (!res.ok) {
      return NextResponse.json({
        ok: false,
        httpStatus: res.status,
        latencyMs,
        error:
          (json as { error?: { message?: string } } | null)?.error?.message ??
          text.slice(0, 2000),
        raw: json ?? text.slice(0, 4000),
      });
    }

    const msg = json as {
      id?: string;
      model?: string;
      stop_reason?: string;
      content?: Array<Record<string, unknown>>;
      usage?: Record<string, unknown>;
    };

    const thinkingBlocks = (msg.content ?? []).filter((b) => b.type === "thinking");
    const textBlocks = (msg.content ?? []).filter((b) => b.type === "text");
    const signatures = thinkingBlocks
      .map((b) => (typeof b.signature === "string" ? b.signature : null))
      .filter((s): s is string => !!s);
    const thinkingTextLen = thinkingBlocks.reduce(
      (acc, b) => acc + (typeof b.thinking === "string" ? b.thinking.length : 0),
      0,
    );
    const replyText = textBlocks
      .map((b) => (typeof b.text === "string" ? b.text : ""))
      .join("\n");

    return NextResponse.json({
      ok: true,
      httpStatus: res.status,
      latencyMs,
      messageId: msg.id ?? null,
      model: msg.model ?? null,
      stopReason: msg.stop_reason ?? null,
      usage: msg.usage ?? null,
      signatureCount: signatures.length,
      signatures,
      thinkingBlocks,
      thinkingTextLen,
      replyPreview: replyText.slice(0, 1200),
      contentTypes: (msg.content ?? []).map((b) => b.type),
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
