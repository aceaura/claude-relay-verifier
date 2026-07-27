import { NextRequest, NextResponse } from "next/server";
import { sendMessages, type Provider } from "@/lib/send";

export const runtime = "nodejs";
export const maxDuration = 300;

interface SideConfig {
  provider: Provider;
  baseUrl?: string;
  apiKey?: string;
  region?: string;
  bedrockApiKey?: string;
}

interface SampleRequestBody {
  n?: number;
  model?: string;
  prompt?: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  proxyUrl?: string;
  trusted: SideConfig;
  relay: SideConfig;
}

const DEFAULT_PROMPT =
  "A rope hangs over a frictionless pulley, with a 3kg mass on one side and a 5kg mass on the other. Compute the acceleration of the system and the tension in the rope. Show your reasoning step by step, then give the final numeric answers.";

interface SampleOut {
  ok: boolean;
  httpStatus?: number;
  latencyMs?: number;
  outputTokens?: number | null;
  thinkingTokens?: number | null;
  signatureCount?: number;
  error?: string;
}

async function oneSample(
  side: SideConfig,
  payload: Record<string, unknown>,
  proxyUrl?: string,
): Promise<SampleOut> {
  try {
    const { httpStatus, text, latencyMs } = await sendMessages(
      {
        provider: side.provider,
        baseUrl: side.baseUrl,
        apiKey: side.apiKey,
        region: side.region,
        bedrockApiKey: side.bedrockApiKey,
        proxyUrl,
        payload,
      },
      180_000,
    );
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    if (httpStatus < 200 || httpStatus >= 300) {
      return {
        ok: false,
        httpStatus,
        latencyMs,
        error:
          (json as { error?: { message?: string }; message?: string } | null)?.error?.message ??
          (json as { message?: string } | null)?.message ??
          text.slice(0, 300),
      };
    }
    const msg = json as {
      content?: Array<Record<string, unknown>>;
      usage?: Record<string, unknown> & { output_tokens_details?: { thinking_tokens?: number } };
    };
    const thinkingBlocks = (msg.content ?? []).filter((b) => b.type === "thinking");
    const signatureCount = thinkingBlocks.filter(
      (b) => typeof b.signature === "string" && b.signature.length > 0,
    ).length;
    return {
      ok: true,
      httpStatus,
      latencyMs,
      outputTokens: (msg.usage?.output_tokens as number) ?? null,
      thinkingTokens: msg.usage?.output_tokens_details?.thinking_tokens ?? null,
      signatureCount,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export async function POST(req: NextRequest) {
  let body: SampleRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const n = Math.min(Math.max(body.n ?? 5, 1), 10);
  const model = body.model?.trim() || "claude-opus-5";
  const prompt = body.prompt?.trim() || DEFAULT_PROMPT;
  const maxTokens = Math.min(Math.max(body.maxTokens ?? 8000, 512), 32000);
  const effort = body.effort ?? "max";

  if (!body.trusted || !body.relay) {
    return NextResponse.json({ ok: false, error: "trusted and relay configs are required" }, { status: 400 });
  }

  const payload: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort },
    messages: [{ role: "user", content: prompt }],
  };

  const trustedSamples: SampleOut[] = [];
  const relaySamples: SampleOut[] = [];
  for (let i = 0; i < n; i++) {
    // sequential to avoid rate-limit spikes; small, so fine
    trustedSamples.push(await oneSample(body.trusted, payload, body.proxyUrl));
    relaySamples.push(await oneSample(body.relay, payload, body.proxyUrl));
  }

  const okOut = (s: SampleOut[]) => s.filter((x) => x.ok && x.outputTokens != null).map((x) => x.outputTokens as number);
  const okThink = (s: SampleOut[]) => s.filter((x) => x.ok && x.thinkingTokens != null).map((x) => x.thinkingTokens as number);

  const tOut = okOut(trustedSamples);
  const rOut = okOut(relaySamples);
  const tMed = median(tOut);
  const rMed = median(rOut);
  const ratio = tMed && rMed != null && tMed > 0 ? rMed / tMed : null;

  const tSigCount = trustedSamples.filter((s) => (s.signatureCount ?? 0) > 0).length;
  const rSigCount = relaySamples.filter((s) => (s.signatureCount ?? 0) > 0).length;

  // effort-watering verdict: relay's median output meaningfully below trusted
  let verdict: "likely_watered" | "consistent" | "insufficient_data" = "insufficient_data";
  if (tOut.length >= 2 && rOut.length >= 2 && ratio != null) {
    verdict = ratio < 0.7 ? "likely_watered" : "consistent";
  }

  return NextResponse.json({
    ok: true,
    n,
    trusted: {
      samples: trustedSamples,
      outputTokens: tOut,
      thinkingTokens: okThink(trustedSamples),
      medianOutput: tMed,
      signedSamples: tSigCount,
    },
    relay: {
      samples: relaySamples,
      outputTokens: rOut,
      thinkingTokens: okThink(relaySamples),
      medianOutput: rMed,
      signedSamples: rSigCount,
    },
    ratio,
    verdict,
  });
}
