import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  Check,
  CircleStop,
  Copy,
  Cpu,
  Database,
  ExternalLink,
  FileCheck2,
  GitBranch,
  LockKeyhole,
  Play,
  Radio,
  RotateCcw,
  Server,
  ShieldCheck,
  TimerReset,
  Waves,
} from "lucide-react";
import {
  StrictMode,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type MouseEventHandler,
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
  WorkerHealthSnapshot,
} from "./types";
import { parsePublicClaim, type PublicClaim } from "./public-claim";
import { resolveRuntimeMode } from "./runtime-mode";
import "./styles.css";

const selections: Array<{ key: Selection; label: string }> = [
  { key: "HOME", label: "Home" },
  { key: "DRAW", label: "Draw" },
  { key: "AWAY", label: "Away" },
];

type ConnectionMode = "connecting" | "live" | "local" | "offline";
type ClaimStatus = "loading" | "available" | "unavailable";
type AppRoute = "/" | "/evidence" | "/system";
const runtimeMode = resolveRuntimeMode(import.meta.env.VITE_RUNTIME_MODE);
const navigationEvent = "stoppage:navigate";

function App() {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [connection, setConnection] = useState<ConnectionMode>("connecting");
  const [publicClaim, setPublicClaim] = useState<PublicClaim | null>(null);
  const [claimStatus, setClaimStatus] = useState<ClaimStatus>("loading");
  const [workerHealth, setWorkerHealth] = useState<WorkerHealthSnapshot | null>(
    null,
  );
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const localRuntime = useRef<StoppageRuntime | null>(null);
  const route = useAppRoute();

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

    const cleanup = () => {
      active = false;
      source?.close();
      unsubscribeLocal?.();
      localRuntime.current?.stop();
      localRuntime.current = null;
    };

    if (runtimeMode === "local") {
      enableLocalJudgeMode();
      return cleanup;
    }

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

    return cleanup;
  }, []);

  useEffect(() => {
    if (runtimeMode === "local" || connection !== "live") return;

    let active = true;
    const controller = new AbortController();

    const readWorkerHealth = () => {
      void fetch("/api/worker-health", { signal: controller.signal })
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Worker health failed: ${response.status}`);
          }
          return response.json() as Promise<WorkerHealthSnapshot>;
        })
        .then((health) => {
          if (active && health.available) setWorkerHealth(health);
        })
        .catch((error: unknown) => {
          if ((error as Error).name !== "AbortError" && active) {
            setWorkerHealth(null);
          }
        });
    };

    readWorkerHealth();
    const interval = window.setInterval(readWorkerHealth, 30_000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [connection]);

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

  useEffect(() => {
    const labels: Record<AppRoute, string> = {
      "/": "Control",
      "/evidence": "Evidence",
      "/system": "System",
    };
    document.title = `${labels[route]} · Stoppage`;
    window.scrollTo({ top: 0, behavior: "auto" });
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("main h1")?.focus({
        preventScroll: true,
      });
    });
  }, [route]);

  if (!snapshot) return <LoadingState connection={connection} />;

  const isRunning = snapshot.replayStatus === "RUNNING";
  const hasRun = snapshot.timeline.length > 0;
  const liveConnectionLabel =
    connection === "live"
      ? "Live stream"
      : connection === "local"
        ? "Judge mode"
        : connection;

  return (
    <div className="shell">
      <Header connection={connection} route={route} />
      <main>
        {route === "/" ? (
          <ControlPage
            snapshot={snapshot}
            connectionLabel={liveConnectionLabel}
            claim={publicClaim}
            claimStatus={claimStatus}
            workerHealth={workerHealth}
            isRunning={isRunning}
            hasRun={hasRun}
            actionPending={actionPending}
            actionError={actionError}
            onReplay={isRunning ? stopReplay : startReplay}
          />
        ) : route === "/evidence" ? (
          <EvidencePage
            snapshot={snapshot}
            claim={publicClaim}
            claimStatus={claimStatus}
          />
        ) : (
          <SystemPage
            snapshot={snapshot}
            connection={connection}
            workerHealth={workerHealth}
          />
        )}
      </main>
      <Footer snapshot={snapshot} />
    </div>
  );
}

function ControlPage({
  snapshot,
  connectionLabel,
  claim,
  claimStatus,
  workerHealth,
  isRunning,
  hasRun,
  actionPending,
  actionError,
  onReplay,
}: {
  snapshot: RuntimeSnapshot;
  connectionLabel: string;
  claim: PublicClaim | null;
  claimStatus: ClaimStatus;
  workerHealth: WorkerHealthSnapshot | null;
  isRunning: boolean;
  hasRun: boolean;
  actionPending: boolean;
  actionError: string | null;
  onReplay: () => void;
}) {
  return (
    <>
      <section
        className="command-band"
        id="operator-console"
        aria-labelledby="product-title"
      >
        <div className="command-inner">
          <div className="product-copy">
            <div className="eyebrow-row">
              <span className="eyebrow">Market execution control</span>
              <DataMode mode={snapshot.dataMode} />
            </div>
            <h1 id="product-title" tabIndex={-1}>
              Stoppage
            </h1>
            <p className="product-lede">
              A provisional goal moves the market. VAR reverses it. Stoppage
              keeps trading agents off the dead price branch until fresh TxLINE
              consensus authorizes the reopen.
            </p>
            <div className="hero-meta">
              <span>
                {snapshot.match.home} vs {snapshot.match.away}
              </span>
              <span>Fixture {snapshot.match.fixtureId}</span>
              <span>{connectionLabel}</span>
            </div>
            <div className="failure-case">
              <AlertTriangle size={17} aria-hidden="true" />
              <div>
                <strong>Risk under test</strong>
                <span>
                  The ungoverned agent remains executable after VAR voids the
                  price branch. The governed agent must stay closed.
                </span>
              </div>
            </div>
            <div className="command-actions">
              <button
                className="primary-action"
                type="button"
                onClick={onReplay}
                disabled={actionPending}
                aria-busy={actionPending}
              >
                {isRunning ? (
                  <CircleStop size={17} aria-hidden="true" />
                ) : hasRun ? (
                  <RotateCcw size={17} aria-hidden="true" />
                ) : (
                  <Play size={17} aria-hidden="true" />
                )}
                {isRunning
                  ? "Stop replay"
                  : hasRun
                    ? "Run again"
                    : "Run judge replay"}
              </button>
              <AppLink className="secondary-action" to="/evidence">
                Inspect evidence <FileCheck2 size={16} aria-hidden="true" />
              </AppLink>
            </div>
            <span className="scenario-name">{snapshot.scenarioLabel}</span>
            {actionError ? (
              <p className="action-error" role="alert">
                {actionError}
              </p>
            ) : null}
          </div>

          <ExecutionStage snapshot={snapshot} />
        </div>
      </section>

      <ApprovedEvidenceBand claim={claim} status={claimStatus} />

      <div className="workspace" id="operations">
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

        <ResolutionGate snapshot={snapshot} />

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

        <SystemHealthStrip snapshot={snapshot} workerHealth={workerHealth} />
      </div>
    </>
  );
}

function EvidencePage({
  snapshot,
  claim,
  claimStatus,
}: {
  snapshot: RuntimeSnapshot;
  claim: PublicClaim | null;
  claimStatus: ClaimStatus;
}) {
  return (
    <>
      <PageIntro
        index="02"
        eyebrow="Independent verification"
        title="Evidence"
        description="Approved holdout aggregates, receipt-bound lifecycle decisions, and TxLINE's own Solana validation path in one audit surface."
      >
        <div className="page-status-block">
          <span>Public claim</span>
          <strong>{claim ? "APPROVED · R2" : claimStatus.toUpperCase()}</strong>
          <small>
            {claim ? formatDate(claim.approvedAt) : "Awaiting claim"}
          </small>
        </div>
      </PageIntro>

      <div className="page-shell evidence-page">
        <ApprovedEvidencePanel claim={claim} status={claimStatus} />

        <section className="evidence-operations" aria-label="Evidence tools">
          <ProofPanel snapshot={snapshot} />
          <ClaimRegister claim={claim} status={claimStatus} />
        </section>
      </div>
    </>
  );
}

function SystemPage({
  snapshot,
  connection,
  workerHealth,
}: {
  snapshot: RuntimeSnapshot;
  connection: ConnectionMode;
  workerHealth: WorkerHealthSnapshot | null;
}) {
  const latestCertificate = [...snapshot.reopenProofs]
    .reverse()
    .find((proof) => proof.body.version === 2);
  const healthy = snapshot.streamHealth.odds && snapshot.streamHealth.scores;

  return (
    <>
      <PageIntro
        index="03"
        eyebrow="Runtime and controls"
        title="System"
        description="The deterministic path from TxLINE market inputs to an agent permit, including the exact conditions that keep execution closed."
      >
        <div className="page-status-block">
          <span>Current gate</span>
          <strong>{snapshot.mode}</strong>
          <small>
            {connection === "live" ? "Live runtime" : "Judge runtime"}
          </small>
        </div>
      </PageIntro>

      <div className="page-shell system-page">
        <SystemHealthStrip snapshot={snapshot} workerHealth={workerHealth} />

        <section className="system-section" aria-labelledby="pipeline-title">
          <div className="section-title-row">
            <div>
              <span>Execution path</span>
              <h2 id="pipeline-title">From feed to permit</h2>
            </div>
            <GitBranch size={20} aria-hidden="true" />
          </div>
          <ol className="architecture-flow">
            <ArchitectureStep
              index="01"
              icon={<Waves size={18} />}
              title="TxLINE inputs"
              detail="Scores and consensus odds enter as independent streams."
              state={healthy ? "HEALTHY" : "DEGRADED"}
            />
            <ArchitectureStep
              index="02"
              icon={<Cpu size={18} />}
              title="Policy engine"
              detail="Incidents, branch state, and freshness checks resolve deterministically."
              state={snapshot.mode}
            />
            <ArchitectureStep
              index="03"
              icon={<LockKeyhole size={18} />}
              title="Execution Gate"
              detail="Unsafe quote requests stop before the market-maker can publish."
              state={snapshot.execution.agent.decision}
            />
            <ArchitectureStep
              index="04"
              icon={<ShieldCheck size={18} />}
              title="Permit release"
              detail="A config-bound permit is emitted only after certified consensus."
              state={
                snapshot.execution.agent.permitVerified ? "VERIFIED" : "LOCKED"
              }
            />
          </ol>
        </section>

        <section className="system-section" aria-labelledby="controls-title">
          <div className="section-title-row">
            <div>
              <span>Fail-closed policy</span>
              <h2 id="controls-title">Release controls</h2>
            </div>
            <Server size={20} aria-hidden="true" />
          </div>
          <div className="control-table-wrap">
            <table className="control-table">
              <thead>
                <tr>
                  <th scope="col">Control</th>
                  <th scope="col">Required state</th>
                  <th scope="col">Current state</th>
                </tr>
              </thead>
              <tbody>
                <ControlRow
                  label="Odds stream"
                  required="Healthy"
                  current={snapshot.streamHealth.odds ? "Healthy" : "Degraded"}
                  pass={snapshot.streamHealth.odds}
                />
                <ControlRow
                  label="Scores stream"
                  required="Healthy"
                  current={
                    snapshot.streamHealth.scores ? "Healthy" : "Degraded"
                  }
                  pass={snapshot.streamHealth.scores}
                />
                <ControlRow
                  label="Pending incidents"
                  required="0 before release"
                  current={String(
                    latestCertificate?.body.checks.unresolvedIncidentCount ?? 0,
                  )}
                  pass={
                    (latestCertificate?.body.checks.unresolvedIncidentCount ??
                      0) === 0
                  }
                />
                <ControlRow
                  label="Fresh consensus"
                  required="3 post-resolution updates"
                  current={`${latestCertificate?.body.checks.postResolutionQuoteCount ?? 0}/3`}
                  pass={
                    (latestCertificate?.body.checks.postResolutionQuoteCount ??
                      0) >= 3
                  }
                />
                <ControlRow
                  label="Permit lifetime"
                  required="Short-lived authorization"
                  current={`${snapshot.execution.permitTtlMs / 1_000}s TTL`}
                  pass
                />
                <ControlRow
                  label="Policy binding"
                  required="Exact config hash"
                  current={shortHash(snapshot.configHash, 12)}
                  pass
                />
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}

function PageIntro({
  index,
  eyebrow,
  title,
  description,
  children,
}: {
  index: string;
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="page-intro" aria-labelledby="page-title">
      <div className="page-intro-inner">
        <div className="page-intro-copy">
          <span className="page-index">{index}</span>
          <div>
            <span className="page-eyebrow">{eyebrow}</span>
            <h1 id="page-title" tabIndex={-1}>
              {title}
            </h1>
            <p>{description}</p>
          </div>
        </div>
        {children}
      </div>
    </section>
  );
}

function ClaimRegister({
  claim,
  status,
}: {
  claim: PublicClaim | null;
  status: ClaimStatus;
}) {
  return (
    <section className="claim-register" aria-labelledby="claim-register-title">
      <div className="section-title-row">
        <div>
          <span>Public record</span>
          <h2 id="claim-register-title">Claim register</h2>
        </div>
        <FileCheck2 size={20} aria-hidden="true" />
      </div>
      {claim ? (
        <>
          <dl className="claim-fields">
            <div>
              <dt>Status</dt>
              <dd className="status-pass">Approved</dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>Solana mainnet</dd>
            </div>
            <div>
              <dt>Policy revision</dt>
              <dd>{claim.lifecycleEvidence.policyRevision}</dd>
            </div>
            <div>
              <dt>Approved</dt>
              <dd>{formatDate(claim.approvedAt)}</dd>
            </div>
            <div>
              <dt>Policy hash</dt>
              <dd>{shortHash(claim.approvedConfigHash, 14)}</dd>
            </div>
            <div>
              <dt>Candidate digest</dt>
              <dd>{shortHash(claim.candidateHash, 14)}</dd>
            </div>
          </dl>
          <div className="register-actions">
            <a
              href="https://github.com/dolepee/stoppage"
              target="_blank"
              rel="noreferrer"
            >
              Source code <ExternalLink size={14} aria-hidden="true" />
            </a>
            <a href="/api/public-claim" target="_blank" rel="noreferrer">
              Approved JSON <ExternalLink size={14} aria-hidden="true" />
            </a>
            <a
              href={claim.lifecycleEvidence.txlineValidation.explorer}
              target="_blank"
              rel="noreferrer"
            >
              Solana validation <ExternalLink size={14} aria-hidden="true" />
            </a>
          </div>
          <p className="boundary-note">{claim.dataBoundary}</p>
        </>
      ) : (
        <div className="register-empty" role="status">
          Claim register {status}.
        </div>
      )}
    </section>
  );
}

function SystemHealthStrip({
  snapshot,
  workerHealth,
}: {
  snapshot: RuntimeSnapshot;
  workerHealth: WorkerHealthSnapshot | null;
}) {
  return (
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
      {workerHealth ? (
        <SystemStatus
          icon={<Activity size={18} />}
          label="Live worker"
          value={formatWorkerHealth(workerHealth)}
          healthy={Boolean(
            workerHealth.running &&
            workerHealth.statusFresh &&
            workerHealth.streamHealth?.scores &&
            workerHealth.streamHealth.odds,
          )}
        />
      ) : null}
    </section>
  );
}

function ArchitectureStep({
  index,
  icon,
  title,
  detail,
  state,
}: {
  index: string;
  icon: ReactNode;
  title: string;
  detail: string;
  state: string;
}) {
  return (
    <li>
      <span className="architecture-index">{index}</span>
      <span className="architecture-icon" aria-hidden="true">
        {icon}
      </span>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      <small>{state}</small>
      {index !== "04" ? <ArrowRight size={17} aria-hidden="true" /> : null}
    </li>
  );
}

function ControlRow({
  label,
  required,
  current,
  pass,
}: {
  label: string;
  required: string;
  current: string;
  pass: boolean;
}) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{required}</td>
      <td>
        <span className={`table-status ${pass ? "pass" : "fail"}`}>
          {pass ? <Check size={13} aria-hidden="true" /> : null}
          {current}
        </span>
      </td>
    </tr>
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
          <span>Approved mainnet holdout · revision 2</span>
          <strong>
            {status === "available"
              ? "Resolution-aware TxLINE evidence"
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
              label="Branches invalidated"
              value={String(claim.holdout.preResolutionRepricesInvalidated)}
            />
            <EvidenceStat
              label="Certified reopens"
              value={String(claim.holdout.postResolutionCertifiedReopens)}
            />
            <AppLink className="evidence-jump" to="/evidence">
              Inspect evidence <FileCheck2 size={15} />
            </AppLink>
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
          <h2>Resolution-aware holdout</h2>
          <p>
            The replay above is publicly reproducible. These separately approved
            aggregates come from private licensed captures across{" "}
            {claim.holdout.fixtures} held-out TxLINE mainnet fixtures under the
            same revision-2 policy hash.
          </p>
        </div>
        <span className="approval-state">
          <Check size={14} /> Approved
        </span>
      </div>

      <div className="evidence-grid">
        <div className="evidence-aggregate">
          <EvidenceStat
            label="Pre-resolution reprices invalidated"
            value={String(claim.holdout.preResolutionRepricesInvalidated)}
          />
          <EvidenceStat
            label="Post-resolution certified reopens"
            value={String(claim.holdout.postResolutionCertifiedReopens)}
          />
          <EvidenceStat
            label="Confirmed / discarded"
            value={`${claim.holdout.confirmedResolutionCertifiedReopens} / ${claim.holdout.discardedResolutionCertifiedReopens}`}
          />
          <EvidenceStat
            label="Protected-window time"
            value={formatDuration(claim.holdout.staleQuoteSeconds)}
          />
        </div>

        <div className="verified-lifecycle">
          <span>Verified resolution lifecycle</span>
          <div className="lifecycle-path">
            {claim.lifecycleEvidence.decisions.map((decision, index) => (
              <div
                className={`lifecycle-step ${decision.action === "INVALIDATE_REPRICE" ? "invalidated" : ""}`}
                key={decision.receiptHash}
              >
                <small>{String(index + 1).padStart(2, "0")}</small>
                <strong>{decision.action}</strong>
                <span>{formatElapsed(decision.elapsedMs)}</span>
              </div>
            ))}
          </div>
          <p>{claim.dataBoundary}</p>
        </div>
      </div>

      <div className="evidence-disclosure">
        <strong>Observed trigger coverage</strong>
        <p>
          All {claim.holdout.eventLedProtectedWindows} real holdout windows were
          event-led. The odds-led detector is implemented and adversarially
          tested, but real data did not exercise it; no zero is presented as a
          successful rate.
        </p>
        <p>
          Candidate hashes preserve approval integrity, not public
          reproducibility of licensed records. Private holdout reproduction is
          available by live screen-share for judges on request.
        </p>
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

function Header({
  connection,
  route,
}: {
  connection: ConnectionMode;
  route: AppRoute;
}) {
  const modeLabel =
    connection === "live"
      ? "Live"
      : connection === "local"
        ? "Judge mode"
        : "Offline";
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand">
          <AppLink className="brand-link" to="/" aria-label="Stoppage control">
            <span className="brand-mark">
              <ShieldCheck size={17} aria-hidden="true" />
            </span>
            <strong>Stoppage</strong>
            <span className="brand-version">R2</span>
          </AppLink>
        </div>
        <div className="topbar-actions">
          <nav aria-label="Primary navigation" className="topbar-nav">
            <AppLink to="/" aria-current={route === "/" ? "page" : undefined}>
              Control
            </AppLink>
            <AppLink
              to="/evidence"
              aria-current={route === "/evidence" ? "page" : undefined}
            >
              Evidence
            </AppLink>
            <AppLink
              to="/system"
              aria-current={route === "/system" ? "page" : undefined}
            >
              System
            </AppLink>
            <a
              href="https://github.com/dolepee/stoppage"
              target="_blank"
              rel="noreferrer"
            >
              GitHub <ExternalLink size={13} aria-hidden="true" />
            </a>
            <a
              href="https://txline.txodds.com/documentation/worldcup"
              target="_blank"
              rel="noreferrer"
            >
              Docs <ExternalLink size={13} aria-hidden="true" />
            </a>
            <a
              href="https://solscan.io/account/9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA"
              target="_blank"
              rel="noreferrer"
            >
              Mainnet program <ExternalLink size={13} aria-hidden="true" />
            </a>
          </nav>
          <div className={`connection-pill ${connection}`} role="status">
            <span />
            {modeLabel}
          </div>
        </div>
      </div>
    </header>
  );
}

function AppLink({
  to,
  children,
  onClick,
  ...props
}: {
  to: AppRoute;
  children: ReactNode;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <a
      href={to}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        window.history.pushState({}, "", to);
        window.dispatchEvent(new Event(navigationEvent));
      }}
      {...props}
    >
      {children}
    </a>
  );
}

function useAppRoute(): AppRoute {
  const [route, setRoute] = useState<AppRoute>(() => resolveAppRoute());

  useEffect(() => {
    const readRoute = () => setRoute(resolveAppRoute());
    window.addEventListener("popstate", readRoute);
    window.addEventListener(navigationEvent, readRoute);
    return () => {
      window.removeEventListener("popstate", readRoute);
      window.removeEventListener(navigationEvent, readRoute);
    };
  }, []);

  return route;
}

function resolveAppRoute(): AppRoute {
  if (window.location.pathname === "/evidence") return "/evidence";
  if (window.location.pathname === "/system") return "/system";
  return "/";
}

function DataMode({ mode }: { mode: RuntimeSnapshot["dataMode"] }) {
  return (
    <span className={`data-mode ${mode.toLowerCase()}`}>
      {mode === "SYNTHETIC" ? "Synthetic fixture" : "TxLINE replay"}
    </span>
  );
}

function ExecutionStage({ snapshot }: { snapshot: RuntimeSnapshot }) {
  const { agent, permitTtlMs } = snapshot.execution;
  const blocked = agent.decision === "BLOCK";
  const allowed = agent.decision === "ALLOW";
  const stateClass = blocked ? "blocked" : allowed ? "allowed" : "waiting";
  const headline = blocked
    ? "Agent action blocked"
    : allowed
      ? "Quote authorized"
      : "Agent awaiting quote";
  const baselineExecutable = Boolean(snapshot.baselineProbability);

  return (
    <section
      className={`execution-stage ${stateClass}`}
      aria-label="Reference agent execution gate"
      aria-live="polite"
    >
      <div className="agent-command-line">
        <div>
          <span className="agent-icon" aria-hidden="true">
            <Bot size={18} />
          </span>
          <span>
            <small>{agent.name}</small>
            <strong>{agent.command}</strong>
          </span>
        </div>
        <span className={`agent-decision ${stateClass}`}>{agent.decision}</span>
      </div>

      <div className="execution-verdict">
        <span>
          {blocked ? <LockKeyhole size={23} /> : <ShieldCheck size={23} />}
        </span>
        <div>
          <small>Execution Gate</small>
          <strong>{headline}</strong>
          <p>{agent.reason}</p>
        </div>
      </div>

      <div className="consequence-grid">
        <div className="consequence-cell governed-agent">
          <span>Stoppage-gated agent</span>
          <strong>
            {blocked ? "CLOSED" : allowed ? "PUBLISHED" : "WAITING"}
          </strong>
          <small>
            {blocked
              ? "No permit · quote withheld"
              : allowed
                ? "Permit verified · simulated publish"
                : "No quote submitted"}
          </small>
        </div>
        <div
          className={`consequence-cell baseline-agent ${blocked ? "exposed" : ""}`}
        >
          <span>Ungoverned baseline</span>
          <strong>{baselineExecutable ? "EXECUTABLE" : "WAITING"}</strong>
          <small>
            {blocked
              ? "Reversible branch still available"
              : "Follows consensus without a gate"}
          </small>
        </div>
        <div className="consequence-cell exposure-clock">
          <span>
            <TimerReset size={13} /> Protected window
          </span>
          <strong>{snapshot.metrics.protectedWindowSeconds.toFixed(1)}s</strong>
          <small>
            {snapshot.metrics.currentBranchDisplacement === null
              ? "No active branch displacement"
              : `${formatPercentagePoints(snapshot.metrics.currentBranchDisplacement)} branch displacement`}
          </small>
        </div>
      </div>

      <div className="permit-line">
        <span>
          {agent.permitVerified ? "Permit verified" : "No permit emitted"}
        </span>
        <code>
          {agent.permit
            ? shortHash(agent.permit.hash, 14)
            : formatDecisionLabel(agent.decisionCode ?? "GATE_IDLE")}
        </code>
        <small>
          {(permitTtlMs / 1_000).toFixed(0)}s TTL · simulated action
        </small>
      </div>
    </section>
  );
}

function ResolutionGate({ snapshot }: { snapshot: RuntimeSnapshot }) {
  const provisionalSeen = snapshot.timeline.some(
    (item) => item.kind === "INPUT" && item.detail.includes("unconfirmed"),
  );
  const invalidated = snapshot.receipts.some(
    (receipt) => receipt.body.action === "INVALIDATE_REPRICE",
  );
  const freshQuotes = Math.min(
    3,
    snapshot.timeline.filter(
      (item) =>
        item.kind === "INPUT" &&
        (item.label.includes("Reverted branch consensus") ||
          item.label.includes("Fresh post-VAR consensus")),
    ).length,
  );
  const certified = snapshot.reopenProofs.some(
    (proof) =>
      proof.body.version === 2 &&
      proof.body.checks.resolutionOutcome === "DISCARDED",
  );

  const stages = [
    {
      label: "Incident",
      value: provisionalSeen ? "PROVISIONAL GOAL" : "AWAITING SIGNAL",
      detail: provisionalSeen ? "MARKET HELD" : "OPEN",
      complete: provisionalSeen,
    },
    {
      label: "VAR resolution",
      value: invalidated ? "GOAL OVERTURNED" : "PENDING",
      detail: invalidated ? "PRICE BRANCH VOID" : "REOPEN BLOCKED",
      complete: invalidated,
    },
    {
      label: "Fresh consensus",
      value: `${freshQuotes}/3 UPDATES`,
      detail: freshQuotes === 3 ? "POST-RESOLUTION" : "COLLECTING",
      complete: freshQuotes === 3,
    },
    {
      label: "Release",
      value: certified ? "CERTIFIED" : "LOCKED",
      detail: certified ? "REOPEN AUTHORIZED" : "GATES ACTIVE",
      complete: certified,
    },
  ];

  return (
    <section className="resolution-gate" aria-label="VAR resolution gate">
      {stages.map((stage, index) => (
        <div
          className={`resolution-stage ${stage.complete ? "complete" : "pending"}`}
          key={stage.label}
        >
          <span>
            {String(index + 1).padStart(2, "0")} · {stage.label}
          </span>
          <strong>{stage.value}</strong>
          <small>{stage.detail}</small>
        </div>
      ))}
    </section>
  );
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
  const resolutionCertificate = snapshot.reopenProofs.find(
    (proof) => proof.body.version === 2 && proof.body.checks.freshQuoteRequired,
  );
  const metrics = [
    {
      label: "Suspend reaction",
      value: formatMetric(snapshot.metrics.suspensionReactionMs, "ms"),
      detail: "trigger receipt latency",
    },
    {
      label: "Wrong branches vetoed",
      value: String(snapshot.metrics.invalidatedReprices ?? 0),
      detail: "reprices invalidated by resolution",
    },
    {
      label: "Fresh consensus",
      value: resolutionCertificate
        ? `${resolutionCertificate.body.checks.postResolutionQuoteCount}/3`
        : "0/3",
      detail: "post-resolution quote updates",
    },
    {
      label: "Protected window",
      value: formatMetric(snapshot.metrics.staleQuoteSeconds, "s", 1),
      detail: "baseline open · governed closed",
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
  const certificate =
    latest?.body.action === "REOPEN"
      ? ([...(snapshot.reopenProofs ?? [])]
          .reverse()
          .find((proof) => proof.body.reopenReceiptHash === latest.hash) ??
        null)
      : null;
  const resolutionAware =
    certificate?.body.version === 2 &&
    certificate.body.checks.freshQuoteRequired;
  const copyValue = certificate?.hash ?? latest?.hash;

  async function copyHash() {
    if (!copyValue) return;
    await navigator.clipboard.writeText(copyValue);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_400);
  }

  return (
    <section className="proof-panel" id="evidence">
      <div className="section-heading">
        <div>
          <span>
            {resolutionAware
              ? "Resolution-aware release gate"
              : certificate
                ? "Machine-verifiable release gate"
                : "Deterministic evidence"}
          </span>
          <h2>
            {resolutionAware
              ? "VAR reopen certified"
              : certificate
                ? "Reopen certified"
                : "Decision receipt"}
          </h2>
        </div>
        <ShieldCheck size={19} />
      </div>
      {latest ? (
        <>
          {certificate ? (
            <div className="certificate-status" role="status">
              <span className="certificate-mark" aria-hidden="true">
                <Check size={17} />
              </span>
              <div>
                <span>
                  {resolutionAware
                    ? "Provisional branch invalidated"
                    : "Every release condition passed"}
                </span>
                <strong>Reopen authorized</strong>
              </div>
              <code>{shortHash(certificate.hash)}</code>
            </div>
          ) : null}
          <div className="proof-action">
            <span>{latest.body.fromMode}</span>
            <strong>{latest.body.action}</strong>
            <span>{latest.body.toMode}</span>
          </div>
          <dl className="proof-fields">
            {certificate ? (
              <>
                {resolutionAware ? (
                  <>
                    <div>
                      <dt>Incident outcome</dt>
                      <dd className="proof-pass">
                        {certificate.body.checks.resolutionOutcome}
                      </dd>
                    </div>
                    <div>
                      <dt>Fresh quotes</dt>
                      <dd className="proof-pass">
                        {certificate.body.checks.postResolutionQuoteCount}/
                        {certificate.body.checks.stableUpdatesRequired}
                      </dd>
                    </div>
                  </>
                ) : null}
                <div>
                  <dt>TxLINE feeds</dt>
                  <dd className="proof-pass">Healthy · 2/2</dd>
                </div>
                <div>
                  <dt>Pending incidents</dt>
                  <dd className="proof-pass">
                    {certificate.body.checks.unresolvedIncidentCount}
                  </dd>
                </div>
                {!resolutionAware ? (
                  <div>
                    <dt>Stable updates</dt>
                    <dd className="proof-pass">
                      {certificate.body.checks.stableUpdatesObserved}/
                      {certificate.body.checks.stableUpdatesRequired}
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>Safety delay</dt>
                  <dd className="proof-pass">
                    {formatMilliseconds(certificate.body.checks.repriceAgeMs)} /{" "}
                    {formatMilliseconds(certificate.body.checks.reopenDelayMs)}
                  </dd>
                </div>
                <div>
                  <dt>Policy</dt>
                  <dd>{shortHash(certificate.body.configHash)}</dd>
                </div>
                <div>
                  <dt>Decision</dt>
                  <dd>{shortHash(certificate.body.reopenReceiptHash)}</dd>
                </div>
              </>
            ) : (
              <>
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
              </>
            )}
          </dl>
          <button
            className="hash-button"
            type="button"
            onClick={copyHash}
            title={
              certificate
                ? "Copy Certified Reopen proof hash"
                : "Copy decision receipt hash"
            }
            aria-label={
              certificate
                ? "Copy Certified Reopen proof hash"
                : "Copy decision receipt hash"
            }
          >
            <code>{shortHash(copyValue!, 14)}</code>
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
        </>
      ) : (
        <EmptyRows label="No receipt emitted" />
      )}
      <div className="proof-note">
        <Database size={15} />
        <span>
          {certificate
            ? resolutionAware
              ? "Receipt-bound · resolution-aware · independently verifiable"
              : "Receipt-bound · policy-bound · independently verifiable"
            : "Canonical JSON · SHA-256 · config-bound"}
        </span>
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

function formatWorkerHealth(health: WorkerHealthSnapshot) {
  if (!health.running) return "Worker stopped";
  if (!health.statusFresh) return "Worker heartbeat stale";
  if (!health.streamHealth?.scores || !health.streamHealth.odds) {
    return "Feed degraded";
  }
  const ages = [
    health.lastMessageAgeMs?.scores,
    health.lastMessageAgeMs?.odds,
  ].filter((age): age is number => age !== null && age !== undefined);
  if (ages.length === 0) return "Connected · awaiting match";
  return `Healthy · last feed ${formatAge(Math.min(...ages))}`;
}

function formatAge(ageMs: number) {
  if (ageMs < 1_000) return "now";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}s ago`;
  return `${Math.floor(ageMs / 60_000)}m ago`;
}

function Footer({ snapshot }: { snapshot: RuntimeSnapshot }) {
  return (
    <footer>
      <div>
        <strong>Stoppage</strong>
        <span>VAR-aware market control driven by TxLINE</span>
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
function formatDecisionLabel(value: string) {
  return value.replaceAll("_", " ");
}
function formatPercentagePoints(value: number) {
  return `${(value * 100).toFixed(1)} pp`;
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
function formatMilliseconds(milliseconds: number) {
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}
function formatEventTime(timestamp: number) {
  return new Date(timestamp).toISOString().slice(11, 19);
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}
function shortHash(hash: string, width = 10) {
  return `${hash.slice(0, width)}…${hash.slice(-6)}`;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
