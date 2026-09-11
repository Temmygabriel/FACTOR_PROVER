# Factor Prover — Build Specification

**Hackathon:** Bitget AI × Crypto Hackathon — Genesis Season 2  
**Track:** Agentic Trading — Factor mining agent  
**Submission deadline:** September 21, 2026  
**Builder:** Solo developer, Lagos, Nigeria  
**Coding assistant:** DeepSeek Flash V4 inside Claude Code  
**Deployment target:** Vercel (frontend) + Railway or Render free tier (backend)  
**Local machine:** 8GB RAM — no heavy local builds, no local model inference  
**Real funds required:** No — all execution via `--paper-trading` flag  

---

## 1. What This Product Is

Factor Prover is an autonomous research loop that proposes, tests, and adjudicates
cross-asset factor hypotheses using Bitget market data. It does not claim to find
profitable alpha. It claims to run a statistically honest, falsifiable research
protocol — and to show every hypothesis it killed alongside every one it promoted.

The strongest claim of the submission is:

> "Factor Prover proposed N structured cross-asset hypotheses. It rejected M,
> validated K, and promoted P. Here is the full research record, the statistical
> protocol it ran, the multiple-testing correction applied, and one paper-executed
> order through Bitget Agent Hub."

The weakest possible claim — which must never appear in the submission — is:

> "Our AI found profitable alpha."

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    FACTOR PROVER LOOP                       │
│                                                             │
│  ┌──────────────┐     structured JSON      ┌─────────────┐ │
│  │  LLM Agent   │ ────────────────────────▶│  Schema     │ │
│  │  (Hypothesis │                          │  Validator  │ │
│  │  Generator)  │                          └──────┬──────┘ │
│  └──────▲───────┘                                 │        │
│         │                               valid / auto-KILL  │
│  typed numeric                                    │        │
│  context only                                     ▼        │
│         │                          ┌──────────────────────┐│
│  ┌──────┴───────┐                  │   Backtest Engine    ││
│  │  Context     │                  │   (DISCOVERY data    ││
│  │  Projector   │◀─────────────────│    partition only)   ││
│  │  (strips all │   IC / t-stat /  └──────────┬───────────┘│
│  │  free text)  │   hit-rate /                │            │
│  └──────────────┘   n_obs                     │            │
│         ▲                                     ▼            │
│         │                          ┌──────────────────────┐│
│  ┌──────┴───────┐  PROMOTE/KILL/   │  Deterministic Gate  ││
│  │  Decision    │◀─RETIRE decision─│  (BH-FDR corrected   ││
│  │  Log         │                  │   VALIDATION split)  ││
│  │  (hash-      │                  └──────────┬───────────┘│
│  │   chained,   │                             │            │
│  │   append-    │                    PROMOTE only          │
│  │   only)      │                             │            │
│  └──────────────┘                             ▼            │
│                                   ┌──────────────────────┐ │
│                                   │   Execution Guard    │ │
│                                   │   position caps →    │ │
│                                   │   price sanity →     │ │
│                                   │   --paper-trading →  │ │
│                                   │   --confirm →        │ │
│                                   │   Bitget Agent Hub   │ │
│                                   └──────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Non-Negotiable Architectural Rules

These four rules must be implemented before any feature work. If any is missing,
the submission is not defensible.

### Rule 1 — Frozen Data Partitions

Split all available Bitget 1-minute candle history into three partitions
on first run. Store partition boundaries in a config file. Never modify them.

```
DISCOVERY   — 60% of available history
              The LLM's backtest engine runs here only
              
VALIDATION  — 20% of available history
              The deterministic gate runs final evaluation here
              Never touched during hypothesis generation
              
LOCKED_TEST — 20% of available history (most recent)
              Inaccessible to the loop entirely
              Used only for the final demo evaluation pass
              Accessed once, manually, for the submission demo
```

Implementation note: store partition boundaries as ISO timestamps in
`config/partitions.json`. The backtest engine reads this file and hard-rejects
any query spanning outside the DISCOVERY window. The gate reads it and
hard-rejects any VALIDATION query during the discovery phase.

### Rule 2 — Benjamini-Hochberg FDR Correction

Every hypothesis that reaches the gate — including failures — is counted in
the multiple-testing correction. The correction must be applied family-wide,
not per-hypothesis.

```python
# Pseudocode — implement in the gate module
def apply_bh_correction(all_p_values: list[float], fdr_level: float = 0.10):
    """
    all_p_values: p-values for EVERY hypothesis attempted this session,
                  including all kills, retries, and near-duplicates.
                  This count must never be limited to passing hypotheses only.
    fdr_level: preregistered before the loop starts. Default 0.10.
               Must be stored in config and never changed mid-session.
    Returns: adjusted threshold for each hypothesis's p-value.
    """
    m = len(all_p_values)
    sorted_pairs = sorted(enumerate(all_p_values), key=lambda x: x[1])
    adjusted = {}
    for rank, (idx, p) in enumerate(sorted_pairs, start=1):
        bh_threshold = (rank / m) * fdr_level
        adjusted[idx] = (p <= bh_threshold)
    return adjusted
```

The gate reads the preregistered FDR level from `config/gate_policy.json`.
That file is written once at session start and is read-only for the loop.

### Rule 3 — Hash-Chained Append-Only Decision Log

Every gate decision writes one entry to `logs/decisions.jsonl`.
Each entry is hashed and the hash of the previous entry is included.
No entry is ever modified or deleted. The file grows only.

```json
{
  "entry_id": "E-0043",
  "prev_hash": "sha256:a3f9...",
  "hypothesis_id": "H-042",
  "hypothesis_hash": "sha256:b2c1...",
  "session_id": "S-2026-09-10-001",
  "timestamp_utc": "2026-09-10T14:32:07Z",
  "partition_used": "VALIDATION",
  "ic": 0.041,
  "t_stat": 1.87,
  "hit_rate": 0.523,
  "n_obs": 214,
  "bh_adjusted_threshold": 0.023,
  "raw_p_value": 0.031,
  "gate_decision": "KILL",
  "gate_reason": "p_value_exceeds_bh_threshold",
  "total_hypotheses_attempted_this_session": 43,
  "fdr_level": 0.10,
  "entry_hash": "sha256:d4e2..."
}
```

The `entry_hash` is `sha256(json_serialize(all_fields_except_entry_hash))`.
The UI displays the hash for every entry so judges can verify the chain.

### Rule 4 — Execution Guard (Hard Gate Before Any Order)

No order reaches Bitget Agent Hub unless it passes all five checks in sequence.
These checks are implemented in a standalone module with no LLM involvement.

```
CHECK 1 — Paper trading flag
  Verify BITGET_PAPER_TRADING env var === "true"
  If not: refuse order, log, alert

CHECK 2 — Position cap
  Current open paper positions + this order <= MAX_OPEN_POSITIONS (default: 3)
  If exceeded: refuse order, log

CHECK 3 — Size cap
  Order notional value <= MAX_ORDER_USDT (default: 100 USDT paper)
  If exceeded: clip to cap, log the clip

CHECK 4 — Live price sanity
  Fetch current Bitget spot price for the target symbol
  Order entry price must be within PRICE_SANITY_BAND % of live price (default: 2%)
  If outside band: refuse order, log, flag as stale signal

CHECK 5 — --confirm gate
  Issue the Agent Hub call with --confirm flag
  The SDK returns confirmationRequired
  The system re-issues with explicit confirmation
  This re-issuance is logged separately

Only after all five checks pass does the order reach Agent Hub.
```

---

## 4. Factor Schema (Bounded, Enum-Constrained)

Every hypothesis the LLM produces must conform to this schema exactly.
Any field outside the enum or type is auto-KILLed before reaching the backtest.
The LLM never produces free-text rationale inside the executable schema.

```typescript
interface FactorHypothesis {
  hypothesis_id: string;          // H-{padded number}, assigned by system not LLM
  session_id: string;             // assigned by system
  proposed_at: string;            // ISO timestamp, assigned by system

  // Signal definition — all enum-constrained
  signal: SignalId;               // see enum below
  condition: {
    operator: "gt" | "lt" | "gte" | "lte" | "pct_change_gt" | "pct_change_lt";
    threshold: number;            // float, bounded by signal's valid range
    lookback_minutes: number;     // integer, 1–480 only
  };

  // Target definition
  target: rTokenSymbol;           // e.g. "RCOINUSDT" — validated against live symbol list
  direction: "positive" | "negative";
  forward_return_minutes: number; // integer, 15–480 only

  // Family tag for FDR grouping
  experiment_family: ExperimentFamily;
}

type SignalId =
  | "btc_funding_rate"
  | "eth_funding_rate"
  | "btc_open_interest"
  | "eth_open_interest"
  | "btc_spot_return"
  | "eth_spot_return"
  | "btc_funding_x_spot"        // combined condition: funding AND spot move
  | "sentiment_fear_greed"
  | "sentiment_long_short_ratio";

type rTokenSymbol =
  | "RCOINUSDT"
  | "RNVDAUSDT"
  | "RGOOGLUSDT"
  | "RAAPLUSDT"
  | "RAMZNUSDT"
  | "RSPYUSDT"
  | "RQQQUSDT";
  // Add others from live symbol list at build time

type ExperimentFamily =
  | "funding_to_rtoken"          // Family 1
  | "oi_shock_to_rtoken"         // Family 2
  | "btc_momentum_to_rtoken"     // Family 3
  | "combined_cross_asset";      // Family 4
```

---

## 5. LLM Context Projection (What the LLM Actually Receives)

The LLM never receives raw market data, raw news text, raw decision log entries,
or raw leaderboard strings. It receives only a typed context object.

```typescript
interface LLMContext {
  // Session state (typed numbers only)
  session: {
    session_id: string;
    hypotheses_attempted: number;
    hypotheses_promoted: number;
    hypotheses_killed: number;
    hypotheses_retired: number;
    current_fdr_level: number;
    discovery_window_start: string;   // ISO date only
    discovery_window_end: string;     // ISO date only
  };

  // Leaderboard (no LLM-authored strings)
  promoted_factors: Array<{
    factor_id: string;               // system-assigned, deterministic
    signal: SignalId;
    target: rTokenSymbol;
    window_minutes: number;
    direction: "positive" | "negative";
    ic: number;
    t_stat: number;
    hit_rate: number;
    n_obs: number;
    paper_pnl_usdt: number;
    decay_half_life_days: number | null;
    status: "active" | "retired";
  }>;

  // Recent kills (last 10, typed fields only)
  recent_kills: Array<{
    factor_id: string;
    signal: SignalId;
    target: rTokenSymbol;
    kill_reason: "p_value_exceeds_bh_threshold" | "insufficient_obs" |
                 "lookback_bias_detected" | "duplicate_family";
    ic: number;
    t_stat: number;
  }>;

  // Market summary (pre-computed, typed)
  market_summary: {
    btc_funding_rate_current: number;
    btc_funding_rate_7d_percentile: number;
    btc_oi_change_24h_pct: number;
    btc_spot_return_1h_pct: number;
    eth_funding_rate_current: number;
    fear_greed_index: number;
    // One line per signal type — all numbers, no prose
  };

  // Allowed search space (for LLM to propose within)
  allowed_signals: SignalId[];
  allowed_targets: rTokenSymbol[];
  allowed_families: ExperimentFamily[];
}
```

The LLM system prompt instructs it to respond with a single `FactorHypothesis`
JSON object only. No prose. No rationale. No markdown. Just the JSON.

The LLM prompt also includes the preregistered thresholds so the LLM knows
what bar it is proposing against — but cannot change the bar.

---

## 6. Backtest Engine

### Data fetching

```typescript
// Fetch 1-minute candles for a symbol within DISCOVERY partition only
async function fetchCandles(
  symbol: string,
  startIso: string,  // must be >= DISCOVERY_START
  endIso: string,    // must be <= DISCOVERY_END
  granularity: "1min"
): Promise<Candle[]>

// Endpoint:
// GET /api/v2/spot/market/candles
//   ?symbol=RCOINUSDT
//   &granularity=1min
//   &startTime={unix_ms}
//   &endTime={unix_ms}
```

### Gap handling

Missing candles (gaps in the series) must be handled explicitly:

- If gap length <= 5 minutes: forward-fill with the last valid close price
- If gap length > 5 minutes: mark the hypothesis window as INSUFFICIENT_DATA
  and auto-KILL the hypothesis. Log the gap.
- Never interpolate across session boundaries (U.S. market open/close transitions)
  — treat these as hard gaps regardless of length

### Signal computation

```typescript
function computeSignal(
  candles: Candle[],
  hypothesis: FactorHypothesis
): SignalSeries {
  // Returns: array of {timestamp, signal_value, target_return, valid: boolean}
  // valid = false if the observation spans a gap or a session boundary
  // Only valid=true observations are passed to the stat evaluator
}
```

### Stat evaluation

```typescript
function evaluateHypothesis(observations: SignalObservation[]): BacktestResult {
  // Returns:
  // - ic: Pearson correlation between signal and forward return
  // - t_stat: t-statistic on the IC
  // - p_value: two-tailed p-value
  // - hit_rate: fraction of observations where direction was correct
  // - n_obs: count of valid observations only
  // - baseline_ic: IC of a naive baseline (prior-period return as signal)
  //   A factor must beat its baseline IC to be considered for promotion
}
```

Minimum observation count: **100 valid observations**. Any hypothesis with
fewer than 100 valid observations is auto-KILLed with reason `insufficient_obs`.

---

## 7. Deterministic Gate

The gate runs after the backtest engine on the VALIDATION partition.

```typescript
function runGate(
  backtest_result: BacktestResult,
  all_session_p_values: number[],  // ALL hypotheses attempted, not just this one
  preregistered_fdr_level: number, // from config/gate_policy.json
  preregistered_min_ic: number,    // from config/gate_policy.json
  preregistered_min_t_stat: number // from config/gate_policy.json
): GateDecision {

  // Check 1: minimum observation count (already enforced by backtest)

  // Check 2: BH-FDR correction
  const bh_passes = apply_bh_correction(all_session_p_values, preregistered_fdr_level);
  const this_hypothesis_passes_bh = bh_passes[current_hypothesis_index];

  // Check 3: absolute IC floor
  const passes_ic = backtest_result.ic >= preregistered_min_ic;

  // Check 4: absolute t-stat floor
  const passes_tstat = backtest_result.t_stat >= preregistered_min_t_stat;

  // Check 5: baseline beat
  const beats_baseline = backtest_result.ic > backtest_result.baseline_ic;

  if (this_hypothesis_passes_bh && passes_ic && passes_tstat && beats_baseline) {
    return { decision: "PROMOTE", ... };
  } else {
    return {
      decision: "KILL",
      reason: determine_kill_reason(...)
    };
  }
}
```

Preregistered gate thresholds (stored in `config/gate_policy.json`,
written once at session start, read-only thereafter):

```json
{
  "fdr_level": 0.10,
  "min_ic": 0.04,
  "min_t_stat": 2.0,
  "min_obs": 100,
  "require_baseline_beat": true,
  "policy_version": "v1.0",
  "locked_at": "2026-09-10T00:00:00Z"
}
```

---

## 8. Factor Families (Scope Constraint)

The LLM proposes hypotheses within these four families only.
This is enforced by the schema validator.

**Family 1 — BTC funding rate → rToken forward return**
- Signal: `btc_funding_rate`
- Condition: spike above/below a percentile threshold
- Targets: any rToken in the allowed list
- Window: 15m to 4h forward return

**Family 2 — Crypto OI shock → rToken return**
- Signal: `btc_open_interest` or `eth_open_interest`
- Condition: percentage change above/below threshold within a lookback
- Targets: rCOIN, rNVDA prioritised (crypto-correlated)
- Window: 30m to 4h forward return

**Family 3 — BTC spot momentum → rToken return**
- Signal: `btc_spot_return`
- Condition: return above/below threshold in lookback window
- Targets: rCOIN, rAMZN, rGOOGL
- Window: 30m to 4h forward return

**Family 4 — Combined cross-asset condition**
- Signal: `btc_funding_x_spot`
- Condition: funding spike AND spot return threshold simultaneously
- Targets: any rToken
- Window: 1h to 8h forward return

---

## 9. Project Structure

```
factor-prover/
├── apps/
│   ├── web/                    # Next.js 14 frontend (Vercel deployment)
│   │   ├── app/
│   │   │   ├── page.tsx        # Live loop view (default route)
│   │   │   ├── leaderboard/
│   │   │   │   └── page.tsx    # Factor leaderboard
│   │   │   ├── log/
│   │   │   │   └── page.tsx    # Decision log
│   │   │   ├── factors/
│   │   │   │   └── [id]/
│   │   │   │       └── page.tsx # Single factor detail
│   │   │   └── api/
│   │   │       └── stream/
│   │   │           └── route.ts # SSE stream from backend
│   │   └── components/
│   │       ├── LoopStatus.tsx
│   │       ├── HypothesisCard.tsx
│   │       ├── VerdictStamp.tsx   # PROMOTED / KILLED / RETIRED stamp
│   │       ├── FactorLeaderboard.tsx
│   │       ├── DecisionLog.tsx
│   │       ├── ExecutionGuard.tsx
│   │       └── HashChainViewer.tsx
│   │
│   └── agent/                  # Node.js backend (Railway/Render free tier)
│       ├── src/
│       │   ├── loop.ts         # Main autonomous loop orchestrator
│       │   ├── llm/
│       │   │   ├── client.ts   # Anthropic API client
│       │   │   ├── prompt.ts   # System prompt + context projector
│       │   │   └── validator.ts # Schema validation + auto-KILL
│       │   ├── backtest/
│       │   │   ├── engine.ts   # Backtest runner
│       │   │   ├── data.ts     # Bitget candle fetcher
│       │   │   ├── signals.ts  # Signal computation per family
│       │   │   └── stats.ts    # IC, t-stat, p-value, BH-FDR
│       │   ├── gate/
│       │   │   ├── gate.ts     # Deterministic gate
│       │   │   └── policy.ts   # Gate policy loader (read-only after init)
│       │   ├── execution/
│       │   │   ├── guard.ts    # Execution Guard (5 checks)
│       │   │   └── agentHub.ts # Bitget Agent Hub client
│       │   ├── log/
│       │   │   ├── decisions.ts # Hash-chained append-only log writer
│       │   │   └── verify.ts   # Hash chain verifier
│       │   ├── circuit/
│       │   │   └── breaker.ts  # Loop circuit breaker (see below)
│       │   └── stream/
│       │       └── sse.ts      # Server-sent events to frontend
│       ├── config/
│       │   ├── partitions.json # DISCOVERY / VALIDATION / LOCKED_TEST boundaries
│       │   └── gate_policy.json # Preregistered thresholds (read-only after init)
│       └── logs/
│           └── decisions.jsonl  # Hash-chained decision log
```

---

## 10. Circuit Breaker

The loop has a hard circuit breaker that pauses execution and requires manual
reset if any of these conditions are met:

```typescript
const CIRCUIT_BREAKER_RULES = {
  // Daily limits
  max_hypotheses_per_day: 200,
  max_promotes_per_day: 10,
  max_paper_orders_per_day: 20,

  // Degenerate loop detection
  // If the last N hypotheses share the same signal+target combo, pause
  duplicate_signal_target_window: 5,
  duplicate_signal_target_threshold: 4, // 4 out of last 5 = degenerate

  // Context window safety
  // Pause the loop before feeding more than this many log entries to LLM
  max_log_entries_in_context: 20,

  // Backtest timeout
  max_backtest_duration_ms: 30000, // 30 seconds; if exceeded, auto-KILL

  // LLM failure handling
  max_consecutive_llm_failures: 3, // pause loop after 3 consecutive LLM failures
};
```

When the circuit breaker fires, the loop stops cleanly, writes a
`CIRCUIT_BREAK` entry to the decision log with the reason, and exposes
a `/api/reset` endpoint that the builder can call manually to resume.

---

## 11. API Endpoints (Backend)

```
GET  /api/status          — loop status, session stats, circuit breaker state
GET  /api/leaderboard     — promoted factors, sorted by IC descending
GET  /api/log             — decision log entries, paginated, newest first
GET  /api/factors/:id     — single factor detail with full backtest stats
GET  /api/log/verify      — hash chain verification result
GET  /api/stream          — SSE stream of live loop events
POST /api/loop/start      — start the autonomous loop
POST /api/loop/pause      — pause the loop
POST /api/loop/reset      — reset circuit breaker and resume
GET  /api/demo/replay     — replay a specific past loop run (demo mode)
```

---

## 12. Environment Variables

```bash
# LLM
ANTHROPIC_API_KEY=

# Bitget
BITGET_API_KEY=
BITGET_API_SECRET=
BITGET_API_PASSPHRASE=
BITGET_PAPER_TRADING=true        # MUST be "true" — Execution Guard checks this

# Loop config
LLM_MODEL=claude-sonnet-4-6      # or whichever model is available
MAX_LOOP_ITERATIONS_PER_RUN=50
LOOP_ITERATION_DELAY_MS=5000     # pause between iterations

# Feature flags
ENABLE_EXECUTION=false           # set true only to enable paper order execution
DEMO_MODE=false                  # set true to run replay instead of live loop
```

---

## 13. Key Bitget API Endpoints Used

All endpoints verified live:

```
Candle data:
GET /api/v2/spot/market/candles
  ?symbol=RCOINUSDT
  &granularity=1min
  &startTime={unix_ms}
  &endTime={unix_ms}

Funding rate:
GET /api/v2/mix/market/current-fund-rate
  ?symbol=BTCUSDT_UMCBL  (or applicable futures symbol)

Open interest:
GET /api/v2/mix/market/open-interest
  ?symbol=BTCUSDT_UMCBL
  &productType=USDT-FUTURES

Live spot price (for Execution Guard price sanity check):
GET /api/v2/spot/market/tickers
  ?symbol=RCOINUSDT

rToken symbol list:
GET /api/v2/spot/public/symbols
  ?symbol=RNVDAUSDT   (check one; list all rToken symbols at build time)

Paper futures (for paper execution):
GET /api/v2/mix/market/tickers
  ?productType=SUSDT-FUTURES
```

**IMPORTANT:** Verify at build time whether rToken spot (`RCOINUSDT` etc.)
is accessible in the paper trading / demo environment. If it is not, execution
demo must use SBTCSUSDT (crypto futures paper) and the submission must be
honest about this limitation.

---

## 14. Demo Mode

The demo must work even if the live loop is slow or produces nothing interesting
during a live presentation. Implement a replay system from Day 1.

```typescript
// Replay a specific session from the decision log
// The loop reads existing log entries and "replays" them through the UI
// at controlled speed — showing hypothesis → backtest → gate → verdict
// in sequence, as if the loop is running live.

// Store demo sessions in logs/demo_sessions/
// Each session is a subset of the decision log
// containing at least:
//   - 3 KILLed hypotheses (with different kill reasons)
//   - 1 PROMOTED hypothesis
//   - 1 paper order execution sequence
//   - 1 RETIRED factor (edge decayed after promotion)
```

The builder controls replay speed via a UI slider.
Demo mode is clearly labeled in the UI: **"REPLAY — Session S-2026-09-10-001"**

---

## 15. Day-by-Day Build Plan

### Day 1–2 (Sep 10–11): Foundation
- Initialize monorepo (Next.js + Node.js)
- Implement `config/partitions.json` and `config/gate_policy.json` writers
- Implement Bitget candle fetcher with partition enforcement
- Implement signal computation for Family 1 (BTC funding → rToken)
- Implement backtest stat evaluator (IC, t-stat, p-value, baseline)
- Verify rToken candle data is accessible (`RCOINUSDT`, `RNVDAUSDT`)
- Verify paper trading path (does `--paper-trading` work for rToken spot?)

### Day 3–4 (Sep 12–13): Gate + Log
- Implement BH-FDR correction module
- Implement deterministic gate with all five checks
- Implement hash-chained append-only decision log writer
- Implement hash chain verifier
- Write unit tests for gate + log (these are the most critical modules)

### Day 5–6 (Sep 14–15): LLM Integration
- Implement context projector (typed fields only, no free text)
- Implement LLM system prompt
- Implement schema validator with auto-KILL on malformed output
- Wire together: LLM → validator → backtest → gate → log
- Run first end-to-end loop iteration manually

### Day 7 (Sep 16): Execution Guard + Agent Hub
- Implement Execution Guard (5 checks in sequence)
- Implement Agent Hub client with `--paper-trading` and `--confirm`
- Test a paper order end-to-end (or note limitation if rToken spot
  paper trading is unavailable and use crypto futures paper)

### Day 8 (Sep 17): Circuit Breaker + SSE Stream
- Implement circuit breaker
- Implement SSE stream from backend to frontend
- Implement loop control endpoints (start / pause / reset)

### Day 9–10 (Sep 18–19): Frontend
- Build all seven screens (see Design Spec)
- Wire SSE stream to live loop view
- Build replay / demo mode
- Build hash chain viewer

### Day 11 (Sep 20): Demo Recording + Polish
- Record demo video (5–6 minutes, 12-step flow — see below)
- Run full loop for 24 hours to generate real decision log entries
- Generate at least one real PROMOTED factor (or prepare honest
  null-result framing if none pass the gate)
- Write submission description

### Day 12 (Sep 21): Submission
- Final check: `BITGET_PAPER_TRADING=true` confirmed in production env
- Submit before deadline with: GitHub repo, demo video, live URL,
  submission description

---

## 16. The 12-Step Demo Flow

This is the exact demo sequence to record. 5–6 minutes total.

```
Step 1  (0:00–0:20)  Show Bitget-native data sources live:
                     BTC funding rate, RCOIN candle, rToken symbol list.
                     "All data is from Bitget's API. No external sources."

Step 2  (0:20–0:40)  Show the preregistered gate policy:
                     config/gate_policy.json on screen.
                     "These thresholds were set before the loop started.
                      We cannot change them mid-session."

Step 3  (0:40–1:10)  Show the LLM proposing a hypothesis:
                     The JSON object appears in the UI.
                     "The LLM proposes a structured hypothesis.
                      It cannot write free text. It cannot change thresholds."

Step 4  (1:10–1:40)  Show the backtest running on DISCOVERY partition:
                     IC, t-stat, n_obs values populate.
                     "214 valid observations. IC 0.041. t-stat 1.87."

Step 5  (1:40–2:00)  Show the gate running — KILL:
                     The KILLED stamp appears.
                     "BH-corrected threshold at this point: 0.023.
                      Raw p-value: 0.031. Did not survive correction.
                      Killed. This is a result."

Step 6  (2:00–2:20)  Show a second KILL with a different reason:
                     (insufficient observations)
                     "Fewer than 100 valid observations.
                      Auto-killed. We do not test thin hypotheses."

Step 7  (2:20–2:50)  Show a PROMOTED hypothesis:
                     The PROMOTED stamp appears.
                     IC, t-stat, baseline beat, BH threshold all visible.
                     "43 hypotheses attempted. 1 promoted. That is the point."

Step 8  (2:50–3:10)  Show the LOCKED_TEST evaluation:
                     Run the promoted factor against the held-out test set.
                     Show whether IC holds or degrades.
                     "Out-of-sample IC: 0.038. Down from 0.071. Expected.
                      We show this number honestly."

Step 9  (3:10–3:40)  Show the Execution Guard running:
                     Each check passes, log visible.
                     "Five deterministic checks. None involve the LLM."

Step 10 (3:40–4:00)  Show a paper order executing through Bitget Agent Hub:
                     Order confirmation visible.
                     "--paper-trading confirmed. No real funds."

Step 11 (4:00–4:30)  Show the decision log with hash chain:
                     Scroll through entries, hash chain visible.
                     "Every decision is here. Every kill. Every hash.
                      The log cannot be edited without breaking the chain."

Step 12 (4:30–5:00)  Show the leaderboard:
                     Promoted factors, kills visible below.
                     "We show the losers. A system that hides its kills
                      is not doing science."
```

---

## 17. Submission Checklist

Before submitting, verify every item:

- [ ] GitHub repository is public
- [ ] `BITGET_PAPER_TRADING=true` in production environment
- [ ] `config/partitions.json` is committed (proves partitions were preregistered)
- [ ] `config/gate_policy.json` is committed (proves thresholds were preregistered)
- [ ] `logs/decisions.jsonl` is committed or linked (the full research record)
- [ ] Hash chain verification passes (`GET /api/log/verify` returns valid)
- [ ] Demo video is 5–6 minutes, covers all 12 steps
- [ ] Live URL is accessible
- [ ] Submission description uses the defensible claim, not the weak claim
- [ ] rToken paper trading limitation is disclosed if applicable
- [ ] At least one KILL and one PROMOTE visible in the demo
- [ ] If zero factors promoted: null-result framing is prepared and honest

---

## 18. The Defensible Submission Description

Use this exact framing in the submission form. Adjust numbers to reflect reality:

> Factor Prover is an autonomous factor-mining agent built on Bitget's
> cross-asset market infrastructure. It proposes structured hypotheses about
> relationships between crypto derivatives signals (BTC funding rate, open
> interest, spot momentum) and rToken forward returns. Each hypothesis is
> backtested on a preregistered DISCOVERY partition, evaluated by a
> deterministic gate with Benjamini-Hochberg false discovery rate correction,
> and promoted to paper trading only if it survives the correction, clears
> absolute IC and t-stat floors, and beats a naive baseline.
>
> In this session: [N] hypotheses proposed, [N-P] killed, [P] promoted.
> The full decision record — including every kill — is in the hash-chained
> log committed to this repository. Every entry's hash is verifiable.
>
> The strongest result is not the [P] promoted factor. It is that the system
> killed [N-P] hypotheses honestly, with documented reasons, under a
> preregistered statistical protocol.
