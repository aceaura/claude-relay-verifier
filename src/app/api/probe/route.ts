import { NextRequest, NextResponse } from "next/server";
import { sendMessages, type Provider } from "@/lib/send";

export const runtime = "nodejs";
export const maxDuration = 300;

interface ProbeRequestBody {
  provider?: Provider;
  baseUrl?: string;
  apiKey?: string;
  region?: string;
  bedrockApiKey?: string;
  model?: string;
  prompt?: string;
  maxTokens?: number;
  thinking?: boolean;
  display?: "summarized" | "omitted";
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

const DEFAULT_PROMPT =
  "A rope hangs over a frictionless pulley, with a 3kg mass on one side and a 5kg mass on the other. Compute the acceleration of the system and the tension in the rope. Show your reasoning step by step, then give the final numeric answers.";

export async function POST(req: NextRequest) {
  let body: ProbeRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const provider: Provider = body.provider ?? "anthropic";
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

  try {
    const { httpStatus, text, latencyMs } = await sendMessages({
      provider,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      region: body.region,
      bedrockApiKey: body.bedrockApiKey,
      payload,
    });

    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON */
    }

    if (httpStatus < 200 || httpStatus >= 300) {
      return NextResponse.json({
        ok: false,
        httpStatus,
        latencyMs,
        error:
          (json as { error?: { message?: string }; message?: string } | null)?.error?.message ??
          (json as { message?: string } | null)?.message ??
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
      httpStatus,
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
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
