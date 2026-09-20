import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import {
  ArrowDownUp,
  ArrowUpRight,
  CircleAlert,
  Coins,
  Info,
  Landmark,
  ListChecks,
  Receipt,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Timer,
  TriangleAlert,
  Wallet,
  Zap,
} from "lucide-react";
import {
  getAddress as getPublicKey,
  getNetwork,
  isAllowed,
  isConnected,
  requestAccess,
  signTransaction,
  WatchWalletChanges,
} from "@stellar/freighter-api";
import AnchorPanel from "./components/AnchorPanel";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { cn } from "./lib/cn";
import { formatUsdcPrice, limitComparator } from "./lib/price";
import { fetchOracleQuote } from "./oracle/reflector";
import type { OracleQuote } from "./oracle/reflector";
import { ROUTES } from "./routes";
import { isWalletPermitted, parseFreighterAddress } from "./wallet";
import {
  ACTIVE_VAULT,
  STOP_VAULT_VERSION,
  VAULTS,
  orderKey,
  orderTypeOf,
} from "./vaults";
import type { OrderType } from "./vaults";
import {
  cancelStopArgs,
  createStopArgs,
  executeStopArgs,
  fromPriceAtoms,
  toPriceAtoms,
  toStopConfig,
  toStopOrder,
  triggerStopArgs,
  type StopConfigView,
} from "./stopVault";
import type { PayoutSemantics } from "./vaults";
import { LandingPage } from "./pages/LandingPage";
import { AppBackground } from "./components/layout/AppBackground";
import { Footer } from "./components/layout/Footer";
import { Navbar } from "./components/layout/Navbar";
import { WalletControl } from "./components/layout/WalletControl";
import { AmountField } from "./components/ui/AmountField";
import { Button, IconButton } from "./components/ui/Button";
import { buttonStyles } from "./components/ui/buttonStyles";
import { Card, CardHeader, SectionLabel } from "./components/ui/Card";
import { EmptyState } from "./components/ui/EmptyState";
import { Modal } from "./components/ui/Modal";
import { Reveal } from "./components/ui/Reveal";
import { SectionHeading } from "./components/ui/SectionHeading";
import { Segmented } from "./components/ui/Segmented";
import { Stepper } from "./components/ui/Stepper";
import { Toast } from "./components/ui/Toast";
import type { Notice, NoticeType } from "./components/ui/Toast";
import { OrderCard } from "./components/vault/OrderCard";
import { TelemetryBar } from "./components/vault/TelemetryBar";
import { TokenSelector } from "./components/vault/TokenSelector";

const RPC_URL =
  import.meta.env.VITE_RPC_URL || "https://soroban-testnet.stellar.org";
const HORIZON_URL =
  (import.meta.env.VITE_HORIZON_URL as string | undefined)?.trim() ||
  "https://horizon-testnet.stellar.org";
const STROOPS_PER_XLM = 10_000_000;
/**
 * Reference dollar price of one XLM, used only to turn a dollar target into an
 * XLM quantity when buying. There is no price feed in this system — the router
 * is never quoted and the anchor prices USDC, not XLM — so this is a fixed
 * reference, not a market rate. The field's footnote states it for that reason:
 * an order priced off a stale constant should say so on its face.
 */
/**
 * Last-resort price for one XLM in USDC, used only until Reflector answers. It
 * is deliberately conservative to look at rather than plausible: a stale
 * constant that reads like a real quote is how an order gets priced off a
 * number nobody checked. The live feed read 0.1906 when this was written,
 * against the 0.2632 that used to sit here hardcoded.
 */
const FALLBACK_XLM_USDC = 0.19;
const NETWORK_PASSPHRASE = Networks.TESTNET;
const NATIVE_XLM_SAC =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
// The anchor's classic USDC balance is exposed to Soroban through this SAC.
const USDC_SAC =
  (import.meta.env.VITE_USDC_SAC_ID as string | undefined)?.trim() ||
  "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const usdcToken = new Contract(USDC_SAC);
const READ_ONLY_SOURCE =
  "GBICM7WA6FIVCFRCPM3ZIGNF5CZC5VRCU4IV4DJPQLWIALVQ6IN6OI6A";
const server = new rpc.Server(RPC_URL);
const EXPLORER_BASE = "https://stellar.expert/explorer/testnet";
const NETWORK_LABEL = "Stellar Testnet";

const CONSOLE_SECTIONS = [
  { id: "console", label: "Console" },
  { id: "orders", label: "Orders" },
] as const;

/**
 * `Active` is a limit order resting. `Armed` is a stop whose condition has not
 * been met, and `Triggered` is one whose fall was recorded on chain but which
 * has not sold yet. The two stop states are kept apart because they mean
 * different things to the person holding the order: one is waiting, the other
 * is already committed and waiting on liquidity.
 */
type OrderStatus = "Active" | "Armed" | "Triggered" | "Executed" | "Cancelled";
type OrderTab = "active" | "history";
type ActionTab = "order" | "ramp";
type TokenSymbol = "USDC" | "XLM";
type LifecycleState = "idle" | "running" | "complete" | "error";

const TOKEN_OPTIONS: ReadonlyArray<{
  symbol: TokenSymbol;
  name: string;
  glyph: string;
}> = [
  { symbol: "USDC", name: "Circle Testnet", glyph: "$" },
  { symbol: "XLM", name: "Stellar Lumens", glyph: "✦" },
];

const tokenContractId = (token: TokenSymbol): string =>
  token === "USDC" ? USDC_SAC : NATIVE_XLM_SAC;

/**
 * Why an order can never settle, or null when it can.
 *
 * Both sides have to be token *contracts* and they have to differ. Several
 * early orders on this deployment fail one of those: some carry the same asset
 * on both sides, and one carries an account address (strkey `G`) where a token
 * contract (strkey `C`) belongs — an empty shell variable at deploy time. They
 * are real on-chain state, so they are shown, but never as merely waiting.
 */
const unfillableReason = (tokenIn: string, tokenOut: string): string | null => {
  if (!tokenIn.startsWith("C") || !tokenOut.startsWith("C")) {
    return "One side of this order is an account address, not a token contract, so there is nothing to swap through.";
  }
  if (tokenIn === tokenOut) {
    return "Both sides of this order are the same asset. No such pool exists, so it can never settle.";
  }
  return null;
};

const tokenSymbolFromContract = (contractId: string): TokenSymbol | "TOKEN" =>
  contractId === USDC_SAC
    ? "USDC"
    : contractId === NATIVE_XLM_SAC
      ? "XLM"
      : "TOKEN";

/**
 * An order that still holds collateral, whichever kind it is.
 *
 * A stop is open both before and after its trigger fires: `Triggered` means the
 * fall was recorded, not that anything was sold. Filtering on `Active` alone
 * would drop every triggered stop out of the queue the moment it became the
 * most interesting order on the page.
 */
/**
 * What the wallet is about to be asked to sign, in the user's terms.
 *
 * Every stop action goes through this. A stop has two prices, a deadline and a
 * bounty, and three different calls that each mean something different to the
 * collateral — offering those to Freighter without restating them first is how
 * somebody signs the wrong one.
 */
interface PendingAction {
  title: string;
  intent: string;
  rows: ReadonlyArray<{ label: string; value: string; emphasis?: boolean }>;
  /** Shown above the confirm button when the call carries a caveat. */
  caveat?: string;
  confirmLabel: string;
  run: () => Promise<void>;
}

const isOpen = (order: { status: OrderStatus }): boolean =>
  order.status === "Active" ||
  order.status === "Armed" ||
  order.status === "Triggered";

interface OrderItem {
  id: number;
  /** Which deployment this order lives in. Ids restart at 1 in each. */
  vaultId: string;
  vaultLabel: string;
  semantics: PayoutSemantics;
  /** What instruction this order carries. */
  orderType: OrderType;
  /** Cancellable everywhere; only the accepting vault can still execute. */
  executable: boolean;
  /**
   * Stop orders only. The level the feed has to reach, at the oracle's own
   * scale, and the ledger time after which only cancellation is open. Both are
   * zero on a limit order, which has neither.
   */
  stopPrice: bigint;
  deadline: number;
  triggeredAt: number;
  owner: string;
  amountIn: number;
  minAmountOut: number;
  feeBps: number;
  status: OrderStatus;
  tokenIn: string;
  tokenOut: string;
  /**
   * When this terminal first observed the order. The vault does not store a
   * creation timestamp on chain, so orders that already existed when the page
   * loaded have none — showing a fabricated one would be a lie the table tells
   * on every render.
   */
  observedAt: string | null;
  txHash?: string;
}

interface Telemetry {
  latency: number | null;
  ledger: number | null;
  healthy: boolean;
  updatedAt: Date | null;
}

const WRONG_NETWORK_MESSAGE =
  "Please switch your Freighter wallet to the Testnet network.";
const WALLET_REAUTHORISE_MESSAGE =
  "Freighter has not authorised this site — it may have locked, or the permission was revoked. Connect again to continue.";
const SIGNATURE_REJECTED_MESSAGE =
  "Signature Rejected: Transaction rejected by wallet.";
const PENDING_CONFIRMATION_MESSAGE =
  "Transaction is still pending on the network. It may confirm shortly - refresh to check.";

const lifecycleLabels = [
  "Simulation",
  "Wallet Signature",
  "Network Submission",
  "Ledger Confirmation",
];

const shortAddress = (value: string, start = 6, end = 5): string =>
  value ? `${value.slice(0, start)}…${value.slice(-end)}` : "—";

const safeMessage = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : String(value);
  } catch {
    return String(value);
  }
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const toStroops = (value: string): bigint => {
  const normalizedValue = value.trim().replace(",", ".");
  if (!/^\d+(?:\.\d{0,7})?$/.test(normalizedValue)) {
    throw new Error("Invalid amount format");
  }
  const [whole = "0", fraction = ""] = normalizedValue.split(".");
  const normalizedFraction = `${fraction}0000000`.slice(0, 7);
  return BigInt(whole || "0") * 10_000_000n + BigInt(normalizedFraction);
};

const parseDecimal = (value: string): number => {
  const normalized = value.trim().replace(",", ".");
  if (!/^\d+(?:\.\d*)?$/.test(normalized)) return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};

async function simulateReadOn<T>(
  contractId: string,
  method: string,
  ...args: xdr.ScVal[]
): Promise<T> {
  const source = new Account(READ_ONLY_SOURCE, "0");
  const transaction = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
    throw new Error(`${method} simulation failed`);
  }
  return scValToNative(simulation.result.retval) as T;
}

/**
 * The order id the vault announced *in this transaction*, or null.
 *
 * `create_order` returns the id, but this RPC's `getTransaction` exposes no
 * decoded return value and the SDK pinned here cannot read a protocol-23
 * `TransactionMeta`. The contract's own `order`/`created` event carries it, and
 * an event is bound to the transaction that emitted it — which the newest order
 * in the vault is not: two orders placed on the same terms seconds apart are
 * indistinguishable that way, and that is exactly how orders 2 and 3 came to
 * exist on this deployment.
 *
 * Anything unrecognised — an RPC that omits the events, a shape this does not
 * know — returns null, and the order is reported without a number rather than
 * with a guessed one.
 *
 * `topic` names the first symbol the vault publishes under: the limit vault
 * says `order`, the stop vault says `stop`. It is a parameter rather than an
 * either-or so that a vault whose events this build has never seen falls
 * through to "no number" instead of matching something by accident.
 */
const createdOrderIdFrom = (
  result: RawTransactionStatus,
  vaultId: string,
  topic: string = "order",
): number | null => {
  const perOperation = (
    result.events as { contractEventsXdr?: unknown } | undefined
  )?.contractEventsXdr;
  if (!Array.isArray(perOperation)) return null;

  for (const operation of perOperation) {
    if (!Array.isArray(operation)) continue;
    for (const encoded of operation) {
      if (typeof encoded !== "string") continue;
      try {
        const event = xdr.ContractEvent.fromXDR(encoded, "base64");
        const contractId = event.contractId();
        if (!contractId || StrKey.encodeContract(contractId) !== vaultId) {
          continue;
        }
        const body = event.body().v0();
        const topics = body.topics().map((topic) => scValToNative(topic));
        if (topics[0] !== topic || topics[1] !== "created") continue;
        const data = scValToNative(body.data()) as unknown;
        const id = Array.isArray(data) ? Number(data[0]) : NaN;
        return Number.isSafeInteger(id) && id > 0 ? id : null;
      } catch {
        // An event this build cannot decode is not a failure: keep looking.
      }
    }
  }
  return null;
};

interface RawTransactionStatus {
  status: string;
  ledger?: number;
  [key: string]: unknown;
}

async function fetchTransactionStatus(
  hash: string,
): Promise<RawTransactionStatus | null> {
  // Soroban RPC expects a named parameter object; a transient network or RPC
  // hiccup must NOT be reported as a failed transaction, so callers keep
  // polling when this resolves to null.
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: { hash },
    }),
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as {
    result?: RawTransactionStatus;
    error?: unknown;
  };
  if (payload.error || !payload.result) return null;
  return payload.result;
}

async function waitForTransaction(hash: string): Promise<RawTransactionStatus> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    let result: RawTransactionStatus | null = null;
    try {
      result = await fetchTransactionStatus(hash);
    } catch {
      // Network error while polling: the transaction may still succeed, so
      // retry instead of declaring a failure the user will see contradicted.
      result = null;
    }
    if (result) {
      if (result.status === "SUCCESS") return result;
      if (result.status === "FAILED") {
        throw new Error(`Transaction failed on ledger: ${hash}`);
      }
      // NOT_FOUND, PENDING, TRY_AGAIN_LATER and any future status simply mean
      // the ledger has not closed on this transaction yet.
    }
    await delay(2_000);
  }
  // Timing out is not a failure: the transaction is still in flight.
  throw new Error(PENDING_CONFIRMATION_MESSAGE);
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the crash to the console for diagnostics without taking the
    // whole terminal down to a black screen.
    console.error("LumaFlow terminal render error:", error, info);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="grid min-h-screen place-items-center bg-canvas px-4">
        <div className="material w-full max-w-md rounded-xl p-6 shadow-modal">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-md border border-negative/35 bg-negative-soft text-negative-ink">
              <TriangleAlert className="size-5" strokeWidth={2} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 className="text-heading text-ink">The console stopped rendering</h1>
              <p className="mt-2 text-callout leading-relaxed text-ink-2">
                Your wallet session and on-chain orders are untouched — this is a
                display fault only. Restarting re-mounts the interface and
                re-reads the chain.
              </p>
            </div>
          </div>

          {this.state.error && (
            <pre className="well mt-4 max-h-32 overflow-auto rounded-md p-3 font-mono text-caption leading-relaxed text-negative-ink">
              {safeMessage(this.state.error)}
            </pre>
          )}

          <div className="mt-6 flex gap-2">
            <Button
              variant="primary"
              block
              onClick={this.handleReset}
              icon={<RotateCcw className="size-4" strokeWidth={2} aria-hidden="true" />}
            >
              Restart console
            </Button>
            <Button onClick={this.handleReload}>Hard reload</Button>
          </div>
        </div>
      </div>
    );
  }
}

function App() {
  const [actionTab, setActionTab] = useState<ActionTab>("order");
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [walletAddress, setWalletAddress] = useState("");
  const [walletConnecting, setWalletConnecting] = useState(false);
  const [walletBalance, setWalletBalance] = useState(0);
  const [usdcBalance, setUsdcBalance] = useState(0);
  // TRY per 1 USDC, published by the anchor's SEP-38 quote server. It is what
  // lets the order form talk in lira instead of asking the user to think in
  // stablecoin ratios.
  const [tryPerUsdc, setTryPerUsdc] = useState(0);
  const [oracle, setOracle] = useState<OracleQuote | null>(null);
  const [rateSource, setRateSource] = useState("");
  const [depositToken, setDepositToken] = useState<TokenSymbol>("USDC");
  const [targetToken, setTargetToken] = useState<TokenSymbol>("XLM");
  const [amountIn, setAmountIn] = useState("10");
  const [minAmountOut, setMinAmountOut] = useState("38");
  // `minAmountOut` stays the only figure that reaches the chain. This is how
  // the trigger is *said* — a rate or a total, in dollars or lira — so nobody
  // has to divide their way to the quantity.
  const [targetValue, setTargetValue] = useState("38");
  const [feeBps, setFeeBps] = useState("100");
  /** Which instruction the form is writing. Stop is offered only when a stop
   *  vault is configured, so the control cannot address a contract that is not
   *  there. */
  const [orderMode, setOrderMode] = useState<OrderType>("limit");
  /** The level the feed has to reach, in USDC per XLM. */
  const [stopTrigger, setStopTrigger] = useState("0.1700");
  /** What must reach the wallet if it sells, in USDC. */
  const [stopMinOut, setStopMinOut] = useState("0.9000");
  const [stopHours, setStopHours] = useState("24");
  /**
   * The stop vault's own `Config`, once it has answered.
   *
   * Null covers both "not deployed" and "not read yet". The form stays usable
   * either way: what this gates is the *pre-flight* check, and the contract
   * enforces the same cap regardless. Showing a size limit that was never read
   * would be worse than showing none.
   */
  const [stopConfig, setStopConfig] = useState<StopConfigView | null>(null);
  /** The action awaiting the signature summary the user has to read first. */
  const [pending, setPending] = useState<PendingAction | null>(null);
  /**
   * Ledger-ish wall clock, in seconds, ticked rather than read during render.
   *
   * A deadline that passes while the page sits open has to move the card into
   * its expired state on its own; reading the clock inside the render would
   * make that depend on some unrelated state change happening to arrive.
   */
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const [tab, setTab] = useState<OrderTab>("active");
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [telemetry, setTelemetry] = useState<Telemetry>({
    latency: null,
    ledger: null,
    healthy: false,
    updatedAt: null,
  });
  const [refreshing, setRefreshing] = useState(false);
  /** Deployments the RPC could not read this cycle, named rather than hidden. */
  const [unreadableVaults, setUnreadableVaults] = useState<string[]>([]);
  const [lifecycle, setLifecycle] = useState<LifecycleState>("idle");
  const [lifecycleStep, setLifecycleStep] = useState(-1);
  const [message, setMessage] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const noticeId = useRef(0);
  const operationLock = useRef(false);
  const observedAt = useRef(new Map<string, string>());
  const hasLoadedOrders = useRef(false);
  /** Whether the stop vault has already answered with its configuration. */
  const hasStopConfig = useRef(false);
  /**
   * The wallet a balance read was started for.
   *
   * Horizon and the RPC answer on their own schedule, so a read started for one
   * account can land after the wallet has already switched to another. Writing
   * it anyway would show account A's balance under account B's address — and
   * the Max button and the insufficient-funds check both read that number.
   */
  const balanceOwner = useRef("");

  const location = useLocation();
  const isConsole = location.pathname.startsWith(ROUTES.console);

  const showNotice = (
    type: NoticeType,
    title: unknown,
    detail: unknown,
    txHash?: string,
  ): void => {
    noticeId.current += 1;
    const id = noticeId.current;
    const nextTitle = safeMessage(title);
    const nextDetail = safeMessage(detail);
    setNotices((current) => {
      // Deduplicate: skip if an identical toast is already on screen.
      const isDuplicate = current.some(
        (item) => item.title === nextTitle && item.detail === nextDetail,
      );
      if (isDuplicate) return current;
      // Hard-limit to 3 concurrent toasts, discarding the oldest.
      return [
        ...current.slice(-2),
        { id, type, title: nextTitle, detail: nextDetail, txHash },
      ];
    });
    window.setTimeout(
      () => setNotices((current) => current.filter((item) => item.id !== id)),
      4_500,
    );
  };

  // The anchor is the only source of a TRY rate in this app; nothing here
  // invents a price.
  const handleAnchorRate = useCallback((rate: number, label: string): void => {
    setTryPerUsdc(rate);
    setRateSource(label);
  }, []);

  const numericAmount = parseDecimal(amountIn);
  const numericMinOut = parseDecimal(minAmountOut);
  const numericTarget = parseDecimal(targetValue);
  // Reflector when it is fresh, the fallback only until it answers. `stale`
  // is surfaced rather than silently tolerated: an order priced off a feed
  // that stopped publishing is the failure this whole path exists to avoid.
  const xlmUsdcRate =
    oracle && !oracle.stale && oracle.xlmPerUsdc > 0
      ? oracle.xlmPerUsdc
      : FALLBACK_XLM_USDC;
  const rateIsLive = Boolean(oracle && !oracle.stale && oracle.xlmPerUsdc > 0);
  const numericFeeBps = parseDecimal(feeBps);
  // execute_order swaps all collateral; the keeper receives this percentage
  // of the realized output. The output amount is unknown until execution.
  const keeperFeePercent = Number.isFinite(numericFeeBps)
    ? numericFeeBps / 100
    : 0;
  const rawEffectivePrice = numericAmount > 0 && numericMinOut > 0
    ? depositToken === "USDC"
      ? numericAmount / numericMinOut
      : numericMinOut / numericAmount
    : 0;
  const effectivePrice = Number.isFinite(rawEffectivePrice)
    ? rawEffectivePrice
    : 0;
  const triggerPriceTry = effectivePrice * tryPerUsdc;
  // What the user can actually commit: the XLM leg holds back one lumen for
  // the base reserve and fees, so the figure shown is never a promise the
  // network will refuse to keep.
  const spendableDepositBalance =
    depositToken === "XLM"
      ? Math.max(walletBalance - 1, 0)
      : usdcBalance;
  const tokenBalances: Record<TokenSymbol, number> = {
    USDC: usdcBalance,
    XLM: walletBalance,
  };
  const depositFiatValue = tryPerUsdc > 0
    ? depositToken === "USDC"
      ? `≈ ${(numericAmount * tryPerUsdc).toFixed(2)} TRY`
      : `≈ ${(numericAmount * triggerPriceTry).toFixed(2)} TRY at target`
    : undefined;
  const comparator = limitComparator(depositToken);

  // Both legs are typed in dollars: selling XLM sets the unit price one lumen
  // must reach, buying sets the total value that has to come back.
  const triggerIsPriceField = depositToken === "XLM";
  const triggerLabel = triggerIsPriceField
    ? "Target unit price (USD)"
    : "Total target to receive (USD)";

  // Keyed so a mode switch replaces the whole footnote instead of patching the
  // text nodes inside it. React's in-place text patching is what fails when
  // anything outside React has touched those nodes, and that failure surfaces
  // as "insertBefore ... not a child of this node".
  const triggerHint = (
    <span key={`footnote-${depositToken}`}>
      {triggerIsPriceField ? (
        <>
          Target unit price for 1 XLM in USD. Total output will settle for at
          least{" "}
          <span className="font-mono tnum text-ink-2">
            {(numericAmount * numericTarget).toFixed(2)}
          </span>{" "}
          USDC on-chain.
        </>
      ) : (
        <>
          Total target amount to receive in USD value. Settles for at least{" "}
          <span className="font-mono tnum text-ink-2">
            {(numericTarget / xlmUsdcRate).toFixed(2)}
          </span>{" "}
          XLM on-chain, valuing XLM at {xlmUsdcRate.toFixed(4)} USDC{" "}
          {rateIsLive ? "from Reflector" : "(fallback — feed unavailable)"}.
        </>
      )}
    </span>
  );

  const safeOrders = useMemo(
    () =>
      (Array.isArray(orders) ? orders : []).filter(
        (order): order is OrderItem =>
          Boolean(order) && typeof order === "object",
      ),
    [orders],
  );

  const visibleOrders = useMemo(
    () => safeOrders.filter((order) => (tab === "active" ? isOpen(order) : !isOpen(order))),
    [safeOrders, tab],
  );

  const activeValue = useMemo(
    () =>
      safeOrders
        .filter(
          (order) => isOpen(order) && tokenSymbolFromContract(order.tokenIn) === "USDC",
        )
        .reduce((total, order) => total + (Number(order.amountIn) || 0), 0),
    [safeOrders],
  );

  /** Reads one deployment. Throws so the caller can report it on its own. */
  const fetchVaultOrders = async (
    vault: (typeof VAULTS)[number],
  ): Promise<OrderItem[]> => {
    const count = await simulateReadOn<number>(vault.id, "get_order_count");
    if (!Number.isSafeInteger(count) || count < 0 || count > 10_000) {
      throw new Error(`Invalid on-chain order count: ${safeMessage(count)}`);
    }
    return Promise.all(
      Array.from({ length: count }, async (_, index) => {
        const raw = await simulateReadOn<Record<string, unknown>>(
          vault.id,
          "get_order",
          xdr.ScVal.scvU32(index + 1),
        );
        const type = orderTypeOf(vault);
        const accepting = vault.acceptingOrderTypes.length > 0;

        if (type === "stop") {
          const stop = toStopOrder(raw);
          if (!stop) {
            // A trigger this build does not understand. Show the order so its
            // owner can still reach it, and claim nothing about its condition.
            throw new Error(`Order #${index + 1} carries an unreadable trigger`);
          }
          return {
            id: stop.id,
            vaultId: vault.id,
            vaultLabel: vault.label,
            semantics: vault.payoutSemantics,
            orderType: type,
            executable: accepting,
            owner: stop.owner,
            tokenIn: stop.tokenIn,
            tokenOut: stop.tokenOut,
            amountIn: Number(stop.amountIn) / STROOPS_PER_XLM,
            minAmountOut: Number(stop.minUserOut) / STROOPS_PER_XLM,
            feeBps: stop.feeBps,
            status: stop.status,
            stopPrice: stop.stopPrice,
            deadline: stop.deadline,
            triggeredAt: stop.triggeredAt,
            observedAt: null,
          } satisfies OrderItem;
        }

        const status = Number(raw.status);
        // The net-floor build renamed the field; older deployments still store
        // the gross one. `semantics` is what says which promise it carries.
        const minimum = (raw.min_user_out ?? raw.min_amount_out) as bigint;
        return {
          id: Number(raw.id),
          vaultId: vault.id,
          vaultLabel: vault.label,
          semantics: vault.payoutSemantics,
          orderType: type,
          executable: accepting,
          owner: String(raw.owner),
          tokenIn: String(raw.token_in),
          tokenOut: String(raw.token_out),
          amountIn: Number(raw.amount_in as bigint) / STROOPS_PER_XLM,
          minAmountOut: Number(minimum) / STROOPS_PER_XLM,
          feeBps: Number(raw.fee_bps),
          status: status === 0 ? "Active" : status === 1 ? "Executed" : "Cancelled",
          stopPrice: 0n,
          deadline: 0,
          triggeredAt: 0,
          observedAt: null,
        } satisfies OrderItem;
      }),
    );
  };

  const fetchOrders = async (): Promise<void> => {
    // One deployment failing must not blank the others: a vault that cannot be
    // read is named as unreadable rather than silently dropping the orders —
    // and the collateral — it still holds.
    const results = await Promise.allSettled(VAULTS.map(fetchVaultOrders));

    const unreadable = VAULTS.filter(
      (_, index) => results[index].status === "rejected",
    ).map((vault) => vault.label);
    setUnreadableVaults(unreadable);

    if (unreadable.length === VAULTS.length) {
      throw new Error(
        results[0].status === "rejected"
          ? safeMessage(results[0].reason)
          : "No vault could be read",
      );
    }

    const liveOrders = results.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );

    // Record a real observation time for orders that appear while the terminal
    // is open; orders that predate this session stay honest about not knowing.
    const seenAt = new Date().toISOString();
    for (const order of liveOrders) {
      const key = orderKey(order.vaultId, order.id);
      if (hasLoadedOrders.current && !observedAt.current.has(key)) {
        observedAt.current.set(key, seenAt);
      }
    }
    hasLoadedOrders.current = true;
    setOrders(
      liveOrders
        .map((order) => ({
          ...order,
          observedAt: observedAt.current.get(orderKey(order.vaultId, order.id)) || null,
        }))
        .reverse(),
    );
  };

  const fetchTelemetry = async (): Promise<void> => {
    setRefreshing(true);
    const startedAt = performance.now();
    try {
      const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getLatestLedger",
        }),
      });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      const payload = (await response.json()) as {
        result?: { sequence?: number };
        error?: { message?: string };
      };
      if (!payload.result?.sequence) {
        throw new Error(payload.error?.message || "Invalid RPC response");
      }
      setTelemetry({
        latency: Math.round(performance.now() - startedAt),
        ledger: payload.result.sequence,
        healthy: true,
        updatedAt: new Date(),
      });
    } catch {
      setTelemetry((current) => ({
        ...current,
        latency: Math.round(performance.now() - startedAt),
        healthy: false,
        updatedAt: new Date(),
      }));
    } finally {
      setRefreshing(false);
    }
  };

  /**
   * Reads the stop vault's configuration once and keeps it.
   *
   * The cap, the pair and the policy scale have no setter, so re-reading them
   * every cycle would be a call that can only ever return the same answer.
   */
  const fetchStopConfig = async (): Promise<void> => {
    // The guard is a ref rather than the state itself: reading the state here
    // would make every caller of this re-created on each answer, and this is
    // called from the polling loop.
    if (!STOP_VAULT_VERSION || hasStopConfig.current) return;
    const raw = await simulateReadOn<Record<string, unknown>>(
      STOP_VAULT_VERSION.id,
      "get_config",
    );
    const config = toStopConfig(raw);
    if (!config) return;
    hasStopConfig.current = true;
    setStopConfig(config);
  };

  const refreshChain = async (): Promise<void> => {
    // Freeze background polling while a wallet operation is in flight so the
    // Freighter approval window and in-progress transaction state cannot be
    // clobbered by a racing fetchOrders / fetchTelemetry update.
    if (operationLock.current) return;
    setRefreshing(true);
    setMessage("");
    try {
      await Promise.all([
        fetchTelemetry(),
        fetchOrders(),
        // A failed or stale read must leave the last good quote alone rather
        // than snapping the form back to the fallback mid-edit.
        fetchOracleQuote(server)
          .then((quote) => {
            if (quote) setOracle(quote);
          })
          .catch(() => undefined),
        // Fixed at deployment and unchangeable, so one successful read is
        // enough — but a failed one must not clear what was already read.
        fetchStopConfig().catch(() => undefined),
      ]);
    } catch (error) {
      const detail = safeMessage(error) || "Chain refresh failed";
      setMessage(detail);
      showNotice("error", "Chain refresh failed", detail);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!isConsole) return;
    const tick = window.setInterval(
      () => setNowSeconds(Math.floor(Date.now() / 1000)),
      10_000,
    );
    return () => window.clearInterval(tick);
  }, [isConsole]);

  useEffect(() => {
    // The landing page renders no chain data, so polling the RPC every ten
    // seconds there would be pure cost — for the node as much as for us.
    if (!isConsole) return;
    const initialRefresh = window.setTimeout(() => void refreshChain(), 0);
    const timer = window.setInterval(() => void refreshChain(), 10_000);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(timer);
    };
  }, [isConsole]);

  useEffect(() => {
    const watcher = new WatchWalletChanges(2_000);
    const restoreWallet = window.setTimeout(() => {
      void (async () => {
        try {
          const manuallyDisconnected =
            window.localStorage.getItem("trigger_vault_disconnected") === "true";
          const savedAddress =
            window.localStorage.getItem("trigger_vault_wallet") || "";
          if (manuallyDisconnected || !savedAddress) return;
          const connection: unknown = await isConnected();
          const connected =
            typeof connection === "boolean"
              ? connection
              : Boolean(
                  (connection as { isConnected?: unknown } | null)?.isConnected,
                );
          if (!connected) return;

          // `isConnected` only says the extension exists. Whether *this origin*
          // may talk to it is a separate question, and the answer changes on its
          // own: the wallet locks on a timer, and permission is per-origin, so a
          // saved address survives a move to a new domain that was never granted
          // access. Asking is the difference between a session and a memory of
          // one.
          if (!isWalletPermitted(await isAllowed())) {
            // Leave the interface disconnected rather than showing an address the
            // wallet will refuse to sign for. Clearing the saved value keeps the
            // next reload honest too.
            window.localStorage.removeItem("trigger_vault_wallet");
            setWalletAddress("");
            return;
          }

          const result = await getPublicKey();
          if (result?.error) {
            window.localStorage.removeItem("trigger_vault_wallet");
            setWalletAddress("");
            return;
          }
          // Only what the wallet actually returned. Falling back to the saved
          // address here is what produced a console that looked connected and
          // then asked for authorisation at signing time.
          const address = parseFreighterAddress(result);
          if (!address) {
            window.localStorage.removeItem("trigger_vault_wallet");
            setWalletAddress("");
            return;
          }
          window.localStorage.setItem("trigger_vault_wallet", address);
          setWalletAddress(address);
        } catch {
          window.localStorage.removeItem("trigger_vault_wallet");
          setWalletAddress("");
        }
      })();
    }, 0);
    watcher.watch(({ address, error }) => {
      const manuallyDisconnected =
        window.localStorage.getItem("trigger_vault_disconnected") === "true";
      const hasSavedSession = Boolean(
        window.localStorage.getItem("trigger_vault_wallet"),
      );
      if (!manuallyDisconnected && hasSavedSession && !error && address) {
        window.localStorage.setItem("trigger_vault_wallet", address);
        setWalletAddress(address);
      }
    });
    return () => {
      window.clearTimeout(restoreWallet);
      watcher.stop();
    };
  }, []);

  const fetchWalletBalance = useCallback(async (address: string): Promise<number> => {
    const response = await fetch(`${HORIZON_URL}/accounts/${address}`);
    if (!response.ok) throw new Error("Wallet balance unavailable");
    const account = (await response.json()) as {
      balances: Array<{ asset_type: string; balance: string }>;
    };
    const balance = Number(
      account.balances.find((item) => item.asset_type === "native")?.balance || 0,
    );
    if (balanceOwner.current !== address) return balance;
    setWalletBalance(balance);
    return balance;
  }, []);

  const fetchUsdcBalance = useCallback(async (address: string): Promise<number> => {
    const source = new Account(READ_ONLY_SOURCE, "0");
    const transaction = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        usdcToken.call("balance", Address.fromString(address).toScVal()),
      )
      .setTimeout(30)
      .build();
    const simulation = await server.simulateTransaction(transaction);
    if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
      throw new Error("USDC balance unavailable");
    }
    const rawBalance = scValToNative(simulation.result.retval) as bigint | number;
    const balance = Number(rawBalance) / STROOPS_PER_XLM;
    if (!Number.isFinite(balance) || balance < 0) {
      throw new Error("USDC balance response was invalid");
    }
    if (balanceOwner.current !== address) return balance;
    setUsdcBalance(balance);
    return balance;
  }, []);

  const refreshBalances = useCallback(
    async (addressOverride?: string): Promise<void> => {
      const address = addressOverride || walletAddress;
      if (!address) {
        balanceOwner.current = "";
        setWalletBalance(0);
        setUsdcBalance(0);
        return;
      }
      // Claim this read before it starts: whichever read is claimed last is the
      // only one allowed to write, so a slow earlier account cannot win.
      balanceOwner.current = address;
      // Keep each balance independent: a transient Horizon failure must not
      // discard a valid SAC balance (or vice versa).
      await Promise.allSettled([
        fetchWalletBalance(address),
        fetchUsdcBalance(address),
      ]);
    },
    [fetchUsdcBalance, fetchWalletBalance, walletAddress],
  );

  useEffect(() => {
    const balanceRefresh = window.setTimeout(() => {
      void refreshBalances(walletAddress);
    }, 0);
    return () => window.clearTimeout(balanceRefresh);
  }, [actionTab, refreshBalances, walletAddress]);

  useEffect(() => {
    // Client-side navigation keeps the old scroll offset, which lands a fresh
    // route halfway down itself.
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [location.pathname]);

  const connectWallet = async (): Promise<void> => {
    setMessage("");
    setWalletConnecting(true);
    window.localStorage.removeItem("trigger_vault_disconnected");
    try {
      const access = await requestAccess();
      const address = parseFreighterAddress(access);
      if (typeof access === "object" && access !== null && "error" in access && access.error) {
        throw new Error(safeMessage(access.error) || "Wallet access was rejected.");
      }
      if (!address) throw new Error("Freighter did not return an account address");
      window.localStorage.setItem("trigger_vault_wallet", address);
      setWalletAddress(address);
      await refreshBalances(address);
      setConnectModalOpen(false);
      showNotice(
        "success",
        `Wallet Connected: ${shortAddress(address, 8, 6)}`,
        "Freighter connection is ready to use.",
      );
    } catch (error) {
      const detail = safeMessage(error) || "Wallet connection failed";
      setMessage(detail);
      showNotice("error", "Wallet Connection Failed", detail);
    } finally {
      setWalletConnecting(false);
    }
  };

  const disconnectWallet = (): void => {
    window.localStorage.setItem("trigger_vault_disconnected", "true");
    window.localStorage.removeItem("trigger_vault_wallet");
    setWalletAddress("");
    setWalletBalance(0);
    setUsdcBalance(0);
    showNotice("info", "Wallet Disconnected", "Freighter session removed from the terminal.");
  };

  // The trigger follows the direction, because each direction has one natural
  // way to be watched. Putting XLM in is a sale, watched as a price — "out at
  // 9.40". Putting dollars in buys XLM, and a dollar target on that leg would
  // need a price feed this system does not have, so it is watched as the
  // quantity that comes back.
  const triggerIsPrice = depositToken === "XLM";

  /** The typed trigger as the `min_amount_out` the contract is given. */
  const targetToMinOut = (value: string, amount: number): string | null => {
    const entered = parseDecimal(value);
    if (entered <= 0) return null;
    // Selling: a unit price against the lumens going in.
    if (triggerIsPrice) {
      if (amount <= 0) return null;
      const minOut = amount * entered;
      return Number.isFinite(minOut) && minOut > 0 ? minOut.toFixed(7) : null;
    }
    // Buying: a dollar target, divided by the reference into lumens. It does
    // not depend on the deposit — the target is the whole statement.
    const minOut = entered / xlmUsdcRate;
    return Number.isFinite(minOut) && minOut > 0 ? minOut.toFixed(7) : null;
  };

  const handleTargetValue = (value: string): void => {
    setTargetValue(value);
    const next = targetToMinOut(value, parseDecimal(amountIn));
    if (next) setMinAmountOut(next);
  };

  // A unit price scales with the deposit; a dollar target is the whole
  // statement on its own and has nothing to restate.
  const handleAmountIn = (value: string): void => {
    setAmountIn(value);
    if (!triggerIsPrice) return;
    const next = targetToMinOut(targetValue, parseDecimal(value));
    if (next) setMinAmountOut(next);
  };

  const flipPair = (): void => {
    setDepositToken(targetToken);
    setTargetToken(depositToken);
    setAmountIn(minAmountOut);
    setMinAmountOut(amountIn);
    // Reversing swaps what the trigger means. Selling wants the unit price the
    // pair already implies; buying wants the dollar value of the lumens that
    // would now come back.
    if (triggerIsPrice) {
      // Becoming the buy leg: `amountIn` is the XLM that will settle.
      const asUsd = parseDecimal(amountIn) * xlmUsdcRate;
      if (asUsd > 0) setTargetValue(asUsd.toFixed(2));
    } else if (effectivePrice > 0) {
      setTargetValue(effectivePrice.toFixed(7));
    }
  };

  const fillBalancePercentage = (percentage: number): void => {
    if (spendableDepositBalance <= 0) {
      setAmountIn("0.0000000");
      showNotice(
        "error",
        `No spendable ${depositToken}`,
        depositToken === "XLM"
          ? "Keep at least 1 XLM available for fees and the base reserve."
          : "Deposit TRY through the bank bridge before placing an order.",
      );
      return;
    }
    handleAmountIn(((spendableDepositBalance * percentage) / 100).toFixed(7));
  };

  // With two assets, naming the deposit leg is the same gesture as reversing
  // the pair, so the selector runs the flip rather than swapping one side and
  // leaving the amounts to imply a price nobody asked for.
  const selectDepositToken = (token: TokenSymbol): void => {
    if (token !== depositToken) flipPair();
  };

  const assertFreighterTestnet = async (): Promise<void> => {
    // Permission can lapse between connecting and signing — the wallet locks on
    // a timer, and the user can revoke this origin from Freighter itself. When
    // that happens the console should go back to saying "connect", not keep an
    // address on screen and surface a raw extension error at signing time.
    if (!isWalletPermitted(await isAllowed())) {
      window.localStorage.removeItem("trigger_vault_wallet");
      setWalletAddress("");
      setConnectModalOpen(true);
      throw new Error(WALLET_REAUTHORISE_MESSAGE);
    }
    const network = await getNetwork();
    if (network.error) {
      throw new Error(safeMessage(network.error));
    }
    const isTestnet =
      network.networkPassphrase === NETWORK_PASSPHRASE ||
      network.network.toUpperCase() === "TESTNET";
    if (!isTestnet) {
      showNotice("error", "Wrong Network", WRONG_NETWORK_MESSAGE);
      throw new Error(WRONG_NETWORK_MESSAGE);
    }
  };

  const submitContractOperation = async (
    contractId: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<{ hash: string; result: RawTransactionStatus }> => {
    setLifecycle("running");
    setLifecycleStep(0);
    await assertFreighterTestnet();
    const account = await server.getAccount(walletAddress);
    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(60)
      .build();

    showNotice("info", "Simulating", "Simulating Soroban transaction...");
    const simulation = await server.simulateTransaction(transaction);
    if (!rpc.Api.isSimulationSuccess(simulation)) {
      showNotice("error", "Simulation Failed", "Order did not satisfy on-chain rules or market conditions.");
      throw new Error(
        rpc.Api.isSimulationError(simulation)
          ? safeMessage(simulation.error)
          : `${method} simulation failed`,
      );
    }

    setLifecycleStep(1);
    showNotice("info", "Awaiting Signature", "Awaiting Freighter wallet signature...");
    const prepared = rpc.assembleTransaction(transaction, simulation).build();
    const signed = await signTransaction(prepared.toXDR(), {
      networkPassphrase: NETWORK_PASSPHRASE,
      address: walletAddress,
    });
    if (signed.error || !signed.signedTxXdr) {
      // Signal a user rejection; the caller's catch shows exactly one toast
      // and resets lifecycle to idle without retrying.
      throw new Error(SIGNATURE_REJECTED_MESSAGE);
    }

    setLifecycleStep(2);
    showNotice("info", "Broadcasting", "Broadcasting transaction to Stellar Testnet...");
    const signedTransaction = TransactionBuilder.fromXDR(
      signed.signedTxXdr,
      NETWORK_PASSPHRASE,
    );
    const submission = await server.sendTransaction(signedTransaction);
    if (submission.status !== "PENDING" && submission.status !== "DUPLICATE") {
      throw new Error(`Transaction submission failed: ${submission.status}`);
    }

    setLifecycleStep(3);
    showNotice("info", "Awaiting Confirmation", "Awaiting ledger confirmation (~5s)...");
    const result = await waitForTransaction(submission.hash);
    if (result.status !== "SUCCESS") {
      throw new Error(`Transaction failed: ${submission.hash}`);
    }
    // The confirmed result travels with the hash: it carries the contract's own
    // events, which is where a caller reads what the call decided.
    return { hash: submission.hash, result };
  };

  const submitOrder = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (operationLock.current) return;
    setMessage("");
    if (!walletAddress) {
      setConnectModalOpen(true);
      return;
    }
    if (numericAmount <= 0 || numericMinOut <= 0) {
      const detail = "Collateral and minimum output must be greater than zero.";
      setMessage(detail);
      showNotice("error", "Invalid Order Values", detail);
      return;
    }
    if (numericAmount > spendableDepositBalance) {
      const detail = `Insufficient collateral: Available balance is ${spendableDepositBalance.toFixed(7)} ${depositToken}.${depositToken === "XLM" ? " A 1 XLM reserve is excluded." : " Fund the wallet through the TRY bridge first."}`;
      setMessage(detail);
      showNotice("error", "Insufficient Collateral", detail);
      return;
    }
    if (walletBalance <= 1) {
      const detail =
        "At least 1 XLM must stay in the account to cover network fees and the base reserve.";
      setMessage(detail);
      showNotice("error", "Insufficient XLM for fees", detail);
      return;
    }
    if (!Number.isInteger(numericFeeBps) || numericFeeBps < 0 || numericFeeBps > 1_000) {
      const detail = "Keeper bounty cannot exceed 1,000 BPS (10.0%).";
      setMessage(detail);
      showNotice("error", "Invalid Keeper Bounty", detail);
      return;
    }

    const tokenIn = tokenContractId(depositToken);
    const tokenOut = tokenContractId(targetToken);
    if (!tokenIn) {
      const detail =
        "Collateral token contract is not configured (VITE_USDC_SAC_ID).";
      setMessage(detail);
      showNotice("error", "Collateral Token Missing", detail);
      return;
    }
    if (!tokenOut || tokenOut === tokenIn) {
      const detail = "Target token contract is not configured.";
      setMessage(detail);
      showNotice("error", "Output Token Missing", detail);
      return;
    }

    operationLock.current = true;
    try {
      const { hash, result } = await submitContractOperation(ACTIVE_VAULT.id, "create_order", [
        Address.fromString(walletAddress).toScVal(),
        Address.fromString(tokenIn).toScVal(),
        Address.fromString(tokenOut).toScVal(),
        nativeToScVal(toStroops(amountIn), { type: "i128" }),
        nativeToScVal(toStroops(minAmountOut), { type: "i128" }),
        xdr.ScVal.scvU32(numericFeeBps),
      ]);
      setLifecycle("complete");
      const createdId = createdOrderIdFrom(result, ACTIVE_VAULT.id);
      await Promise.all([fetchOrders(), refreshBalances(walletAddress)]);
      // Clear the whole trigger, not just the two derived fields. Leaving the
      // target price behind left the form looking half-filled and ready, which
      // is one keystroke away from placing the same order twice.
      setAmountIn("");
      setMinAmountOut("");
      setTargetValue("");
      // The number is how the order is addressed from here on — in the queue
      // below, and in the cancel or execute that closes it. Ids restart at 1 in
      // every deployment, so it is never shown without the vault it belongs to.
      const orderLabel =
        createdId === null
          ? "Your order"
          : `Order ${ACTIVE_VAULT.label}·#${createdId}`;
      setMessage(`${orderLabel} confirmed on ledger: ${hash}`);
      showNotice(
        "success",
        createdId === null
          ? "Order created on-chain"
          : `${orderLabel} created on-chain`,
        createdId === null
          ? "Confirmed on the Testnet ledger. Its number is in the queue below."
          : "Confirmed on the Testnet ledger — find it in the queue below.",
        hash,
      );
    } catch (error) {
      const detail = safeMessage(error) || "Order transaction failed";
      setMessage(detail);
      if (detail === SIGNATURE_REJECTED_MESSAGE) {
        // User rejected in Freighter: one clean toast, reset to idle, no retry.
        setLifecycle("idle");
        showNotice("error", "Signature Rejected", "Transaction rejected by wallet.");
      } else if (detail === PENDING_CONFIRMATION_MESSAGE) {
        // Confirmation polling timed out while the transaction is still in
        // flight. Never call this a failure: refresh and report it as pending.
        setLifecycle("idle");
        showNotice("info", "Confirmation Pending", detail);
        await Promise.all([fetchOrders(), refreshBalances(walletAddress)]);
      } else {
        setLifecycle("error");
        if (detail !== WRONG_NETWORK_MESSAGE) {
          showNotice("error", "Order Failed", detail);
        }
      }
    } finally {
      // Never leave the terminal locked in a perpetual "running" state, even if
      // Freighter is closed/rejected or an unexpected error escapes above.
      setLifecycle((current) => (current === "running" ? "error" : current));
      operationLock.current = false;
    }
  };

  // Takes the order rather than an id: ids repeat across deployments, and a
  // cancellation sent to the wrong vault would either fail or, worse, cancel a
  // different owner's order that happens to share the number.
  const cancelOrder = async (order: OrderItem): Promise<void> => {
    if (!walletAddress) {
      setConnectModalOpen(true);
      return;
    }
    if (operationLock.current) return;
    if (order.orderType === "stop") {
      requestStopCancel(order);
      return;
    }
    operationLock.current = true;
    setMessage("");
    const id = order.id;
    const reclaimed = order.amountIn;
    const reclaimedSymbol = tokenSymbolFromContract(order.tokenIn);
    try {
      const { hash } = await submitContractOperation(order.vaultId, "cancel_order", [
        xdr.ScVal.scvU32(id),
      ]);
      await Promise.all([fetchOrders(), refreshBalances(walletAddress)]);
      setLifecycle("complete");
      setMessage(
        `Cancellation confirmed: ${hash} | Reclaimed ${reclaimed.toFixed(7)} ${reclaimedSymbol}`,
      );
      showNotice(
        "success",
        `Order #${id} cancelled. Collateral reclaimed.`,
        `${reclaimed.toFixed(7)} ${reclaimedSymbol} returned to your wallet`,
        hash,
      );
    } catch (error) {
      const detail = safeMessage(error) || "Cancellation failed";
      setMessage(detail);
      if (detail === SIGNATURE_REJECTED_MESSAGE) {
        // User rejected in Freighter: one clean toast, reset to idle, no retry.
        setLifecycle("idle");
        showNotice("error", "Signature Rejected", "Transaction rejected by wallet.");
      } else if (detail === PENDING_CONFIRMATION_MESSAGE) {
        // Still in flight: report as pending and resync instead of failing.
        setLifecycle("idle");
        showNotice("info", "Confirmation Pending", detail);
        await Promise.all([fetchOrders(), refreshBalances(walletAddress)]);
      } else {
        setLifecycle("error");
        if (detail !== WRONG_NETWORK_MESSAGE) {
          showNotice("error", "Cancellation Failed", detail);
        }
      }
    } finally {
      // Never leave the terminal locked in a perpetual "running" state, even if
      // Freighter is closed/rejected or an unexpected error escapes above.
      setLifecycle((current) => (current === "running" ? "error" : current));
      operationLock.current = false;
    }
  };

  const executeOrder = async (order: OrderItem): Promise<void> => {
    if (!walletAddress) {
      setConnectModalOpen(true);
      return;
    }
    // Retired deployments are read-and-cancel. Their owners reclaim and place
    // again here; nothing settles against a version that is being wound down.
    if (!order.executable) return;
    if (operationLock.current) return;
    // A stop settles through its own entry point and carries its own summary:
    // the person pressing this is committing collateral to a sale at whatever
    // the pool gives above the floor, which deserves restating first.
    if (order.orderType === "stop") {
      requestSettlement(order);
      return;
    }
    operationLock.current = true;
    setMessage("");
    const id = order.id;
    try {
      const { hash } = await submitContractOperation(order.vaultId, "execute_order", [
        xdr.ScVal.scvU32(id),
        Address.fromString(walletAddress).toScVal(),
      ]);
      setLifecycle("complete");
      await Promise.all([fetchOrders(), refreshBalances(walletAddress)]);
      setMessage(`Order #${id} executed on ledger: ${hash}`);
      showNotice(
        "success",
        `Order #${id} executed`,
        "The swap settled atomically and the keeper reward was paid from realized output.",
        hash,
      );
    } catch (error) {
      const detail = safeMessage(error) || "Execution failed";
      setMessage(detail);
      if (detail === SIGNATURE_REJECTED_MESSAGE) {
        setLifecycle("idle");
        showNotice("error", "Signature Rejected", "Transaction rejected by wallet.");
      } else if (detail === PENDING_CONFIRMATION_MESSAGE) {
        setLifecycle("idle");
        showNotice("info", "Confirmation Pending", detail);
        await Promise.all([fetchOrders(), refreshBalances(walletAddress)]);
      } else {
        setLifecycle("error");
        if (detail !== WRONG_NETWORK_MESSAGE) {
          showNotice("error", "Execution Failed", detail);
        }
      }
    } finally {
      setLifecycle((current) => (current === "running" ? "error" : current));
      operationLock.current = false;
    }
  };

  /**
   * The one way this terminal reports a failed wallet operation.
   *
   * A rejected signature is not an error to retry, and a confirmation that
   * timed out is not a failure at all — the transaction may still be in
   * flight, so it resyncs and says so rather than telling the user something
   * did not happen when it may have.
   */
  const reportOperationFailure = async (
    error: unknown,
    failureTitle: string,
    fallback: string,
  ): Promise<void> => {
    const detail = safeMessage(error) || fallback;
    setMessage(detail);
    if (detail === SIGNATURE_REJECTED_MESSAGE) {
      setLifecycle("idle");
      showNotice("error", "Signature Rejected", "Transaction rejected by wallet.");
      return;
    }
    if (detail === PENDING_CONFIRMATION_MESSAGE) {
      setLifecycle("idle");
      showNotice("info", "Confirmation Pending", detail);
      if (walletAddress) {
        await Promise.all([fetchOrders(), refreshBalances(walletAddress)]);
      }
      return;
    }
    setLifecycle("error");
    if (detail !== WRONG_NETWORK_MESSAGE) {
      showNotice("error", failureTitle, detail);
    }
  };

  // ── stop orders ───────────────────────────────────────────────────────────

  const numericStopTrigger = parseDecimal(stopTrigger);
  const numericStopMinOut = parseDecimal(stopMinOut);
  const numericStopHours = parseDecimal(stopHours);
  const stopVault = STOP_VAULT_VERSION;

  /** Runs the action the summary described, once the user has read it. */
  const confirmPending = async (): Promise<void> => {
    const action = pending;
    if (!action) return;
    setPending(null);
    await action.run();
  };

  const submitStopOrder = (event: React.FormEvent): void => {
    event.preventDefault();
    if (operationLock.current || !stopVault) return;
    setMessage("");
    if (!walletAddress) {
      setConnectModalOpen(true);
      return;
    }
    if (numericAmount <= 0 || numericStopMinOut <= 0 || numericStopTrigger <= 0) {
      const detail =
        "Collateral, trigger price and minimum payout must all be greater than zero.";
      setMessage(detail);
      showNotice("error", "Invalid Stop Values", detail);
      return;
    }
    if (numericAmount > Math.max(walletBalance - 1, 0)) {
      const detail = `Insufficient collateral: ${Math.max(walletBalance - 1, 0).toFixed(7)} XLM is spendable. A 1 XLM reserve is excluded.`;
      setMessage(detail);
      showNotice("error", "Insufficient Collateral", detail);
      return;
    }
    if (!Number.isInteger(numericFeeBps) || numericFeeBps < 0 || numericFeeBps > 1_000) {
      const detail = "Keeper bounty cannot exceed 1,000 BPS (10.0%).";
      setMessage(detail);
      showNotice("error", "Invalid Keeper Bounty", detail);
      return;
    }
    if (!(numericStopHours > 0)) {
      const detail = "The order needs a deadline further out than now.";
      setMessage(detail);
      showNotice("error", "Invalid Deadline", detail);
      return;
    }

    let stopPriceAtoms: bigint;
    let minOutStroops: bigint;
    let amountStroops: bigint;
    try {
      stopPriceAtoms = toPriceAtoms(stopTrigger);
      minOutStroops = toStroops(stopMinOut);
      amountStroops = toStroops(amountIn);
    } catch {
      const detail = "Trigger price or minimum payout is not a number this vault can store.";
      setMessage(detail);
      showNotice("error", "Invalid Stop Values", detail);
      return;
    }

    // The vault caps a single order and refuses anything larger. The cap is
    // read from the contract rather than assumed, so this is only checked once
    // the vault has answered — but when it has, failing here costs nothing,
    // while failing on chain costs a fee and reports an error code.
    if (stopConfig && amountStroops > stopConfig.maxAmountIn) {
      const cap = Number(stopConfig.maxAmountIn) / STROOPS_PER_XLM;
      const detail = `This vault accepts at most ${cap.toFixed(7)} XLM in one order.`;
      setMessage(detail);
      showNotice("error", "Order Too Large", detail);
      return;
    }

    // A stop at or above the current feed price is not a stop: it would be
    // eligible to trigger on its first reading. The contract refuses it
    // (`StopNotBelowMarket`); saying so here lets the user re-decide against a
    // live number instead of against a failed signature. A stale or missing
    // quote is not treated as permission — the contract still has the final
    // say — but it is not treated as a refusal either.
    if (oracle && !oracle.stale && oracle.xlmPerUsdc > 0) {
      if (numericStopTrigger >= oracle.xlmPerUsdc) {
        const detail =
          `The feed reads ${oracle.xlmPerUsdc.toFixed(7)} USDC / XLM. A stop has to sit ` +
          `below the market, or it is a sell at today's price wearing a stop's name.`;
        setMessage(detail);
        showNotice("error", "Trigger Not Below Market", detail);
        return;
      }
    }

    // Read at submit time on purpose. A ticked clock could be a few seconds
    // behind, and a deadline computed from a stale one lands closer than the
    // user asked — or, for a short expiry, in the past, which the contract
    // rejects outright.
    // oxlint-disable-next-line react/purity
    const deadline = Math.floor(Date.now() / 1000) + Math.round(numericStopHours * 3600);
    const tokenIn = NATIVE_XLM_SAC;
    const tokenOut = USDC_SAC;

    setPending({
      title: "Create a stop order",
      intent:
        "The collateral moves into the vault now. Nothing is sold until the feed reaches your trigger.",
      rows: [
        { label: "Network", value: NETWORK_LABEL },
        { label: "Vault", value: `${stopVault.label} · ${shortAddress(stopVault.id, 8, 6)}` },
        { label: "Collateral", value: `${numericAmount.toFixed(7)} XLM` },
        { label: "Trigger at or below", value: `${numericStopTrigger} USDC / XLM`, emphasis: true },
        {
          label: "Feed reads now",
          value:
            oracle && !oracle.stale && oracle.xlmPerUsdc > 0
              ? `${oracle.xlmPerUsdc.toFixed(7)} USDC / XLM`
              : "unavailable — the vault will read it when you sign",
        },
        { label: "Minimum to your wallet", value: `${numericStopMinOut.toFixed(7)} USDC`, emphasis: true },
        { label: "Keeper bounty", value: `${numericFeeBps} BPS (${(numericFeeBps / 100).toFixed(2)}%)` },
        { label: "Deadline", value: new Date(deadline * 1000).toLocaleString() },
      ],
      caveat:
        "The trigger is recorded permanently. Once the feed has touched your level, the order stays sellable even if the price recovers — until you cancel it or the deadline passes. The minimum still has to be met.",
      confirmLabel: "Sign in Freighter",
      run: async () => {
        operationLock.current = true;
        try {
          const { hash, result } = await submitContractOperation(
            stopVault.id,
            "create_stop_order",
            createStopArgs({
              owner: walletAddress,
              tokenIn,
              tokenOut,
              amountIn: amountStroops,
              minUserOut: minOutStroops,
              feeBps: numericFeeBps,
              deadline,
              stopPrice: stopPriceAtoms,
            }),
          );
          setLifecycle("complete");
          const createdId = createdOrderIdFrom(result, stopVault.id, "stop");
          await Promise.all([fetchOrders(), refreshBalances(walletAddress)]);
          setAmountIn("");
          const label =
            createdId === null
              ? "Your stop order"
              : `Stop order ${stopVault.label}·#${createdId}`;
          setMessage(`${label} confirmed on ledger: ${hash}`);
          showNotice(
            "success",
            `${label} created on-chain`,
            "Armed. It will not sell until the feed reaches your trigger.",
            hash,
          );
        } catch (error) {
          reportOperationFailure(error, "Stop Order Failed", "Stop order failed");
        } finally {
          setLifecycle((current) => (current === "running" ? "error" : current));
          operationLock.current = false;
        }
      },
    });
  };

  const requestTrigger = (order: OrderItem): void => {
    if (!walletAddress) {
      setConnectModalOpen(true);
      return;
    }
    if (operationLock.current) return;
    setPending({
      title: `Record the fall on ${order.vaultLabel}·#${order.id}`,
      intent:
        "This writes the observation to the contract. It moves no funds and sells nothing.",
      rows: [
        { label: "Network", value: NETWORK_LABEL },
        { label: "Vault", value: `${order.vaultLabel} · ${shortAddress(order.vaultId, 8, 6)}` },
        { label: "Order", value: `#${order.id}` },
        { label: "Trigger level", value: `${fromPriceAtoms(order.stopPrice)} USDC / XLM`, emphasis: true },
        { label: "Collateral held", value: `${order.amountIn.toFixed(7)} XLM` },
        { label: "Payout if it sells", value: `at least ${order.minAmountOut.toFixed(7)} USDC` },
      ],
      caveat:
        "The contract reads the price itself and refuses this call if the level has not been reached. Recording it is permanent.",
      confirmLabel: "Sign in Freighter",
      run: async () => {
        operationLock.current = true;
        setMessage("");
        try {
          const { hash } = await submitContractOperation(
            order.vaultId,
            "trigger_stop",
            triggerStopArgs(order.id, walletAddress),
          );
          setLifecycle("complete");
          await Promise.all([fetchOrders(), refreshBalances(walletAddress)]);
          setMessage(`Order #${order.id} triggered on ledger: ${hash}`);
          showNotice(
            "success",
            `Order ${order.vaultLabel}·#${order.id} triggered`,
            "The fall is on chain. Settlement is a separate step and still has to meet your minimum.",
            hash,
          );
        } catch (error) {
          reportOperationFailure(error, "Trigger Failed", "Trigger failed");
        } finally {
          setLifecycle((current) => (current === "running" ? "error" : current));
          operationLock.current = false;
        }
      },
    });
  };

  const requestSettlement = (order: OrderItem): void => {
    if (!walletAddress) {
      setConnectModalOpen(true);
      return;
    }
    setPending({
      title: `Settle ${order.vaultLabel}·#${order.id}`,
      intent:
        "This sells the collateral through Soroswap. It reverts unless your minimum survives the bounty.",
      rows: [
        { label: "Network", value: NETWORK_LABEL },
        { label: "Vault", value: `${order.vaultLabel} · ${shortAddress(order.vaultId, 8, 6)}` },
        { label: "Order", value: `#${order.id}` },
        { label: "Selling", value: `${order.amountIn.toFixed(7)} XLM` },
        { label: "Minimum to the owner", value: `${order.minAmountOut.toFixed(7)} USDC`, emphasis: true },
        { label: "Keeper bounty", value: `${order.feeBps} BPS (${(order.feeBps / 100).toFixed(2)}%)` },
        { label: "Bounty paid to", value: shortAddress(walletAddress, 8, 6) },
      ],
      caveat:
        order.owner === walletAddress
          ? "You own this order and are also the executor, so the bounty and the net payout both land in this wallet. They are two separate transfers; the total is not the net."
          : undefined,
      confirmLabel: "Sign in Freighter",
      run: async () => {
        operationLock.current = true;
        setMessage("");
        try {
          const { hash } = await submitContractOperation(
            order.vaultId,
            "execute_stop",
            executeStopArgs(order.id, walletAddress),
          );
          setLifecycle("complete");
          await Promise.all([fetchOrders(), refreshBalances(walletAddress)]);
          setMessage(`Order #${order.id} settled on ledger: ${hash}`);
          showNotice(
            "success",
            `Order ${order.vaultLabel}·#${order.id} settled`,
            "The swap cleared your minimum and the bounty was paid from realised output.",
            hash,
          );
        } catch (error) {
          await reportOperationFailure(error, "Settlement Failed", "Settlement failed");
        } finally {
          setLifecycle((current) => (current === "running" ? "error" : current));
          operationLock.current = false;
        }
      },
    });
  };

  const requestStopCancel = (order: OrderItem): void => {
    if (!walletAddress) {
      setConnectModalOpen(true);
      return;
    }
    setPending({
      title: `Cancel ${order.vaultLabel}·#${order.id}`,
      intent: "The whole collateral returns to your wallet. Nothing is swapped.",
      rows: [
        { label: "Network", value: NETWORK_LABEL },
        { label: "Vault", value: `${order.vaultLabel} · ${shortAddress(order.vaultId, 8, 6)}` },
        { label: "Order", value: `#${order.id}` },
        { label: "Returned to you", value: `${order.amountIn.toFixed(7)} XLM`, emphasis: true },
        { label: "Status now", value: order.status },
      ],
      caveat:
        "Cancellation reads no price and calls no router, so it works even when the feed is down. The network fee is charged separately and is not taken out of the refund.",
      confirmLabel: "Sign in Freighter",
      run: async () => {
        operationLock.current = true;
        setMessage("");
        try {
          const { hash } = await submitContractOperation(
            order.vaultId,
            "cancel_order",
            cancelStopArgs(order.id),
          );
          setLifecycle("complete");
          await Promise.all([fetchOrders(), refreshBalances(walletAddress)]);
          setMessage(
            `Cancellation confirmed: ${hash} | Reclaimed ${order.amountIn.toFixed(7)} XLM`,
          );
          showNotice(
            "success",
            `Order ${order.vaultLabel}·#${order.id} cancelled`,
            `${order.amountIn.toFixed(7)} XLM returned to your wallet`,
            hash,
          );
        } catch (error) {
          await reportOperationFailure(error, "Cancellation Failed", "Cancellation failed");
        } finally {
          setLifecycle((current) => (current === "running" ? "error" : current));
          operationLock.current = false;
        }
      },
    });
  };

  const busy = lifecycle === "running";
  const connected = Boolean(walletAddress);
  const contractUrl = `${EXPLORER_BASE}/contract/${ACTIVE_VAULT.id}`;
  const activeCount = safeOrders.filter(isOpen).length;
  const historyCount = safeOrders.length - activeCount;
  const scrollToConsole = (): void => {
    document
      .getElementById("console")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const consoleView = (
    <main className="relative mx-auto max-w-7xl px-4 pt-28 sm:px-6 lg:px-8">
        <section aria-label="Network status">
          <Reveal>
            <TelemetryBar
              latency={telemetry.latency}
              ledger={telemetry.ledger}
              healthy={telemetry.healthy}
              updatedAt={telemetry.updatedAt}
              activeValue={activeValue}
              activeValueTry={tryPerUsdc > 0 ? activeValue * tryPerUsdc : null}
              contractId={ACTIVE_VAULT.id}
              contractUrl={contractUrl}
              contractLabel={shortAddress(ACTIVE_VAULT.id, 8, 6)}
              refreshing={refreshing}
              onRefresh={() => void refreshChain()}
            />
          </Reveal>
        </section>

        {/* ── Console ─────────────────────────────────────────────────────── */}
        <section id="console" className="pt-20">
          <SectionHeading
            eyebrow="Console"
            title="Place a trigger"
            description="Deposit collateral into the vault, or move lira across the anchor bridge. Both legs settle on Stellar Testnet."
          />

          <div className="mt-8 grid items-start gap-5 lg:grid-cols-[minmax(0,34rem)_minmax(0,1fr)]">
            <Reveal>
              <Card flush className="relative overflow-hidden">
                <div className="p-5 pb-0">
                  <Segmented
                    ariaLabel="Vault actions"
                    value={actionTab}
                    onChange={setActionTab}
                    options={[
                      {
                        id: "order",
                        label: "Limit order",
                        icon: <Zap className="size-3.5" strokeWidth={2} aria-hidden="true" />,
                      },
                      {
                        id: "ramp",
                        label: "TRY bridge",
                        icon: <Landmark className="size-3.5" strokeWidth={2} aria-hidden="true" />,
                      },
                    ]}
                  />
                </div>

                <div className="relative p-5">
                  <div
                    className={actionTab === "order" ? "block" : "hidden"}
                    aria-hidden={actionTab !== "order"}
                  >
                    {stopVault ? (
                      <Segmented
                        options={[
                          { id: "limit", label: "Limit" },
                          { id: "stop", label: "Stop-loss" },
                        ]}
                        value={orderMode}
                        onChange={setOrderMode}
                        ariaLabel="Order type"
                        size="sm"
                        className="mb-4"
                      />
                    ) : null}

                    {stopVault && orderMode === "stop" ? (
                      <form onSubmit={submitStopOrder} className="space-y-4">
                        <AmountField
                          label="You deposit"
                          value={amountIn}
                          onChange={setAmountIn}
                          disabled={busy}
                          unit="XLM"
                          aside={`Spendable ${Math.max(walletBalance - 1, 0).toFixed(2)} XLM`}
                          hint={
                            stopConfig ? (
                              <span>
                                This vault accepts at most{" "}
                                <span className="font-mono tnum text-ink-2">
                                  {(Number(stopConfig.maxAmountIn) / STROOPS_PER_XLM).toFixed(
                                    2,
                                  )}
                                </span>{" "}
                                XLM in one order — a cap fixed at deployment.
                              </span>
                            ) : undefined
                          }
                        />

                        <AmountField
                          label="Sell if the price falls to"
                          value={stopTrigger}
                          onChange={setStopTrigger}
                          disabled={busy}
                          unit="USDC / XLM"
                          hint={
                            <span>
                              Read from the Reflector price feed, not from the pool this
                              settles against. The two can differ.
                              {rateIsLive ? (
                                <>
                                  {" "}
                                  The feed reads{" "}
                                  <span className="font-mono tnum text-ink-2">
                                    {oracle?.xlmPerUsdc.toFixed(7)}
                                  </span>{" "}
                                  right now; a stop has to sit below it.
                                </>
                              ) : null}
                            </span>
                          }
                          invalid={
                            numericStopTrigger <= 0 ||
                            (rateIsLive && numericStopTrigger >= xlmUsdcRate)
                          }
                        />

                        <AmountField
                          label="Minimum that must reach your wallet"
                          value={stopMinOut}
                          onChange={setStopMinOut}
                          disabled={busy}
                          unit="USDC"
                          hint={
                            <span>
                              Checked after the keeper bounty. If a fill cannot clear it,
                              the sale is refused and the order stays triggered.
                            </span>
                          }
                          invalid={numericStopMinOut <= 0}
                        />

                        <div className="grid gap-3 sm:grid-cols-2">
                          <AmountField
                            label="Keeper bounty"
                            unit="BPS"
                            value={feeBps}
                            onChange={setFeeBps}
                            disabled={busy}
                            compact
                            invalid={
                              !Number.isInteger(numericFeeBps) ||
                              numericFeeBps < 0 ||
                              numericFeeBps > 1_000
                            }
                          />
                          <AmountField
                            label="Expires in"
                            unit="hours"
                            value={stopHours}
                            onChange={setStopHours}
                            disabled={busy}
                            compact
                            invalid={!(numericStopHours > 0)}
                          />
                        </div>

                        <Button
                          type="submit"
                          variant="primary"
                          size="lg"
                          block
                          loading={busy}
                          icon={<Zap className="size-4" strokeWidth={2} aria-hidden="true" />}
                        >
                          {busy ? "Settling on ledger" : "Create stop order"}
                        </Button>

                        <p className="text-center text-caption leading-relaxed text-ink-4">
                          The trigger is recorded permanently. Once the feed touches your
                          level the order stays sellable even if the price recovers, until
                          you cancel it or it expires.
                        </p>
                      </form>
                    ) : (
                    <form onSubmit={submitOrder} className="space-y-4">
                      <AmountField
                        label="You deposit"
                        value={amountIn}
                        onChange={handleAmountIn}
                        disabled={busy}
                        hint={depositFiatValue}
                        aside={`Spendable ${spendableDepositBalance.toFixed(2)} ${depositToken}`}
                        unitNode={
                          <TokenSelector
                            options={TOKEN_OPTIONS}
                            value={depositToken}
                            balances={tokenBalances}
                            disabled={busy}
                            onSelect={selectDepositToken}
                          />
                        }
                      />

                      <div className="grid grid-cols-3 gap-2">
                        {[25, 50, 100].map((percentage) => (
                          <Button
                            key={percentage}
                            size="sm"
                            disabled={busy}
                            onClick={() => fillBalancePercentage(percentage)}
                          >
                            {percentage === 100 ? "Max" : `${percentage}%`}
                          </Button>
                        ))}
                      </div>

                      <div className="relative flex justify-center py-1">
                        <span
                          aria-hidden="true"
                          className="rule-fade absolute inset-x-0 top-1/2 h-px -translate-y-1/2"
                        />
                        <IconButton
                          label={`Switch the pair to ${targetToken} for ${depositToken}`}
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          onClick={flipPair}
                          className="group relative z-10 rounded-full"
                        >
                          <ArrowDownUp
                            className="size-3.5 transition-transform duration-400 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:rotate-180"
                            strokeWidth={2}
                            aria-hidden="true"
                          />
                        </IconButton>
                      </div>

                      <AmountField
                        label={triggerLabel}
                        value={targetValue}
                        onChange={handleTargetValue}
                        disabled={busy}
                        hint={triggerHint}
                        unitNode={
                          <span className="rounded-full border border-line-strong bg-surface-2 px-3 py-1.5 text-footnote font-medium text-ink-2">
                            USDC
                          </span>
                        }
                      />

                      <div className="grid gap-3 sm:grid-cols-2">
                        <AmountField
                          label="Keeper bounty"
                          unit="BPS"
                          value={feeBps}
                          onChange={setFeeBps}
                          disabled={busy}
                          compact
                          invalid={
                            !Number.isInteger(numericFeeBps) ||
                            numericFeeBps < 0 ||
                            numericFeeBps > 1_000
                          }
                        />
                        <p className="self-end pb-1 text-footnote leading-relaxed text-ink-3">
                          Paid from realised output to whoever executes the order.
                          Up to 1,000 BPS (10%).
                        </p>
                      </div>

                      <Button
                        type="submit"
                        variant="primary"
                        size="lg"
                        block
                        loading={busy}
                        icon={<Zap className="size-4" strokeWidth={2} aria-hidden="true" />}
                      >
                        {busy ? "Settling on ledger" : "Create limit order"}
                      </Button>

                      <p className="text-center text-caption text-ink-4">
                        The minimum you accept is the on-chain guard — the swap
                        cannot settle below it.
                      </p>
                    </form>
                    )}
                  </div>

                  <div
                    className={actionTab === "ramp" ? "block" : "hidden"}
                    aria-hidden={actionTab !== "ramp"}
                  >
                    <AnchorPanel
                      walletAddress={walletAddress}
                      onRequireWallet={() => setConnectModalOpen(true)}
                      usdcBalance={usdcBalance}
                      refreshBalances={refreshBalances}
                      onRate={handleAnchorRate}
                      notify={showNotice}
                      onSettled={() => void refreshChain()}
                    />
                  </div>

                  {!connected ? (
                  <div
                    key="wallet-gate"
                    className="absolute inset-0 z-20 grid place-items-center bg-canvas/75 p-6 backdrop-blur-[3px]"
                  >
                    <button
                      type="button"
                      onClick={() => setConnectModalOpen(true)}
                      className="group max-w-xs text-center"
                    >
                      <Wallet
                        className="mx-auto size-5 text-ink-3 transition-colors group-hover:text-ink"
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                      <span className="mt-3 block text-subhead text-ink">
                        Connect a wallet to trade
                      </span>
                      <span className="mt-2 block text-footnote leading-relaxed text-ink-3">
                        Browsing the queue is open to everyone. Freighter is only
                        needed when something needs signing.
                      </span>
                    </button>
                  </div>
                  ) : null}
                </div>
              </Card>
            </Reveal>

            {/* Settlement preview */}
            <Reveal>
              <Card className="space-y-5">
                <CardHeader
                  icon={<Receipt className="size-4" strokeWidth={2} aria-hidden="true" />}
                  title="Settlement preview"
                  subtitle="What the contract holds, pays out and hands back."
                />

                <div className="border-t border-line pt-4">
                  <SectionLabel>Wallet</SectionLabel>
                  {connected ? (
                    <div className="mt-3 grid gap-5 sm:grid-cols-2">
                      <BalanceRow symbol="USDC" amount={usdcBalance} meta="Bridge + collateral" />
                      <BalanceRow
                        symbol="XLM"
                        amount={walletBalance}
                        meta="1 XLM held back for fees"
                      />
                    </div>
                  ) : (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                      <p className="text-footnote text-ink-3">
                        Connect Freighter to read balances and sign.
                      </p>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => setConnectModalOpen(true)}
                      >
                        Connect
                      </Button>
                    </div>
                  )}
                </div>

                {actionTab === "order" ? (
                  <div className="border-t border-line">
                    <ReceiptRow
                      label="Swap input"
                      value={`${numericAmount.toFixed(4)} ${depositToken}`}
                    />
                    <ReceiptRow
                      label="Minimum received"
                      value={`${numericMinOut.toFixed(4)} ${targetToken}`}
                    />
                    <ReceiptRow
                      label="Keeper reward"
                      value={`${keeperFeePercent.toFixed(2)}% of output`}
                    />
                    <ReceiptRow
                      label="Trigger price"
                      value={
                        effectivePrice > 0
                          ? `${comparator} ${formatUsdcPrice(effectivePrice)} USDC / XLM`
                          : "Set an amount and a target"
                      }
                      sub={
                        effectivePrice > 0 && tryPerUsdc > 0
                          ? `≈ ${triggerPriceTry.toFixed(2)} TRY / XLM`
                          : undefined
                      }
                      emphasis={effectivePrice > 0}
                      last
                    />
                  </div>
                ) : (
                  <div className="border-t border-line">
                    <ReceiptRow
                      label="Anchor rate"
                      value={
                        tryPerUsdc > 0
                          ? `1 USDC = ${tryPerUsdc.toFixed(4)} TRY`
                          : "Awaiting anchor rate"
                      }
                      emphasis={tryPerUsdc > 0}
                    />
                    <ReceiptRow label="Rails" value="SEP-6 deposit / withdraw" />
                    <ReceiptRow label="Bank leg" value="Simulated sandbox transfer" last />
                  </div>
                )}

                {rateSource ? (
                  <p className="text-caption leading-relaxed text-ink-4">{rateSource}</p>
                ) : null}

                <div>
                  <SectionLabel className="mb-4">Transaction lifecycle</SectionLabel>
                  <Stepper
                    steps={lifecycleLabels}
                    current={lifecycleStep}
                    complete={lifecycle === "complete"}
                    failed={lifecycle === "error"}
                  />
                </div>

                {message ? (
                  <div
                    key="order-message"
                    className={cn(
                      "flex items-start gap-2.5 rounded-md border p-3",
                      lifecycle === "error"
                        ? "border-negative/30 bg-negative-soft"
                        : "border-line bg-surface-2",
                    )}
                  >
                    {lifecycle === "error" ? (
                      <CircleAlert
                        className="mt-0.5 size-4 shrink-0 text-negative-ink"
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                    ) : (
                      <Info
                        className="mt-0.5 size-4 shrink-0 text-accent-ink"
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                    )}
                    <p className="min-w-0 break-words text-footnote leading-relaxed text-ink-2">
                      {message}
                    </p>
                  </div>
                ) : null}
              </Card>
            </Reveal>
          </div>
        </section>

        {/* ── Orders ──────────────────────────────────────────────────────── */}
        <section id="orders" className="pt-20">
          <SectionHeading
            eyebrow="Execution queue"
            title="Global orders"
            description={`Every resting and settled order across ${VAULTS.length} vault deployments, read straight from each contract.`}
            action={
              <a
                href={contractUrl}
                target="_blank"
                rel="noreferrer"
                className="group inline-flex items-center gap-1.5 text-footnote text-ink-3 transition-colors hover:text-accent-ink"
              >
                Open on Stellar Expert
                <ArrowUpRight
                  className="size-3.5 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                  strokeWidth={2.25}
                  aria-hidden="true"
                />
              </a>
            }
          />

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <Segmented
              ariaLabel="Order list"
              size="sm"
              value={tab}
              onChange={setTab}
              className="w-full max-w-xs"
              options={[
                { id: "active", label: `Active ${activeCount}` },
                { id: "history", label: `Settled ${historyCount}` },
              ]}
            />
            <Button
              size="sm"
              onClick={() => void refreshChain()}
              icon={
                <RefreshCw
                  className={cn("size-3.5", refreshing && "animate-spin")}
                  strokeWidth={2}
                  aria-hidden="true"
                />
              }
            >
              Refresh
            </Button>
          </div>

          {unreadableVaults.length > 0 ? (
            <p
              key="unreadable-vaults"
              className="mt-4 rounded-md border border-negative/35 bg-negative-soft px-3 py-2 text-footnote text-negative-ink"
            >
              {unreadableVaults.join(", ")} could not be read this cycle. Orders
              held there — including any collateral of yours — are missing from
              the list below, not settled or cancelled.
            </p>
          ) : null}

          {visibleOrders.length > 0 ? (
            <Reveal stagger className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {visibleOrders.map((order) => {
                const inputSymbol = tokenSymbolFromContract(order.tokenIn);
                const outputSymbol = tokenSymbolFromContract(order.tokenOut);
                const orderUsdcPerXlm =
                  order.amountIn > 0 && order.minAmountOut > 0
                    ? inputSymbol === "USDC"
                      ? order.amountIn / order.minAmountOut
                      : order.minAmountOut / order.amountIn
                    : 0;
                const orderTryPerXlm = orderUsdcPerXlm * tryPerUsdc;
                const collateralTry =
                  inputSymbol === "USDC"
                    ? order.amountIn * tryPerUsdc
                    : order.amountIn * orderTryPerXlm;
                return (
                  <OrderCard
                    key={orderKey(order.vaultId, order.id)}
                    id={order.id}
                    vaultLabel={order.vaultLabel}
                    semantics={order.semantics}
                    executable={order.executable}
                    owner={order.owner}
                    ownerLabel={shortAddress(order.owner, 8, 6)}
                    status={order.status}
                    inputSymbol={inputSymbol}
                    outputSymbol={outputSymbol}
                    amountIn={order.amountIn}
                    minAmountOut={order.minAmountOut}
                    feeBps={order.feeBps}
                    collateralTry={tryPerUsdc > 0 ? collateralTry : null}
                    triggerUsdc={orderUsdcPerXlm > 0 ? orderUsdcPerXlm : null}
                    triggerTry={
                      tryPerUsdc > 0 && order.minAmountOut > 0 ? orderTryPerXlm : null
                    }
                    unfillableReason={unfillableReason(order.tokenIn, order.tokenOut)}
                    isOwn={connected && order.owner === walletAddress}
                    canCancel={!connected || order.owner === walletAddress}
                    orderType={order.orderType}
                    stopPriceLabel={
                      order.orderType === "stop" ? fromPriceAtoms(order.stopPrice) : null
                    }
                    deadlineLabel={
                      order.orderType === "stop" && order.deadline > 0
                        ? new Date(order.deadline * 1000).toLocaleString()
                        : null
                    }
                    expired={
                      order.orderType === "stop" &&
                      order.deadline > 0 &&
                      nowSeconds >= order.deadline
                    }
                    busy={busy}
                    onCancel={() => void cancelOrder(order)}
                    onExecute={() => void executeOrder(order)}
                    onTrigger={() => requestTrigger(order)}
                  />
                );
              })}
            </Reveal>
          ) : (
            <div className="mt-5">
              {tab === "history" ? (
                <EmptyState
                  key="empty-history"
                  icon={<ListChecks className="size-5" strokeWidth={1.75} aria-hidden="true" />}
                  title="Nothing has settled yet"
                  description="Executed and cancelled orders land here with the ledger transaction that closed them."
                />
              ) : (
                <EmptyState
                  key="empty-active"
                  icon={<Timer className="size-5" strokeWidth={1.75} aria-hidden="true" />}
                  title="No orders resting"
                  description="Create a limit order and it will appear here for keepers to pick up."
                  action={
                    <Button variant="primary" size="sm" onClick={scrollToConsole}>
                      Open the console
                    </Button>
                  }
                />
              )}
            </div>
          )}
        </section>

    </main>
  );

  return (
    <div id="top" className="notranslate relative min-h-screen" translate="no">
      <AppBackground />

      <Navbar
        key={location.pathname}
        sections={isConsole ? CONSOLE_SECTIONS : undefined}
        status={
          isConsole
            ? {
                ledger: telemetry.ledger,
                healthy: telemetry.healthy,
                label: NETWORK_LABEL,
              }
            : undefined
        }
        right={
          isConsole ? (
            <WalletControl
              address={walletAddress}
              connecting={walletConnecting}
              onConnect={() => void connectWallet()}
              onDisconnect={disconnectWallet}
              explorerBaseUrl={EXPLORER_BASE}
              shortAddress={(value) => shortAddress(value, 4, 4)}
            />
          ) : (
            <Link to={ROUTES.console} className={buttonStyles({ variant: "primary" })}>
              Open the console
            </Link>
          )
        }
      />

      {/* Toast rail sits clear of the condensed navbar so a notification never
          lands on top of the wallet control. */}
      <div className="pointer-events-none fixed inset-x-4 top-[5.5rem] z-70 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6">
        {notices.map((notice) => (
          <div key={notice.id} className="pointer-events-auto w-full sm:w-96">
            <Toast
              notice={notice}
              explorerBaseUrl={EXPLORER_BASE}
              onClose={() =>
                setNotices((current) => current.filter((item) => item.id !== notice.id))
              }
            />
          </div>
        ))}
      </div>

      <Routes>
        <Route path={ROUTES.landing} element={<LandingPage contractUrl={contractUrl} />} />
        <Route path={ROUTES.console} element={consoleView} />
        {/* Anything else is a mistyped URL, not a page. */}
        <Route path="*" element={<Navigate to={ROUTES.landing} replace />} />
      </Routes>

      <Footer
        contractId={ACTIVE_VAULT.id}
        contractUrl={contractUrl}
        networkLabel={NETWORK_LABEL}
        shortAddress={(value) => shortAddress(value, 8, 6)}
      />

      {/*
        Every stop action restates itself before the wallet opens. Freighter
        shows a contract address and an encoded call; this shows what the call
        does to the collateral, which is the part the person is actually
        deciding about.
      */}
      <Modal
        open={pending !== null}
        onClose={() => setPending(null)}
        title={pending?.title ?? "Confirm"}
        description={pending?.intent}
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button size="sm" onClick={() => setPending(null)} disabled={busy}>
              Back
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => void confirmPending()}
              loading={busy}
            >
              {pending?.confirmLabel ?? "Sign in Freighter"}
            </Button>
          </div>
        }
      >
        {pending ? (
          <div className="space-y-4">
            <dl className="divide-y divide-line rounded-md border border-line">
              {pending.rows.map((row) => (
                <div
                  key={row.label}
                  className="flex items-baseline justify-between gap-4 px-3 py-2.5"
                >
                  <dt className="shrink-0 text-footnote text-ink-3">{row.label}</dt>
                  <dd
                    className={cn(
                      "min-w-0 truncate text-right font-mono text-footnote tnum",
                      row.emphasis ? "text-ink" : "text-ink-2",
                    )}
                  >
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
            {pending.caveat ? (
              <p className="rounded-md border border-line bg-surface-2 p-3 text-caption leading-relaxed text-ink-3">
                {pending.caveat}
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={connectModalOpen}
        onClose={() => setConnectModalOpen(false)}
        title="Connect Freighter"
        description="LumaFlow never holds your keys. Freighter signs every order, cancellation and bridge payment locally."
      >
        <ul className="space-y-3 border-t border-line pt-5">
          {[
            { icon: ShieldCheck, text: "Collateral stays in the vault contract, never with us." },
            { icon: Landmark, text: "Lira legs run over the anchor's SEP-6 rails." },
            { icon: Coins, text: "Stellar Testnet only — no mainnet value is at risk." },
          ].map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-start gap-3">
              <Icon
                className="mt-0.5 size-4 shrink-0 text-accent-ink"
                strokeWidth={2}
                aria-hidden="true"
              />
              <span className="text-footnote leading-relaxed text-ink-2">{text}</span>
            </li>
          ))}
        </ul>

        <Button
          variant="primary"
          size="lg"
          block
          className="mt-5"
          loading={walletConnecting}
          onClick={() => void connectWallet()}
          icon={<Wallet className="size-4" strokeWidth={2} aria-hidden="true" />}
        >
          {walletConnecting ? "Waiting for Freighter" : "Connect wallet"}
        </Button>

        <p className="mt-3 text-center text-caption uppercase text-ink-4">
          {NETWORK_LABEL} · non-custodial
        </p>
      </Modal>
    </div>
  );
}

function BalanceRow({
  symbol,
  amount,
  meta,
}: {
  symbol: string;
  amount: number;
  meta: string;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-caption uppercase text-ink-4">
        <Coins className="size-3" strokeWidth={2} aria-hidden="true" />
        {symbol}
      </div>
      <p className="mt-1 truncate font-mono text-subhead tnum text-ink">
        {amount.toFixed(2)}
      </p>
      <p className="mt-0.5 truncate text-caption text-ink-4">{meta}</p>
    </div>
  );
}

function ReceiptRow({
  label,
  value,
  sub,
  emphasis = false,
  last = false,
}: {
  label: string;
  value: string;
  sub?: string;
  emphasis?: boolean;
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 py-2.5",
        !last && "border-b border-line",
      )}
    >
      <span className="shrink-0 text-footnote text-ink-3">{label}</span>
      <span className="flex min-w-0 flex-col items-end">
        <span
          className={cn(
            "min-w-0 truncate text-right font-mono text-footnote tnum",
            emphasis ? "text-accent-ink" : "text-ink",
          )}
        >
          {value}
        </span>
        {sub ? (
          <span className="min-w-0 truncate text-right font-mono text-caption tnum text-ink-4">
            {sub}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export default function AppWithBoundary() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  );
}
