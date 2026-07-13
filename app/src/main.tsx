import {
  Activity,
  AlertTriangle,
  Check,
  CircleStop,
  Copy,
  Database,
  ExternalLink,
  FileCheck2,
  Gauge,
  Play,
  Radio,
  RotateCcw,
  ShieldCheck,
  Waves,
} from "lucide-react";
import {
  StrictMode,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";

import { publicJudgeScenario } from "../../src/replay/public-scenario";
import { StoppageRuntime } from "../../src/runtime/stoppage-runtime";

import type {
  GovernorMode,
  ProbabilityVector,
  RuntimeSnapshot,
  Selection,
} from "./types";
import { parsePublicClaim, type PublicClaim } from "./public-claim";
import "./styles.css";

const selections: Array<{ key: Selection; label: string }> = [
  { key: "HOME", label: "Home" },
  { key: "DRAW", label: "Draw" },
  { key: "AWAY", label: "Away" },
];

type ConnectionMode = "connecting" | "live" | "local" | "offline";
type ClaimStatus = "loading" | "available" | "unavailable";

function App() {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [connection, setConnection] = useState<ConnectionMode>("connecting");
  const [publicClaim, setPublicClaim] = useState<PublicClaim | null>(null);
  const [claimStatus, setClaimStatus] = useState<ClaimStatus>("loading");
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const localRuntime = useRef<StoppageRuntime | null>(null);

  useEffect(() => {
    let active = true;
    let backendReady = false;
    let unsubscribeLocal: (() => boolean) | null = null;
    let source: EventSource | null = null;

    const enableLocalJudgeMode = () => {
      if (!active || backendReady || localRuntime.current) return;
      const runtime = new StoppageRuntime(publicJudgeScenario);
      localRuntime.current = runtime;
      unsubscribeLocal = runtime.subscribe((next) => setSnapshot(next));
      setSnapshot(runtime.snapshot());
      setConnection("local");
      source?.close();
    };

    void fetch("/api/status")
      .then((response) => {
        if (!response.ok) throw new Error(`Status failed: ${response.status}`);
        return response.json() as Promise<RuntimeSnapshot>;
      })
      .then((next) => {
        if (!active) return;
        backendReady = true;
        setSnapshot(next);
      })
      .catch(enableLocalJudgeMode);

    source = new EventSource("/api/events");
    source.addEventListener("snapshot", (event) => {
      backendReady = true;
      setSnapshot(
        JSON.parse((event as MessageEvent<string>).data) as RuntimeSnapshot,
      );
      setConnection("live");
    });
    source.onerror = () => {
      if (backendReady) setConnection("offline");
      else enableLocalJudgeMode();
    };

    return () => {
      active = false;
      source?.close();
      unsubscribeLocal?.();
      localRuntime.current?.stop();
      localRuntime.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    void fetch("/api/public-claim", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Claim failed: ${response.status}`);
        return response.json() as Promise<unknown>;
      })
      .then((value) => {
        setPublicClaim(parsePublicClaim(value));
        setClaimStatus("available");
      })
      .catch((error: unknown) => {
        if ((error as Error).name !== "AbortError") {
          setClaimStatus("unavailable");
        }
      });

    return () => controller.abort();
  }, []);

  async function startReplay() {
    setActionPending(true);
    setActionError(null);
    try {
      if (localRuntime.current) {
        const run = localRuntime.current.start(4);
        setActionPending(false);
        void run.catch((error: unknown) =>
          setActionError((error as Error).message),
        );
        return;
      }
      const response = await fetch("/api/replay/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speed: 4 }),
      });
      if (!response.ok) throw new Error(`Replay failed: ${response.status}`);
      setSnapshot((await response.json()) as RuntimeSnapshot);
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setActionPending(false);
    }
  }

  async function stopReplay() {
    setActionPending(true);
    setActionError(null);
    try {
      if (localRuntime.current) {
        localRuntime.current.stop();
        setSnapshot(localRuntime.current.snapshot());
        return;
      }
      const response = await fetch("/api/replay/stop", { method: "POST" });
      if (!response.ok) throw new Error(`Stop failed: ${response.status}`);
      setSnapshot((await response.json()) as RuntimeSnapshot);
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setActionPending(false);
    }
  }

  if (!snapshot) return <LoadingState connection={connection} />;

  const isRunning = snapshot.replayStatus === "RUNNING";
  const hasRun = snapshot.timeline.length > 0;

  return (
    <div className="shell">
      <Header connection={connection} />
      <main>
        <section className="command-band" aria-labelledby="product-title">
          <div className="command-inner">
            <div className="product-copy">
              <div className="eyebrow-row">
                <span className="eyebrow">Autonomous quote control</span>
                <DataMode mode={snapshot.dataMode} />
              </div>
              <h1 id="product-title">Stoppage</h1>
              <p className="product-lede">
                Freezes, reprices, and reopens in-play markets when the match
                and the market disagree.
              </p>
              <div className="command-actions">
                <button
                  className="primary-action"
                  type="button"
                  onClick={isRunning ? stopReplay : startReplay}
                  disabled={actionPending}
                  aria-busy={actionPending}
                >
                  {isRunning ? (
                    <CircleStop size={17} />
                  ) : hasRun ? (
                    <RotateCcw size={17} />
                  ) : (
                    <Play size={17} />
                  )}
                  {isRunning
                    ? "Stop replay"
                    : hasRun
                      ? "Run again"
                      : "Run judge replay"}
                </button>
                <span className="scenario-name">{snapshot.scenarioLabel}</span>
              </div>
              {actionError ? (
                <p className="action-error" role="alert">
                  {actionError}
                </p>
              ) : null}
            </div>

            <StateCommand snapshot={snapshot} />
          </div>
        </section>

        <ApprovedEvidenceBand claim={publicClaim} status={claimStatus} />

        <div className="workspace">
          <section className="match-strip" aria-label="Current fixture">
            <div className="match-meta">
              <span>{snapshot.match.competition}</span>
              <strong>Fixture {snapshot.match.fixtureId}</strong>
            </div>
            <div className="versus">
              <strong>{snapshot.match.home}</strong>
              <span>vs</span>
              <strong>{snapshot.match.away}</strong>
            </div>
            <div className="replay-clock">
              <span>Replay clock</span>
              <strong>{formatReplayClock(snapshot.replayElapsedMs)}</strong>
            </div>
          </section>

          <section className="state-lane" aria-label="Quote lifecycle">
            {(["OPEN", "SUSPENDED", "REPRICED", "OPEN"] as const).map(
              (mode, index) => (
                <div
                  className={`state-node ${stateNodeClass(snapshot, mode, index)}`}
                  key={`${mode}-${index}`}
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{index === 3 ? "REOPENED" : mode}</strong>
                </div>
              ),
            )}
          </section>

          <section
            className="market-grid"
            aria-label="Protected and baseline books"
          >
            <MarketBook
              title="Governed book"
              subtitle="Stoppage policy applied"
              mode={snapshot.mode}
              probabilities={snapshot.currentProbability}
              governed
            />
            <MarketBook
              title="Unprotected baseline"
              subtitle="Always open · follows consensus"
              mode="OPEN"
              probabilities={snapshot.baselineProbability}
            />
          </section>

          <MetricBand snapshot={snapshot} />

          <section className="operations-grid">
            <Timeline snapshot={snapshot} />
            <ProofPanel snapshot={snapshot} />
          </section>

          <section className="systems-strip" aria-label="System health">
            <SystemStatus
              icon={<Waves size={18} />}
              label="Scores input"
              value={
                snapshot.dataMode === "SYNTHETIC"
                  ? "Synthetic replay"
                  : snapshot.streamHealth.scores
                    ? "TxLINE healthy"
                    : "TxLINE degraded"
              }
              healthy={snapshot.streamHealth.scores}
            />
            <SystemStatus
              icon={<Radio size={18} />}
              label="Odds input"
              value={
                snapshot.dataMode === "SYNTHETIC"
                  ? "Synthetic replay"
                  : snapshot.streamHealth.odds
                    ? "TxLINE healthy"
                    : "TxLINE degraded"
              }
              healthy={snapshot.streamHealth.odds}
            />
            <SystemStatus
              icon={<Database size={18} />}
              label="Policy engine"
              value="Deterministic"
              healthy
            />
            <SystemStatus
              icon={<ShieldCheck size={18} />}
              label="Network"
              value="Solana mainnet"
              healthy
            />
          </section>

          <ApprovedEvidencePanel claim={publicClaim} status={claimStatus} />
        </div>
      </main>
      <Footer snapshot={snapshot} />
    </div>
  );
}

function ApprovedEvidenceBand({
  claim,
  status,
}: {
  claim: PublicClaim | null;
  status: ClaimStatus;
}) {
  return (
    <section className="evidence-band" aria-label="Approved mainnet evidence">
      <div className="evidence-band-inner">
        <div className="evidence-band-lead">
          <span>Approved mainnet holdout</span>
          <strong>
            {status === "available"
              ? "Real TxLINE evidence, frozen policy"
              : status === "loading"
                ? "Reading approved evidence"
                : "Evidence endpoint unavailable"}
          </strong>
        </div>
        {claim ? (
          <>
            <EvidenceStat
              label="Held-out fixtures"
              value={String(claim.holdout.fixtures)}
            />
            <EvidenceStat
              label="Protected windows"
              value={String(claim.holdout.completeProtectedWindows)}
            />
            <EvidenceStat
              label="Baseline-open time"
              value={formatDuration(claim.holdout.staleQuoteSeconds)}
            />
            <a className="evidence-jump" href="#mainnet-evidence">
              Inspect evidence <FileCheck2 size={15} />
            </a>
          </>
        ) : (
          <p className="evidence-band-empty">
            No metrics are substituted when the approved claim cannot be read.
          </p>
        )}
      </div>
    </section>
  );
}

function EvidenceStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="evidence-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ApprovedEvidencePanel({
  claim,
  status,
}: {
  claim: PublicClaim | null;
  status: ClaimStatus;
}) {
  if (!claim) {
    return (
      <section className="mainnet-evidence unavailable" id="mainnet-evidence">
        <div>
          <span>Public evidence</span>
          <h2>
            {status === "loading"
              ? "Reading the approved claim"
              : "Approved claim unavailable"}
          </h2>
        </div>
        <p>
          The console does not replace unavailable mainnet evidence with demo
          values.
        </p>
      </section>
    );
  }

  return (
    <section className="mainnet-evidence" id="mainnet-evidence">
      <div className="evidence-heading">
        <div>
          <span>Approved public evidence</span>
          <h2>Frozen policy, held-out match windows</h2>
          <p>
            The replay above demonstrates the product. These aggregates come
            from {claim.holdout.fixtures} held-out TxLINE mainnet fixtures and
            are bound to the approved candidate digest below.
          </p>
        </div>
        <span className="approval-state">
          <Check size={14} /> Approved
        </span>
      </div>

      <div className="evidence-grid">
        <div className="evidence-aggregate">
          <EvidenceStat
            label="Complete protected windows"
            value={String(claim.holdout.completeProtectedWindows)}
          />
          <EvidenceStat
            label="Baseline-open time"
            value={formatDuration(claim.holdout.staleQuoteSeconds)}
          />
          <EvidenceStat
            label="Mispricing integral"
            value={`${claim.holdout.mispricingIntegral.toFixed(3)} p·s`}
          />
          <EvidenceStat
            label="Strongest lifecycle move"
            value={formatPercent(
              claim.lifecycleEvidence.maximumProbabilityMove,
            )}
          />
        </div>

        <div className="verified-lifecycle">
          <span>Verified lifecycle</span>
          <div className="lifecycle-path">
            {claim.lifecycleEvidence.decisions.map((decision, index) => (
              <div className="lifecycle-step" key={decision.receiptHash}>
                <small>{String(index + 1).padStart(2, "0")}</small>
                <strong>{decision.action}</strong>
                <span>{formatElapsed(decision.elapsedMs)}</span>
              </div>
            ))}
          </div>
          <p>{claim.dataBoundary}</p>
        </div>
      </div>

      <div className="evidence-links">
        <a
          href={claim.lifecycleEvidence.txlineValidation.explorer}
          target="_blank"
          rel="noreferrer"
        >
          Verify TxLINE validation <ExternalLink size={14} />
        </a>
        <a href="/api/public-claim" target="_blank" rel="noreferrer">
          Inspect approved JSON <ExternalLink size={14} />
        </a>
        <div>
          <span>Candidate digest</span>
          <code>
            {claim.candidateHash
              ? shortHash(claim.candidateHash, 14)
              : "Legacy approval"}
          </code>
        </div>
      </div>
    </section>
  );
}

function Header({ connection }: { connection: ConnectionMode }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">
          <ShieldCheck size={17} />
        </span>
        <strong>Stoppage</strong>
        <span className="brand-version">v0.1</span>
      </div>
      <nav aria-label="Primary navigation">
        <a href="#product-title">Console</a>
        <a href="#mainnet-evidence">Evidence</a>
        <a
          href="https://txline.txodds.com/documentation/worldcup"
          target="_blank"
          rel="noreferrer"
        >
          TxLINE <ExternalLink size={13} />
        </a>
        <a
          href="https://solscan.io/account/9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA"
          target="_blank"
          rel="noreferrer"
        >
          Mainnet program <ExternalLink size={13} />
        </a>
      </nav>
      <div className={`connection-pill ${connection}`} role="status">
        <span />
        {connection === "live"
          ? "Console live"
          : connection === "local"
            ? "Judge mode ready"
            : connection}
      </div>
    </header>
  );
}

function DataMode({ mode }: { mode: RuntimeSnapshot["dataMode"] }) {
  return (
    <span className={`data-mode ${mode.toLowerCase()}`}>
      {mode === "SYNTHETIC" ? "Synthetic judge fixture" : "TxLINE replay"}
    </span>
  );
}

function StateCommand({ snapshot }: { snapshot: RuntimeSnapshot }) {
  const latestDecision = [...snapshot.timeline]
    .reverse()
    .find((item) => item.kind === "DECISION");

  return (
    <div
      className={`state-command mode-${snapshot.mode.toLowerCase()}`}
      aria-live="polite"
    >
      <div className="state-command-head">
        <span>Quote state</span>
        <StatusIcon mode={snapshot.mode} />
      </div>
      <strong className="state-name">{snapshot.mode}</strong>
      <div className="decision-readout">
        <span>Last policy action</span>
        <strong>{latestDecision?.label ?? "Awaiting replay"}</strong>
        <small>{latestDecision?.detail ?? "No transition emitted"}</small>
      </div>
    </div>
  );
}

function StatusIcon({ mode }: { mode: GovernorMode }) {
  if (mode === "FAILSAFE") return <AlertTriangle size={22} />;
  if (mode === "SUSPENDED") return <CircleStop size={22} />;
  if (mode === "REPRICED") return <Gauge size={22} />;
  return <Check size={22} />;
}

function MarketBook({
  title,
  subtitle,
  mode,
  probabilities,
  governed = false,
}: {
  title: string;
  subtitle: string;
  mode: GovernorMode;
  probabilities: ProbabilityVector | null;
  governed?: boolean;
}) {
  const quoteAvailable = probabilities && (!governed || mode === "OPEN");

  return (
    <article className={`market-book ${governed ? "governed" : "baseline"}`}>
      <header>
        <div>
          <span>{subtitle}</span>
          <h2>{title}</h2>
        </div>
        <span className={`book-state state-${mode.toLowerCase()}`}>{mode}</span>
      </header>
      <div className="selection-grid">
        {selections.map(({ key, label }) => {
          const value = probabilities?.[key] ?? 0;
          return (
            <div className="selection" key={key}>
              <div className="selection-label">
                <span>{label}</span>
                <strong>{quoteAvailable ? formatPercent(value) : "—"}</strong>
              </div>
              <div className="probability-track" aria-hidden="true">
                <span
                  style={{ width: quoteAvailable ? `${value * 100}%` : "0%" }}
                />
              </div>
            </div>
          );
        })}
      </div>
      {governed && mode !== "OPEN" ? (
        <div className="quote-shutter">
          <ShieldCheck size={17} /> Quote unavailable to buyers
        </div>
      ) : null}
    </article>
  );
}

function MetricBand({ snapshot }: { snapshot: RuntimeSnapshot }) {
  const metrics = [
    {
      label: "Suspend reaction",
      value: formatMetric(snapshot.metrics.suspensionReactionMs, "ms"),
      detail: "trigger receipt latency",
    },
    {
      label: "Stale quote window",
      value: formatMetric(snapshot.metrics.staleQuoteSeconds, "s", 1),
      detail: "baseline open · governed closed",
    },
    {
      label: "Mispricing integral",
      value: formatMetric(snapshot.metrics.mispricingIntegral, "p·s", 3),
      detail: "probability divergence × time",
    },
    {
      label: "Max divergence",
      value:
        snapshot.metrics.maximumProbabilityDivergence === null
          ? "—"
          : formatPercent(snapshot.metrics.maximumProbabilityDivergence),
      detail: "largest selection move",
    },
    {
      label: "Fail-safe drills",
      value: String(snapshot.metrics.failoverCount),
      detail: "stream-health transitions",
    },
  ];

  return (
    <section className="metric-band" aria-label="Lifecycle metrics">
      {metrics.map((metric) => (
        <div className="metric" key={metric.label}>
          <span>{metric.label}</span>
          <strong>{metric.value}</strong>
          <small>{metric.detail}</small>
        </div>
      ))}
    </section>
  );
}

function Timeline({ snapshot }: { snapshot: RuntimeSnapshot }) {
  const items = useMemo(
    () => [...snapshot.timeline].reverse().slice(0, 9),
    [snapshot.timeline],
  );

  return (
    <section className="timeline-panel">
      <div className="section-heading">
        <div>
          <span>Decision stream</span>
          <h2>Market timeline</h2>
        </div>
        <Activity size={19} />
      </div>
      <div className="timeline-list" aria-live="polite">
        {items.length ? (
          items.map((item) => (
            <div
              className={`timeline-row ${item.kind.toLowerCase()}`}
              key={item.id}
            >
              <time>{formatEventTime(item.at)}</time>
              <span className="timeline-marker" />
              <div>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </div>
              <span className="timeline-mode">{item.mode ?? item.kind}</span>
            </div>
          ))
        ) : (
          <EmptyRows label="Replay has not started" />
        )}
      </div>
    </section>
  );
}

function ProofPanel({ snapshot }: { snapshot: RuntimeSnapshot }) {
  const [copied, setCopied] = useState(false);
  const latest = snapshot.receipts.at(-1);

  async function copyHash() {
    if (!latest) return;
    await navigator.clipboard.writeText(latest.hash);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_400);
  }

  return (
    <section className="proof-panel" id="evidence">
      <div className="section-heading">
        <div>
          <span>Deterministic evidence</span>
          <h2>Decision receipt</h2>
        </div>
        <ShieldCheck size={19} />
      </div>
      {latest ? (
        <>
          <div className="proof-action">
            <span>{latest.body.fromMode}</span>
            <strong>{latest.body.action}</strong>
            <span>{latest.body.toMode}</span>
          </div>
          <dl className="proof-fields">
            <div>
              <dt>Rule</dt>
              <dd>{latest.body.trigger}</dd>
            </div>
            <div>
              <dt>Sources</dt>
              <dd>{latest.body.sourceIds.length}</dd>
            </div>
            <div>
              <dt>Config</dt>
              <dd>{shortHash(latest.body.configHash)}</dd>
            </div>
          </dl>
          <button
            className="hash-button"
            type="button"
            onClick={copyHash}
            title="Copy decision receipt hash"
            aria-label="Copy decision receipt hash"
          >
            <code>{shortHash(latest.hash, 14)}</code>
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
        </>
      ) : (
        <EmptyRows label="No receipt emitted" />
      )}
      <div className="proof-note">
        <Database size={15} />
        <span>Canonical JSON · SHA-256 · config-bound</span>
      </div>
    </section>
  );
}

function SystemStatus({
  icon,
  label,
  value,
  healthy,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  healthy: boolean;
}) {
  return (
    <div className="system-status">
      <span className={healthy ? "healthy" : "degraded"} aria-hidden="true">
        {icon}
      </span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function Footer({ snapshot }: { snapshot: RuntimeSnapshot }) {
  return (
    <footer>
      <div>
        <strong>Stoppage</strong>
        <span>In-play quote control driven by TxLINE</span>
      </div>
      <div>
        <span>{snapshot.dataDescription}</span>
        <code>{shortHash(snapshot.configHash)}</code>
      </div>
    </footer>
  );
}

function LoadingState({ connection }: { connection: string }) {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <ShieldCheck size={26} aria-hidden="true" />
      <strong>Stoppage</strong>
      <span>{connection} to operator console</span>
    </div>
  );
}

function EmptyRows({ label }: { label: string }) {
  return (
    <div className="empty-row">
      <span>{label}</span>
    </div>
  );
}

function stateNodeClass(
  snapshot: RuntimeSnapshot,
  mode: GovernorMode,
  index: number,
) {
  const lifecycleActions = snapshot.receipts.map(
    (receipt) => receipt.body.action,
  );
  if (index === 0) return snapshot.timeline.length ? "complete" : "active";
  if (index === 1 && lifecycleActions.includes("SUSPEND"))
    return snapshot.mode === "SUSPENDED" ? "active" : "complete";
  if (index === 2 && lifecycleActions.includes("REPRICE"))
    return snapshot.mode === "REPRICED" ? "active" : "complete";
  if (index === 3 && lifecycleActions.includes("REOPEN"))
    return snapshot.mode === "OPEN" ? "active" : "complete";
  return mode === snapshot.mode ? "active" : "pending";
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}
function formatMetric(value: number | null, suffix: string, precision = 0) {
  return value === null ? "—" : `${value.toFixed(precision)} ${suffix}`;
}
function formatReplayClock(milliseconds: number) {
  const total = Math.floor(milliseconds / 1_000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
function formatDuration(seconds: number) {
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}
function formatElapsed(milliseconds: number) {
  if (milliseconds === 0) return "trigger";
  return `+${(milliseconds / 1_000).toFixed(1)}s`;
}
function formatEventTime(timestamp: number) {
  return new Date(timestamp).toISOString().slice(11, 19);
}
function shortHash(hash: string, width = 10) {
  return `${hash.slice(0, width)}…${hash.slice(-6)}`;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
