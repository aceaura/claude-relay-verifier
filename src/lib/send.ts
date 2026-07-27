export type Provider = "anthropic" | "bedrock";

export interface SendParams {
  provider: Provider;
  /** anthropic: https://api.anthropic.com (or relay). bedrock: leave empty. */
  baseUrl?: string;
  /** anthropic key (or relay key) */
  apiKey?: string;
  /** bedrock */
  region?: string;
  /** Bedrock API key (long-term `bedrock-api-key-...` or 12h temporary). Sent as Bearer. */
  bedrockApiKey?: string;
  /** request body (Messages API shape) */
  payload: Record<string, unknown>;
}

export interface SendResult {
  httpStatus: number;
  text: string;
  latencyMs: number;
}

function normalizeBase(raw: string): string {
  let u = raw.trim().replace(/\/+$/, "");
  if (u.endsWith("/v1")) u = u.slice(0, -3);
  return u;
}

function buildRequest(p: SendParams): { url: string; headers: Record<string, string> } {
  if (p.provider === "bedrock") {
    const region = (p.region ?? "").trim();
    if (!region) throw new Error("Bedrock provider requires a region (e.g. us-east-1)");
    if (!p.bedrockApiKey) throw new Error("Bedrock provider requires a Bedrock API key");
    const url = `https://bedrock-mantle.${region}.api.aws/anthropic/v1/messages`;
    return {
      url,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${p.bedrockApiKey}`,
      },
    };
  }

  // anthropic / relay
  if (!p.baseUrl) throw new Error("anthropic provider requires baseUrl");
  if (!p.apiKey) throw new Error("anthropic provider requires apiKey");
  const url = `${normalizeBase(p.baseUrl)}/v1/messages`;
  return {
    url,
    headers: {
      "content-type": "application/json",
      "x-api-key": p.apiKey,
      "anthropic-version": "2023-06-01",
    },
  };
}

export async function sendMessages(p: SendParams, timeoutMs = 240_000): Promise<SendResult> {
  const { url, headers } = buildRequest(p);
  const started = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(p.payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { httpStatus: res.status, text, latencyMs: Date.now() - started };
}
