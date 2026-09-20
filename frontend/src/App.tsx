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
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { cn } from "./lib/cn";
import { formatUsdcPrice, limitComparator } from "./lib/price";
import { ROUTES } from "./routes";
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

const CONTRACT_ID =
  import.meta.env.VITE_VAULT_CONTRACT_ID ||
  "CDVJV6SITYH2A4CNTG4YG5CDYDRM5ABTDIBA3UVBLXFQNE6FWK3BNTWD";
const RPC_URL =
  import.meta.env.VITE_RPC_URL || "https://soroban-testnet.stellar.org";
const HORIZON_URL =
  (import.meta.env.VITE_HORIZON_URL as string | undefined)?.trim() ||
  "https://horizon-testnet.stellar.org";
const STROOPS_PER_XLM = 10_000_000;
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
const vault = new Contract(CONTRACT_ID);
const EXPLORER_BASE = "https://stellar.expert/explorer/testnet";
const NETWORK_LABEL = "Stellar Testnet";

const CONSOLE_SECTIONS = [
  { id: "console", label: "Console" },
  { id: "orders", label: "Orders" },
] as const;

type OrderStatus = "Active" | "Executed" | "Cancelled";
type OrderTab = "active" | "history";
type ActionTab = "order" | "ramp";
type TokenSymbol = "USDC" | "XLM";
type PriceUnit = "USDC" | "TRY";
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

interface OrderItem {
  id: number;
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
const SIGNATURE_REJECTED_MESSAGE =
  "Signature Rejected: Transaction rejected by wallet.";
const PENDING_CONFIRMATION_MESSAGE =
  "Transaction is still pending on the network. It may confirm shortly - refresh to check.";

const parseFreighterAddress = (result: unknown): string => {
  if (typeof result === "string") return result;
  if (typeof result !== "object" || result === null) return "";
  const value = result as { address?: unknown; publicKey?: unknown };
  if (typeof value.address === "string") return value.address;
  if (typeof value.publicKey === "string") return value.publicKey;
  return "";
};

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

async function simulateRead<T>(method: string, ...args: xdr.ScVal[]): Promise<T> {
  const source = new Account(READ_ONLY_SOURCE, "0");
  const transaction = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(vault.call(method, ...args))
    .setTimeout(30)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
    throw new Error(`${method} simulation failed`);
  }
  return scValToNative(simulation.result.retval) as T;
}

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
    console.error("TriggerVault terminal render error:", error, info);
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
  const [rateSource, setRateSource] = useState("");
  const [depositToken, setDepositToken] = useState<TokenSymbol>("USDC");
  const [targetToken, setTargetToken] = useState<TokenSymbol>("XLM");
  const [amountIn, setAmountIn] = useState("10");
  const [minAmountOut, setMinAmountOut] = useState("38");
  // A limit order is a price, but the contract is given a quantity. The two
  // fields are the same statement said two ways: `minAmountOut` stays the only
  // figure that reaches the chain, and this one exists so nobody has to divide
  // their way to it.
  const [limitPrice, setLimitPrice] = useState((10 / 38).toFixed(7));
  const [priceUnit, setPriceUnit] = useState<PriceUnit>("USDC");
  const [feeBps, setFeeBps] = useState("100");
  const [tab, setTab] = useState<OrderTab>("active");
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [telemetry, setTelemetry] = useState<Telemetry>({
    latency: null,
    ledger: null,
    healthy: false,
    updatedAt: null,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [lifecycle, setLifecycle] = useState<LifecycleState>("idle");
  const [lifecycleStep, setLifecycleStep] = useState(-1);
  const [message, setMessage] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const noticeId = useRef(0);
  const operationLock = useRef(false);
  const observedAt = useRef(new Map<number, string>());
  const hasLoadedOrders = useRef(false);

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
  // The limit is denominated in the target asset, but the collateral is priced
  // in dollars — quoting only TRY leaves the user converting USDC → XLM by
  // hand. `effectivePrice` is already USDC per XLM in both directions.
  //
  // Stated as a bare unit price this reads backwards: raising the minimum is
  // asking for a better rate, so the figure falls, which looks like the
  // position shrinking. Phrasing it as the fill condition makes the direction
  // the point rather than a surprise.
  const targetFiatValue = effectivePrice > 0
    ? `Fills when 1 XLM ${comparator} ${formatUsdcPrice(effectivePrice)} USDC`
    : undefined;
  // The price field states the limit in one unit; the hint carries the other,
  // so neither reading has to be worked out on paper.
  const priceHint =
    effectivePrice <= 0
      ? undefined
      : priceUnit === "USDC"
        ? tryPerUsdc > 0
          ? `≈ ${triggerPriceTry.toFixed(4)} TRY / XLM`
          : undefined
        : `≈ ${formatUsdcPrice(effectivePrice)} USDC / XLM`;

  const safeOrders = useMemo(
    () =>
      (Array.isArray(orders) ? orders : []).filter(
        (order): order is OrderItem =>
          Boolean(order) && typeof order === "object",
      ),
    [orders],
  );

  const visibleOrders = useMemo(
    () =>
      safeOrders.filter((order) =>
        tab === "active" ? order.status === "Active" : order.status !== "Active",
      ),
    [safeOrders, tab],
  );

  const activeValue = useMemo(
    () =>
      safeOrders
        .filter(
          (order) =>
            order.status === "Active" &&
            tokenSymbolFromContract(order.tokenIn) === "USDC",
        )
        .reduce((total, order) => total + (Number(order.amountIn) || 0), 0),
    [safeOrders],
  );

  const fetchOrders = async (): Promise<void> => {
    const count = await simulateRead<number>("get_order_count");
    if (!Number.isSafeInteger(count) || count < 0 || count > 10_000) {
      throw new Error(`Invalid on-chain order count: ${safeMessage(count)}`);
    }
    const liveOrders = await Promise.all(
      Array.from({ length: count }, async (_, index) => {
        const raw = await simulateRead<Record<string, unknown>>(
          "get_order",
          xdr.ScVal.scvU32(index + 1),
        );
        const status = Number(raw.status);
        return {
          id: Number(raw.id),
          owner: String(raw.owner),
          tokenIn: String(raw.token_in),
          tokenOut: String(raw.token_out),
          amountIn: Number(raw.amount_in as bigint) / STROOPS_PER_XLM,
          minAmountOut: Number(raw.min_amount_out as bigint) / STROOPS_PER_XLM,
          feeBps: Number(raw.fee_bps),
          status: status === 0 ? "Active" : status === 1 ? "Executed" : "Cancelled",
          observedAt: null,
        } satisfies OrderItem;
      }),
    );
    // Record a real observation time for orders that appear while the terminal
    // is open; orders that predate this session stay honest about not knowing.
    const seenAt = new Date().toISOString();
    for (const order of liveOrders) {
      if (hasLoadedOrders.current && !observedAt.current.has(order.id)) {
        observedAt.current.set(order.id, seenAt);
      }
    }
    hasLoadedOrders.current = true;
    setOrders(
      liveOrders
        .map((order) => ({
          ...order,
          observedAt: observedAt.current.get(order.id) || null,
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

  const refreshChain = async (): Promise<void> => {
    // Freeze background polling while a wallet operation is in flight so the
    // Freighter approval window and in-progress transaction state cannot be
    // clobbered by a racing fetchOrders / fetchTelemetry update.
    if (operationLock.current) return;
    setRefreshing(true);
    setMessage("");
    try {
      await Promise.all([fetchTelemetry(), fetchOrders()]);
    } catch (error) {
      const detail = safeMessage(error) || "Chain refresh failed";
      setMessage(detail);
      showNotice("error", "Chain refresh failed", detail);
    } finally {
      setRefreshing(false);
    }
  };

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
          const result: unknown = await getPublicKey();
          const address = parseFreighterAddress(result) || savedAddress;
          if (!address) return;
          window.localStorage.setItem("trigger_vault_wallet", address);
          setWalletAddress(address);
        } catch {
          window.localStorage.removeItem("trigger_vault_wallet");
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
    setUsdcBalance(balance);
    return balance;
  }, []);

  const refreshBalances = useCallback(
    async (addressOverride?: string): Promise<void> => {
      const address = addressOverride || walletAddress;
      if (!address) {
        setWalletBalance(0);
        setUsdcBalance(0);
        return;
      }
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
    const nextAmount = (spendableDepositBalance * percentage) / 100;
    setAmountIn(nextAmount.toFixed(7));
    // Resizing the order is not repricing it. Scaling the input alone would
    // drag the limit with it — "Max" on a 10 → 38 order would leave the same
    // 38 against a far larger deposit, demanding a wildly different price.
    if (numericAmount > 0 && numericMinOut > 0) {
      setMinAmountOut(((numericMinOut * nextAmount) / numericAmount).toFixed(7));
    }
  };

  // Price is carried in whichever unit the field is showing; these two put it
  // back into the USDC-per-XLM the rest of the console reasons in.
  const priceToUsdcPerXlm = (value: string): number => {
    const entered = parseDecimal(value);
    if (entered <= 0) return 0;
    if (priceUnit === "USDC") return entered;
    return tryPerUsdc > 0 ? entered / tryPerUsdc : 0;
  };

  const usdcPerXlmToPrice = (usdcPerXlm: number): string =>
    priceUnit === "USDC"
      ? usdcPerXlm.toFixed(7)
      : (usdcPerXlm * tryPerUsdc).toFixed(4);

  const minOutFor = (usdcPerXlm: number, amount: number): string =>
    depositToken === "USDC"
      ? (amount / usdcPerXlm).toFixed(7)
      : (amount * usdcPerXlm).toFixed(7);

  // Each handler writes the *other* field outright. Nothing derives a field
  // that derives it back, so the pair cannot chase each other's rounding.
  const handleAmountIn = (value: string): void => {
    setAmountIn(value);
    const amount = parseDecimal(value);
    const price = priceToUsdcPerXlm(limitPrice);
    if (amount > 0 && price > 0) setMinAmountOut(minOutFor(price, amount));
  };

  const handleMinAmountOut = (value: string): void => {
    setMinAmountOut(value);
    const minOut = parseDecimal(value);
    const amount = parseDecimal(amountIn);
    if (minOut <= 0 || amount <= 0) return;
    setLimitPrice(
      usdcPerXlmToPrice(
        depositToken === "USDC" ? amount / minOut : minOut / amount,
      ),
    );
  };

  const handleLimitPrice = (value: string): void => {
    setLimitPrice(value);
    const price = priceToUsdcPerXlm(value);
    const amount = parseDecimal(amountIn);
    if (price > 0 && amount > 0) setMinAmountOut(minOutFor(price, amount));
  };

  // Switching units restates the same limit, so the quantity must not move.
  // Restating works off the amounts rather than the string in the box: lira is
  // shown to four places, and converting that back would let a display rounding
  // become the new price.
  const togglePriceUnit = (): void => {
    const next: PriceUnit = priceUnit === "USDC" ? "TRY" : "USDC";
    // The amounts are the exact statement of the limit, so restate from them.
    // A half-filled form has none, and then the box itself is all there is —
    // without that fallback the pill would relabel a number it never converted,
    // leaving dollars sitting under a lira heading.
    const usdcPerXlm =
      effectivePrice > 0 ? effectivePrice : priceToUsdcPerXlm(limitPrice);
    if (usdcPerXlm > 0) {
      setLimitPrice(
        next === "TRY"
          ? (usdcPerXlm * tryPerUsdc).toFixed(4)
          : usdcPerXlm.toFixed(7),
      );
    }
    setPriceUnit(next);
  };

  const flipPair = (): void => {
    setDepositToken(targetToken);
    setTargetToken(depositToken);
    setAmountIn(minAmountOut);
    setMinAmountOut(amountIn);
  };

  // With two assets, naming either leg is the same gesture as reversing the
  // pair, so both selectors run the flip rather than swapping one side and
  // leaving the amounts to imply a price nobody asked for.
  const selectDepositToken = (token: TokenSymbol): void => {
    if (token !== depositToken) flipPair();
  };

  const selectTargetToken = (token: TokenSymbol): void => {
    if (token !== targetToken) flipPair();
  };

  const assertFreighterTestnet = async (): Promise<void> => {
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
    method: string,
    args: xdr.ScVal[],
  ): Promise<string> => {
    setLifecycle("running");
    setLifecycleStep(0);
    await assertFreighterTestnet();
    const account = await server.getAccount(walletAddress);
    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(vault.call(method, ...args))
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
    return submission.hash;
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
      const hash = await submitContractOperation("create_order", [
        Address.fromString(walletAddress).toScVal(),
        Address.fromString(tokenIn).toScVal(),
        Address.fromString(tokenOut).toScVal(),
        nativeToScVal(toStroops(amountIn), { type: "i128" }),
        nativeToScVal(toStroops(minAmountOut), { type: "i128" }),
        xdr.ScVal.scvU32(numericFeeBps),
      ]);
      setLifecycle("complete");
      await Promise.all([fetchOrders(), refreshBalances(walletAddress)]);
      setAmountIn("");
      setMinAmountOut("");
      setMessage(`Order confirmed on ledger: ${hash}`);
      showNotice(
        "success",
        "Order successfully created on-chain!",
        "Transaction confirmed on the Testnet ledger.",
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

  const cancelOrder = async (id: number): Promise<void> => {
    if (!walletAddress) {
      setConnectModalOpen(true);
      return;
    }
    if (operationLock.current) return;
    operationLock.current = true;
    setMessage("");
    const cancelledOrder = safeOrders.find((order) => order.id === id);
    const reclaimed = cancelledOrder?.amountIn || 0;
    const reclaimedSymbol = cancelledOrder
      ? tokenSymbolFromContract(cancelledOrder.tokenIn)
      : "TOKEN";
    try {
      const hash = await submitContractOperation("cancel_order", [
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

  const executeOrder = async (id: number): Promise<void> => {
    if (!walletAddress) {
      setConnectModalOpen(true);
      return;
    }
    if (operationLock.current) return;
    operationLock.current = true;
    setMessage("");
    try {
      const hash = await submitContractOperation("execute_order", [
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

  const busy = lifecycle === "running";
  const connected = Boolean(walletAddress);
  const contractUrl = `${EXPLORER_BASE}/contract/${CONTRACT_ID}`;
  const activeCount = safeOrders.filter((order) => order.status === "Active").length;
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
              contractId={CONTRACT_ID}
              contractUrl={contractUrl}
              contractLabel={shortAddress(CONTRACT_ID, 8, 6)}
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
                        label="Minimum you accept"
                        value={minAmountOut}
                        onChange={handleMinAmountOut}
                        disabled={busy}
                        hint={targetFiatValue}
                        unitNode={
                          <TokenSelector
                            options={TOKEN_OPTIONS}
                            value={targetToken}
                            balances={tokenBalances}
                            disabled={busy}
                            onSelect={selectTargetToken}
                          />
                        }
                      />

                      <AmountField
                        label="Target price"
                        value={limitPrice}
                        onChange={handleLimitPrice}
                        disabled={busy}
                        hint={priceHint}
                        unitNode={
                          <button
                            type="button"
                            onClick={togglePriceUnit}
                            disabled={busy || tryPerUsdc <= 0}
                            aria-label={`Price is in ${priceUnit} per XLM. Switch to ${
                              priceUnit === "USDC" ? "TRY" : "USDC"
                            }.`}
                            className={cn(
                              "pressable rounded-full border border-line-strong bg-surface-2",
                              "px-3 py-1.5 text-footnote font-medium text-ink-2",
                              "disabled:cursor-not-allowed disabled:opacity-50",
                            )}
                          >
                            {priceUnit} / XLM
                          </button>
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
                          : "Set an amount and a minimum"
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
            description="Every resting and settled order in the vault, read straight from the contract."
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
                    key={order.id.toString()}
                    id={order.id}
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
                    busy={busy}
                    onCancel={() => void cancelOrder(order.id)}
                    onExecute={() => void executeOrder(order.id)}
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
        contractId={CONTRACT_ID}
        contractUrl={contractUrl}
        networkLabel={NETWORK_LABEL}
        shortAddress={(value) => shortAddress(value, 8, 6)}
      />

      <Modal
        open={connectModalOpen}
        onClose={() => setConnectModalOpen(false)}
        title="Connect Freighter"
        description="TriggerVault never holds your keys. Freighter signs every order, cancellation and bridge payment locally."
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
