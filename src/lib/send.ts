import { SignatureV4 } from "@aws-sdk/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";

export type Provider = "anthropic" | "bedrock";

export interface SendParams {
  provider: Provider;
  /** anthropic: https://api.anthropic.com (or relay). bedrock: leave empty. */
  baseUrl?: string;
  /** anthropic key (or relay key) */
  apiKey?: string;
  /** bedrock */
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
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

function bedrockHost(region: string): string {
  return `bedrock-mantle.${region}.api.aws`;
}

/** Build the target URL + headers for the given provider. */
async function buildRequest(p: SendParams): Promise<{ url: string; headers: Record<string, string> }> {
  const body = JSON.stringify(p.payload);

  if (p.provider === "bedrock") {
    const region = (p.region ?? "").trim();
    if (!region) throw new Error("Bedrock provider requires a region (e.g. us-east-1)");
    if (!p.accessKeyId || !p.secretAccessKey) {
      throw new Error("Bedrock provider requires accessKeyId and secretAccessKey");
    }
    const host = bedrockHost(region);
    const url = `https://${host}/anthropic/v1/messages`;

    const signer = new SignatureV4({
      service: "bedrock-mantle",
      region,
      credentials: {
        accessKeyId: p.accessKeyId,
        secretAccessKey: p.secretAccessKey,
        ...(p.sessionToken ? { sessionToken: p.sessionToken } : {}),
      },
      sha256: Sha256,
    });

    const req = new HttpRequest({
      method: "POST",
      protocol: "https:",
      hostname: host,
      path: "/anthropic/v1/messages",
      headers: {
        "content-type": "application/json",
        host,
      },
      body,
    });
    const signed = await signer.sign(req);
    return { url, headers: signed.headers as Record<string, string> };
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
  const { url, headers } = await buildRequest(p);
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
