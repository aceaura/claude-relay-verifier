"use client";

import { useEffect, useMemo, useState } from "react";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
type Provider = "anthropic" | "bedrock";

interface ProbeResult {
  ok: boolean;
  httpStatus?: number;
  latencyMs?: number;
  error?: string;
  messageId?: string | null;
  model?: string | null;
  stopReason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    [k: string]: unknown;
  } | null;
  signatureCount?: number;
  signatures?: string[];
  thinkingBlocks?: Array<Record<string, unknown>>;
  thinkingTextLen?: number;
  replyPreview?: string;
  contentTypes?: string[];
}

interface ReplayResult {
  ok: boolean;
  verdict?: "accepted" | "signature_rejected" | "other_error" | "network_error";
  httpStatus?: number;
  latencyMs?: number;
  errorType?: string | null;
  error?: string | null;
  model?: string | null;
}

interface TrustedState {
  provider: Provider;
  baseUrl: string; // anthropic only
  apiKey: string; // anthropic only
  region: string; // bedrock
  bedrockApiKey: string; // bedrock
  result: ProbeResult | null;
  loading: boolean;
}

interface RelayState {
  baseUrl: string;
  apiKey: string;
  result: ProbeResult | null;
  loading: boolean;
}

const DEFAULT_PROMPT =
  "A rope hangs over a frictionless pulley, with a 3kg mass on one side and a 5kg mass on the other. Compute the acceleration of the system and the tension in the rope. Show your reasoning step by step, then give the final numeric answers.";

function shortSig(s: string): string {
  if (s.length <= 28) return s;
  return `${s.slice(0, 18)}…${s.slice(-8)} (${s.length} chars)`;
}

function Badge({ tone, children }: { tone: "green" | "red" | "amber" | "gray"; children: React.ReactNode }) {
  const cls =
    tone === "green"
      ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
      : tone === "red"
        ? "bg-red-500/15 text-red-400 border-red-500/30"
        : tone === "amber"
          ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
          : "bg-zinc-500/15 text-zinc-400 border-zinc-500/30";
  return (
    <span className={`inline-block rounded-md border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {children}
    </span>
  );
}

const inputCls =
  "w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-zinc-500";

function ResultPanel({ title, result }: { title: string; result: ProbeResult | null }) {
  if (!result) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-500">
        {title}: not run yet
      </div>
    );
  }
  if (!result.ok) {
    return (
      <div className="rounded-xl border border-red-900/50 bg-red-950/30 p-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="font-semibold text-zinc-100">{title}</span>
          <Badge tone="red">failed {result.httpStatus ?? ""}</Badge>
          {result.latencyMs != null && <Badge tone="gray">{result.latencyMs} ms</Badge>}
        </div>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs text-red-300">
          {result.error}
        </pre>
      </div>
    );
  }
  const u = result.usage ?? {};
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-semibold text-zinc-100">{title}</span>
        <Badge tone="green">HTTP {result.httpStatus}</Badge>
        {result.latencyMs != null && <Badge tone="gray">{(result.latencyMs / 1000).toFixed(1)} s</Badge>}
        {result.signatureCount != null && result.signatureCount > 0 ? (
          <Badge tone="green">{result.signatureCount} signature(s)</Badge>
        ) : (
          <Badge tone="amber">no signature</Badge>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm md:grid-cols-3">
        <div><dt className="text-zinc-500">model (server-reported)</dt><dd className="font-mono text-zinc-200">{result.model ?? "—"}</dd></div>
        <div><dt className="text-zinc-500">stop_reason</dt><dd className="font-mono text-zinc-200">{result.stopReason ?? "—"}</dd></div>
        <div><dt className="text-zinc-500">message id</dt><dd className="font-mono text-xs text-zinc-400">{result.messageId ?? "—"}</dd></div>
        <div><dt className="text-zinc-500">output tokens</dt><dd className="font-mono text-zinc-200">{u.output_tokens ?? "—"}</dd></div>
        <div><dt className="text-zinc-500">input tokens</dt><dd className="font-mono text-zinc-200">{u.input_tokens ?? "—"}</dd></div>
        <div><dt className="text-zinc-500">thinking chars</dt><dd className="font-mono text-zinc-200">{result.thinkingTextLen ?? 0}</dd></div>
      </dl>
      {result.signatures && result.signatures.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs text-zinc-500">signature(s)</div>
          <div className="space-y-1">
            {result.signatures.map((s, i) => (
              <div key={i} className="rounded bg-zinc-950 px-2 py-1 font-mono text-xs break-all text-zinc-400">
                {shortSig(s)}
              </div>
            ))}
          </div>
        </div>
      )}
      {result.replyPreview && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">reply preview</summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-950 p-2 text-xs text-zinc-400">
            {result.replyPreview}
          </pre>
        </details>
      )}
    </div>
  );
}

export default function Home() {
  const [trusted, setTrusted] = useState<TrustedState>({
    provider: "bedrock",
    baseUrl: "https://api.anthropic.com",
    apiKey: "",
    region: "us-east-1",
    bedrockApiKey: "",
    result: null,
    loading: false,
  });
  const [relay, setRelay] = useState<RelayState>({
    baseUrl: "",
    apiKey: "",
    result: null,
    loading: false,
  });
  const [model, setModel] = useState("claude-opus-5");
  const [effort, setEffort] = useState<Effort>("max");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [maxTokens, setMaxTokens] = useState(16000);
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const [saveKeys, setSaveKeys] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem("crv-keys-v2");
    if (saved) {
      try {
        const k = JSON.parse(saved) as Partial<TrustedState> & { relayKey?: string; relayUrl?: string };
        setTrusted((s) => ({
          ...s,
          provider: (k.provider as Provider) ?? s.provider,
          apiKey: k.apiKey ?? "",
          baseUrl: k.baseUrl ?? s.baseUrl,
          region: k.region ?? s.region,
          bedrockApiKey: k.bedrockApiKey ?? "",
        }));
        setRelay((s) => ({ ...s, apiKey: k.relayKey ?? "", baseUrl: k.relayUrl ?? "" }));
        setSaveKeys(true);
      } catch { /* ignore */ }
    }
  }, []);

  const trustedReady =
    trusted.provider === "anthropic"
      ? !!trusted.apiKey
      : !!(trusted.region && trusted.bedrockApiKey);

  async function runProbe(which: "trusted" | "relay") {
    const setT = which === "trusted" ? setTrusted : null;
    const setR = which === "relay" ? setRelay : null;
    const ep = which === "trusted" ? trusted : relay;
    const setLoading = (v: boolean) => {
      if (setT) setT((s) => ({ ...s, loading: v, ...(v ? { result: null } : {}) }));
      if (setR) setR((s) => ({ ...s, loading: v, ...(v ? { result: null } : {}) }));
    };
    setLoading(true);
    try {
      const body: Record<string, unknown> = {
        model,
        prompt,
        maxTokens,
        thinking: true,
        display: "summarized",
        effort,
      };
      if (which === "trusted") {
        body.provider = trusted.provider;
        if (trusted.provider === "anthropic") {
          body.baseUrl = trusted.baseUrl;
          body.apiKey = trusted.apiKey;
        } else {
          body.region = trusted.region;
          body.bedrockApiKey = trusted.bedrockApiKey;
        }
      } else {
        body.provider = "anthropic";
        body.baseUrl = ep.baseUrl;
        body.apiKey = ep.apiKey;
      }
      const res = await fetch("/api/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as ProbeResult;
      if (setT) setT((s) => ({ ...s, loading: false, result: json }));
      if (setR) setR((s) => ({ ...s, loading: false, result: json }));
    } catch (err) {
      const fail: ProbeResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
      if (setT) setT((s) => ({ ...s, loading: false, result: fail }));
      if (setR) setR((s) => ({ ...s, loading: false, result: fail }));
    }
  }

  function runBoth() {
    if (saveKeys) {
      window.localStorage.setItem(
        "crv-keys-v2",
        JSON.stringify({
          provider: trusted.provider,
          apiKey: trusted.apiKey,
          baseUrl: trusted.baseUrl,
          region: trusted.region,
          bedrockApiKey: trusted.bedrockApiKey,
          relayKey: relay.apiKey,
          relayUrl: relay.baseUrl,
        }),
      );
    }
    setReplayResult(null);
    if (trustedReady) runProbe("trusted");
    if (relay.apiKey && relay.baseUrl) runProbe("relay");
  }

  const replaySource = relay.result?.signatureCount ? relay.result : trusted.result;

  async function runReplay() {
    if (!replaySource?.thinkingBlocks?.length) return;
    setReplayLoading(true);
    setReplayResult(null);
    try {
      const body: Record<string, unknown> = {
        provider: trusted.provider,
        model,
        thinkingBlocks: replaySource.thinkingBlocks,
      };
      if (trusted.provider === "anthropic") {
        body.apiKey = trusted.apiKey;
      } else {
        body.region = trusted.region;
        body.bedrockApiKey = trusted.bedrockApiKey;
      }
      const res = await fetch("/api/replay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as ReplayResult;
      setReplayResult(json);
    } catch (err) {
      setReplayResult({ ok: false, verdict: "network_error", error: err instanceof Error ? err.message : String(err) });
    } finally {
      setReplayLoading(false);
    }
  }

  const cmp = useMemo(() => {
    const a = trusted.result, b = relay.result;
    if (!a?.ok || !b?.ok) return null;
    const outA = a.usage?.output_tokens ?? 0;
    const outB = b.usage?.output_tokens ?? 0;
    const ratio = outA > 0 ? outB / outA : 0;
    const sameModelField = !!a.model && !!b.model && a.model === b.model;
    return { outA, outB, ratio, sameModelField };
  }, [trusted.result, relay.result]);

  const canRun = trustedReady && !!relay.apiKey && !!relay.baseUrl && !trusted.loading && !relay.loading;

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
      <header className="mb-8">
        <h1 className="text-2xl font-bold text-zinc-100">Claude Relay Verifier</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Compare an Anthropic-compatible relay against a trusted baseline — official Anthropic API{" "}
          <em>or</em> AWS Bedrock (Mantle). Checks server-reported model, thinking-block signatures,
          and thinking effort (output tokens at <code className="font-mono">effort=max</code>).
          Credentials are sent only to this local server and used for the API calls you trigger.
        </p>
      </header>

      <section className="mb-6 grid gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 md:grid-cols-3">
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">model</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} className={inputCls} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">effort (thinking on)</span>
          <select
            value={effort}
            onChange={(e) => setEffort(e.target.value as Effort)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          >
            {["low", "medium", "high", "xhigh", "max"].map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">max_tokens</span>
          <input
            type="number"
            value={maxTokens}
            min={256}
            max={64000}
            onChange={(e) => setMaxTokens(Number(e.target.value))}
            className={inputCls}
          />
        </label>
        <label className="block text-sm md:col-span-3">
          <span className="mb-1 block text-zinc-400">prompt (same for both sides)</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          />
        </label>
      </section>

      <section className="mb-6 grid gap-4 md:grid-cols-2">
        {/* Trusted baseline */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold text-zinc-100">① Trusted baseline</h2>
            <Badge tone="gray">reference</Badge>
          </div>
          <div className="mb-3 grid grid-cols-2 gap-2">
            {(["bedrock", "anthropic"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setTrusted((s) => ({ ...s, provider: p }))}
                className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${
                  trusted.provider === p
                    ? "border-zinc-400 bg-zinc-800 text-zinc-100"
                    : "border-zinc-700 bg-zinc-950 text-zinc-400 hover:border-zinc-500"
                }`}
              >
                {p === "bedrock" ? "AWS Bedrock" : "Anthropic API"}
              </button>
            ))}
          </div>

          {trusted.provider === "anthropic" ? (
            <>
              <label className="mb-3 block text-sm">
                <span className="mb-1 block text-zinc-400">base URL</span>
                <input
                  value={trusted.baseUrl}
                  onChange={(e) => setTrusted((s) => ({ ...s, baseUrl: e.target.value }))}
                  className={inputCls}
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-zinc-400">API key</span>
                <input
                  type="password"
                  value={trusted.apiKey}
                  onChange={(e) => setTrusted((s) => ({ ...s, apiKey: e.target.value }))}
                  placeholder="sk-ant-..."
                  className={inputCls}
                />
              </label>
            </>
          ) : (
            <>
              <label className="mb-3 block text-sm">
                <span className="mb-1 block text-zinc-400">AWS region</span>
                <input
                  value={trusted.region}
                  onChange={(e) => setTrusted((s) => ({ ...s, region: e.target.value }))}
                  placeholder="us-east-1"
                  className={inputCls}
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-zinc-400">Bedrock API key</span>
                <input
                  type="password"
                  value={trusted.bedrockApiKey}
                  onChange={(e) => setTrusted((s) => ({ ...s, bedrockApiKey: e.target.value }))}
                  placeholder="bedrock-api-key-..."
                  className={inputCls}
                />
              </label>
              <p className="mt-3 text-xs text-zinc-500">
                Uses the Bedrock API key (long-term or 12-hour temporary) via{" "}
                <code className="font-mono">Authorization: Bearer</code> — no SigV4 needed.
              </p>
            </>
          )}
        </div>

        {/* Relay */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold text-zinc-100">② Relay under test</h2>
            <Badge tone="gray">suspect</Badge>
          </div>
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-zinc-400">base URL</span>
            <input
              value={relay.baseUrl}
              onChange={(e) => setRelay((s) => ({ ...s, baseUrl: e.target.value }))}
              placeholder="https://qcode.cc or your relay base"
              className={inputCls}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-zinc-400">API key</span>
            <input
              type="password"
              value={relay.apiKey}
              onChange={(e) => setRelay((s) => ({ ...s, apiKey: e.target.value }))}
              placeholder="relay key"
              className={inputCls}
            />
          </label>
          <p className="mt-3 text-xs text-zinc-500">
            Relay must expose the Anthropic Messages API shape (<code className="font-mono">/v1/messages</code>).
          </p>
        </div>
      </section>

      <div className="mb-8 flex flex-wrap items-center gap-3">
        <button
          onClick={runBoth}
          disabled={!canRun}
          className="rounded-xl bg-zinc-100 px-5 py-2.5 text-sm font-semibold text-zinc-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {trusted.loading || relay.loading ? "Running…" : "▶ Run comparison"}
        </button>
        <label className="flex items-center gap-2 text-sm text-zinc-400">
          <input
            type="checkbox"
            checked={saveKeys}
            onChange={(e) => setSaveKeys(e.target.checked)}
            className="accent-zinc-300"
          />
          remember keys in this browser (localStorage)
        </label>
      </div>

      <section className="mb-8 grid gap-4 md:grid-cols-2">
        <ResultPanel title={trusted.provider === "bedrock" ? "Bedrock (trusted)" : "Official (trusted)"} result={trusted.result} />
        <ResultPanel title="Relay" result={relay.result} />
      </section>

      {cmp && (
        <section className="mb-8 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
          <h2 className="mb-3 font-semibold text-zinc-100">Comparison</h2>
          <div className="grid gap-3 text-sm md:grid-cols-3">
            <div className="rounded-xl bg-zinc-950 p-3">
              <div className="mb-1 text-zinc-500">server-reported model</div>
              {cmp.sameModelField ? (
                <Badge tone="green">match: {trusted.result!.model}</Badge>
              ) : (
                <Badge tone="amber">
                  {trusted.result!.model} vs {relay.result!.model}
                </Badge>
              )}
              <p className="mt-1 text-xs text-zinc-500">self-declared — necessary but not sufficient</p>
            </div>
            <div className="rounded-xl bg-zinc-950 p-3">
              <div className="mb-1 text-zinc-500">signatures present</div>
              {(trusted.result!.signatureCount ?? 0) > 0 && (relay.result!.signatureCount ?? 0) > 0 ? (
                <Badge tone="green">both sides</Badge>
              ) : (relay.result!.signatureCount ?? 0) === 0 ? (
                <Badge tone="red">relay has none</Badge>
              ) : (
                <Badge tone="amber">baseline has none (check config)</Badge>
              )}
              <p className="mt-1 text-xs text-zinc-500">missing signature = thinking wasn&apos;t Anthropic-issued</p>
            </div>
            <div className="rounded-xl bg-zinc-950 p-3">
              <div className="mb-1 text-zinc-500">output tokens (effort gauge)</div>
              <Badge tone={cmp.ratio > 0.6 && cmp.ratio < 1.6 ? "green" : "amber"}>
                relay/baseline ≈ {cmp.ratio.toFixed(2)}
              </Badge>
              <p className="mt-1 text-xs text-zinc-500">
                {cmp.outA} vs {cmp.outB} — big shortfall hints at effort watering
              </p>
            </div>
          </div>
        </section>
      )}

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="mb-2 font-semibold text-zinc-100">Signature replay (the hard test)</h2>
        <p className="mb-3 text-sm text-zinc-400">
          Takes the captured thinking block (from the relay if it produced one, else the baseline)
          and replays it <em>unchanged</em> to your <strong>trusted</strong> endpoint (
          {trusted.provider === "bedrock" ? "AWS Bedrock" : "official Anthropic API"}).
          Anthropic&apos;s servers cryptographically validate the signature: accepted = genuinely
          issued for this model; rejected = forged, tampered, or from another provider.
        </p>
        <button
          onClick={runReplay}
          disabled={replayLoading || !trustedReady || !replaySource?.signatureCount}
          className="rounded-xl border border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {replayLoading
            ? "Replaying…"
            : replaySource === relay.result
              ? `⟲ Replay relay's thinking block to ${trusted.provider === "bedrock" ? "Bedrock" : "official API"}`
              : `⟲ Replay baseline's own thinking block (sanity check)`}
        </button>
        {!replaySource?.signatureCount && (trusted.result || relay.result) && (
          <p className="mt-2 text-xs text-amber-400">No signature captured yet — run the comparison first.</p>
        )}
        {replayResult && (
          <div className="mt-4 rounded-xl bg-zinc-950 p-3 text-sm">
            {replayResult.verdict === "accepted" ? (
              <Badge tone="green">✔ trusted endpoint accepted the signature</Badge>
            ) : replayResult.verdict === "signature_rejected" ? (
              <Badge tone="red">✘ trusted endpoint rejected it ({replayResult.httpStatus})</Badge>
            ) : (
              <Badge tone="amber">inconclusive ({replayResult.httpStatus ?? "network"})</Badge>
            )}
            {replayResult.error && (
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs text-zinc-400">
                {replayResult.error}
              </pre>
            )}
            {replayResult.verdict === "accepted" && replaySource === relay.result && (
              <p className="mt-2 text-xs text-emerald-400">
                The relay&apos;s thinking block is genuinely Anthropic-issued for {model}. Model identity
                confirmed. (Effort level is a separate axis — check the token gauge above.)
              </p>
            )}
            {replayResult.verdict === "signature_rejected" && (
              <p className="mt-2 text-xs text-red-400">
                Possible causes: the relay swapped in another model and forged thinking blocks; OR the
                relay re-wraps/re-encodes responses (breaking signatures without swapping the model);
                OR the block was modified in transit. A relay that passes responses through untouched
                should produce verifiable signatures.
              </p>
            )}
          </div>
        )}
      </section>

      <footer className="mt-8 text-xs text-zinc-600">
        Note: signature validates <em>model identity</em>, not the effort tier. A relay could still
        serve real claude-opus-5 while silently lowering <code className="font-mono">effort</code> —
        that&apos;s what the token gauge is for. Credentials are never logged server-side.
      </footer>
    </main>
  );
}
