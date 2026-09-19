import { Component, useEffect, useMemo, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import {
  Activity,
  ArrowDown,
  Check,
  Clock3,
  ExternalLink,
  Gauge,
  LoaderCircle,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Wallet,
  X,
} from "lucide-react";
import {
  getAddress as getPublicKey,
  getNetwork,
  isConnected,
  requestAccess,
  signTransaction,
  WatchWalletChanges,
} from "@stellar/freighter-api";
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

const CONTRACT_ID =
  import.meta.env.VITE_VAULT_CONTRACT_ID ||
  "CDERIBD7XORORRYYOZDM44EOJIHJWZGEBE7WTAMHJMYGWI33UKGYQMPB";
const RPC_URL =
  import.meta.env.VITE_RPC_URL || "https://soroban-testnet.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const STROOPS_PER_XLM = 10_000_000;
const NETWORK_PASSPHRASE = Networks.TESTNET;
const NATIVE_XLM_SAC =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const CONFIGURED_TOKEN_OUT =
  (import.meta.env.VITE_TOKEN_OUT_CONTRACT_ID as string | undefined)?.trim() || "";
const READ_ONLY_SOURCE =
  "GBICM7WA6FIVCFRCPM3ZIGNF5CZC5VRCU4IV4DJPQLWIALVQ6IN6OI6A";
const server = new rpc.Server(RPC_URL);
const vault = new Contract(CONTRACT_ID);

type OrderStatus = "Active" | "Executed" | "Cancelled";
type OrderTab = "active" | "history";
type LifecycleState = "idle" | "running" | "complete" | "error";
type NoticeType = "success" | "error" | "info";

interface OrderItem {
  id: number;
  owner: string;
  amountIn: number;
  minAmountOut: number;
  feeBps: number;
  status: OrderStatus;
  tokenIn: string;
  tokenOut: string;
  createdAt: string;
  txHash?: string;
}

interface Telemetry {
  latency: number | null;
  ledger: number | null;
  healthy: boolean;
  updatedAt: Date | null;
}

interface Notice {
  id: number;
  type: NoticeType;
  title: string;
  detail: string;
  txHash?: string;
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

const safeTime = (value: unknown): string => {
  try {
    const date = new Date(value as string);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
};

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
      <div className="grid min-h-screen place-items-center bg-zinc-950 px-4 text-slate-200 selection:bg-cyan-500/30">
        <div className="w-full max-w-md border border-rose-500/40 bg-slate-950 shadow-2xl shadow-rose-950/40">
          <div className="flex items-center gap-3 border-b border-rose-500/30 px-5 py-4">
            <div className="grid h-9 w-9 place-items-center border border-rose-500/40 bg-rose-500/10">
              <Terminal className="h-5 w-5 text-rose-400" />
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-wide text-white">TERMINAL ERROR</h1>
              <p className="font-mono text-[10px] text-slate-500">RENDER EXECUTION HALTED</p>
            </div>
          </div>
          <div className="px-5 py-5">
            <p className="text-xs leading-relaxed text-slate-400">
              An unexpected error halted the terminal interface. Your wallet session
              and on-chain orders are unaffected. You can restart the terminal to
              continue.
            </p>
            {this.state.error && (
              <pre className="mt-3 max-h-32 overflow-auto border border-slate-800 bg-zinc-950 p-3 font-mono text-[10px] leading-relaxed text-rose-300">
                {safeMessage(this.state.error)}
              </pre>
            )}
            <div className="mt-5 flex gap-2">
              <button
                onClick={this.handleReset}
                className="flex flex-1 items-center justify-center gap-2 bg-cyan-500 py-3 text-xs font-bold tracking-wide text-slate-950 hover:bg-cyan-400"
              >
                <RefreshCw className="h-4 w-4" />
                RESTART TERMINAL
              </button>
              <button
                onClick={this.handleReload}
                className="flex items-center justify-center gap-2 border border-slate-700 bg-slate-900 px-4 py-3 font-mono text-[10px] text-slate-400 hover:text-white"
              >
                HARD RELOAD
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}

function App() {
  const [walletAddress, setWalletAddress] = useState("");
  const [walletConnecting, setWalletConnecting] = useState(false);
  const [walletBalance, setWalletBalance] = useState(0);
  const [amountIn, setAmountIn] = useState("25");
  const [minAmountOut, setMinAmountOut] = useState("3.8");
  const [feeBps, setFeeBps] = useState("100");
  const [slippage, setSlippage] = useState(0.5);
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
  const operationLock = useRef(false);

  const showNotice = (
    type: NoticeType,
    title: unknown,
    detail: unknown,
    txHash?: string,
  ): void => {
    const id = Date.now();
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

  const numericAmount = parseDecimal(amountIn);
  const numericMinOut = parseDecimal(minAmountOut);
  const numericFeeBps = parseDecimal(feeBps);
  const rawKeeperReward = Math.floor(
    numericAmount * STROOPS_PER_XLM * (numericFeeBps / 10_000),
  );
  const keeperReward = Number.isFinite(rawKeeperReward) ? rawKeeperReward : 0;
  const rawNetSwapAmount = numericAmount * (1 - numericFeeBps / 10_000);
  const netSwapAmount = Number.isFinite(rawNetSwapAmount)
    ? rawNetSwapAmount
    : 0;
  const rawEffectivePrice =
    numericAmount > 0 && numericMinOut > 0
      ? numericMinOut / numericAmount
      : 0;
  const effectivePrice = Number.isFinite(rawEffectivePrice)
    ? rawEffectivePrice
    : 0;

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
        .filter((order) => order.status === "Active")
        .reduce((total, order) => total + (Number(order.amountIn) || 0), 0),
    [safeOrders],
  );

  const fetchOrders = async (): Promise<void> => {
    const count = await simulateRead<number>("get_order_count");
    if (!Number.isSafeInteger(count) || count < 0 || count > 10_000) {
      throw new Error(`Invalid on-chain order count: ${safeMessage(count)}`);
    }
    const fetchedAt = Date.now();
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
          createdAt: new Date(
            fetchedAt - Math.max(0, count - (index + 1)) * 60_000,
          ).toISOString(),
        } satisfies OrderItem;
      }),
    );
    setOrders((current) => {
      const knownTimestamps = new Map(
        current.map((order) => [order.id, order.createdAt]),
      );
      return liveOrders
        .map((order) => ({
          ...order,
          createdAt: knownTimestamps.get(order.id) || order.createdAt,
        }))
        .reverse();
    });
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
    const initialRefresh = window.setTimeout(() => void refreshChain(), 0);
    const timer = window.setInterval(() => void refreshChain(), 10_000);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(timer);
    };
  }, []);

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

  const fetchWalletBalance = async (address: string): Promise<number> => {
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
  };

  useEffect(() => {
    if (!walletAddress) return;
    const balanceRefresh = window.setTimeout(
      () =>
        void fetchWalletBalance(walletAddress).catch(() => setWalletBalance(0)),
      0,
    );
    return () => window.clearTimeout(balanceRefresh);
  }, [walletAddress]);

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
      await fetchWalletBalance(address);
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
    showNotice("info", "Wallet Disconnected", "Freighter session removed from the terminal.");
  };

  const fillBalancePercentage = (percentage: number): void => {
    if (percentage === 100) {
      if (walletBalance <= 2) {
        setAmountIn("0.0000000");
        showNotice(
          "error",
          "Insufficient available balance",
          "At least 2 XLM must be reserved for gas fees and Stellar base reserve.",
        );
        return;
      }
      setAmountIn(Math.max(0, walletBalance - 2).toFixed(7));
      return;
    }
    setAmountIn(((walletBalance * percentage) / 100).toFixed(7));
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
      const detail = "Please connect your Freighter wallet first.";
      setMessage(detail);
      showNotice("error", "Wallet Not Connected", detail);
      return;
    }
    if (numericAmount <= 0 || numericMinOut <= 0) {
      const detail = "Collateral and minimum output must be greater than zero.";
      setMessage(detail);
      showNotice("error", "Invalid Order Values", detail);
      return;
    }
    if (numericAmount > walletBalance) {
      const detail = `Insufficient balance: Available balance is ${walletBalance.toFixed(7)} XLM.`;
      setMessage(detail);
      showNotice("error", "Insufficient Balance", detail);
      return;
    }
    if (!Number.isInteger(numericFeeBps) || numericFeeBps < 0 || numericFeeBps > 1_000) {
      const detail = "Keeper bounty cannot exceed 1,000 BPS (10.0%).";
      setMessage(detail);
      showNotice("error", "Invalid Keeper Bounty", detail);
      return;
    }

    const tokenOut =
      CONFIGURED_TOKEN_OUT ||
      orders.find((order) => order.tokenOut !== NATIVE_XLM_SAC)?.tokenOut;
    if (!tokenOut) {
      const detail = "Target token contract is not configured.";
      setMessage(detail);
      showNotice("error", "Output Token Missing", detail);
      return;
    }

    operationLock.current = true;
    try {
      const hash = await submitContractOperation("create_order", [
        Address.fromString(walletAddress).toScVal(),
        Address.fromString(NATIVE_XLM_SAC).toScVal(),
        Address.fromString(tokenOut).toScVal(),
        nativeToScVal(toStroops(amountIn), { type: "i128" }),
        nativeToScVal(toStroops(minAmountOut), { type: "i128" }),
        xdr.ScVal.scvU32(numericFeeBps),
      ]);
      setLifecycle("complete");
      await Promise.all([fetchOrders(), fetchWalletBalance(walletAddress)]);
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
        await Promise.all([fetchOrders(), fetchWalletBalance(walletAddress)]);
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
    if (!walletAddress || operationLock.current) return;
    operationLock.current = true;
    setMessage("");
    const balanceBefore = walletBalance;
    try {
      const hash = await submitContractOperation("cancel_order", [
        xdr.ScVal.scvU32(id),
      ]);
      const balanceAfter = await fetchWalletBalance(walletAddress);
      await fetchOrders();
      setLifecycle("complete");
      setMessage(
        `Cancellation confirmed: ${hash} | Balance change: ${(balanceAfter - balanceBefore).toFixed(7)} XLM`,
      );
      showNotice(
        "success",
        `Order #${id} cancelled. Collateral reclaimed.`,
        `Balance change ${(balanceAfter - balanceBefore).toFixed(7)} XLM`,
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
        await Promise.all([fetchOrders(), fetchWalletBalance(walletAddress)]);
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

  return (
    <div className="min-h-screen bg-zinc-950 text-slate-200 selection:bg-cyan-500/30">
      <style>{`@keyframes toast-in { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: translateX(0); } }`}</style>
      <div className="fixed right-4 top-4 z-50 flex w-[min(390px,calc(100vw-2rem))] flex-col gap-2">
        {notices.map((notice) => (
          <ToastNotice
            key={notice.id}
            notice={notice}
            onClose={() =>
              setNotices((current) => current.filter((item) => item.id !== notice.id))
            }
          />
        ))}
      </div>
      <header className="border-b border-slate-800 bg-slate-950/95">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between px-4 py-3 lg:px-6">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center border border-cyan-500/30 bg-cyan-500/10">
              <Terminal className="h-5 w-5 text-cyan-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-semibold tracking-wide text-white">TRIGGERVAULT</h1>
                <span className="border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] text-amber-300">TESTNET</span>
              </div>
              <p className="font-mono text-[10px] text-slate-500">SOROBAN EXECUTION TERMINAL</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {walletAddress && <span className="hidden font-mono text-[10px] text-slate-500 sm:inline">BAL {(Number(walletBalance) || 0).toFixed(4)} XLM</span>}
            {walletAddress ? (
              <div className="flex items-stretch border border-slate-700 bg-slate-900">
                <div className="flex items-center gap-2 px-3 py-2 font-mono text-xs text-slate-200">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <Wallet className="h-4 w-4 text-cyan-400" />
                  {shortAddress(walletAddress, 8, 6)}
                </div>
                <button onClick={disconnectWallet} className="flex items-center gap-1.5 border-l border-slate-700 px-3 font-mono text-[10px] text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"><LogOut className="h-3.5 w-3.5" />DISCONNECT</button>
              </div>
            ) : (
              <button onClick={connectWallet} disabled={walletConnecting} className="flex items-center gap-2 border border-cyan-500/50 bg-slate-900 px-3 py-2 font-mono text-xs text-cyan-200 hover:border-cyan-400 disabled:cursor-wait disabled:opacity-70">
                <Wallet className="h-4 w-4 text-cyan-400" />
                {walletConnecting ? "CONNECTING..." : "CONNECT FREIGHTER"}
              </button>
            )}
          </div>
        </div>
      </header>

      <section className="border-b border-slate-800 bg-zinc-950">
        <div className="mx-auto grid max-w-[1600px] grid-cols-2 divide-x divide-slate-800 border-x border-slate-800 md:grid-cols-4">
          <TelemetryCell label="RPC LATENCY" value={telemetry.latency === null ? "—" : `${telemetry.latency} ms`} icon={<Activity className="h-3.5 w-3.5" />} healthy={telemetry.healthy} />
          <TelemetryCell label="LATEST LEDGER" value={telemetry.ledger?.toLocaleString() || "—"} icon={<Gauge className="h-3.5 w-3.5" />} />
          <TelemetryCell label="ACTIVE VAULT VALUE" value={`${(Number(activeValue) || 0).toFixed(4)} XLM`} icon={<ShieldCheck className="h-3.5 w-3.5" />} />
          <div className="flex min-w-0 items-center justify-between gap-2 px-4 py-3">
            <div className="min-w-0">
              <p className="text-[9px] uppercase tracking-widest text-slate-500">Contract</p>
              <p className="truncate font-mono text-xs text-slate-300">{CONTRACT_ID}</p>
            </div>
            <a href={`https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}`} target="_blank" rel="noreferrer" className="text-cyan-400 hover:text-cyan-300"><ExternalLink className="h-4 w-4" /></a>
          </div>
        </div>
      </section>

      <main className="mx-auto grid max-w-[1600px] grid-cols-1 border-x border-slate-800 lg:grid-cols-[420px_1fr]">
        <section className="border-b border-slate-800 bg-slate-950 p-4 lg:min-h-[calc(100vh-130px)] lg:border-b-0 lg:border-r">
          <div className="mb-5 flex items-center justify-between">
            <div><h2 className="text-sm font-semibold text-white">Vault Order Placement</h2><p className="mt-1 text-[11px] text-slate-500">Slippage-bounded autonomous execution</p></div>
            <span className="font-mono text-[10px] text-slate-500">BAL {(Number(walletBalance) || 0).toFixed(4)} XLM</span>
          </div>

          <form onSubmit={submitOrder} className="space-y-4">
            <Field label="INPUT COLLATERAL" suffix="XLM" value={amountIn} onChange={setAmountIn} disabled={lifecycle === "running"} />
            <div className="grid grid-cols-4 gap-1.5">{[25, 50, 75, 100].map((percentage) => <button key={percentage} type="button" disabled={lifecycle === "running"} onClick={() => fillBalancePercentage(percentage)} className="border border-slate-800 bg-zinc-950 py-1.5 font-mono text-[10px] text-slate-400 hover:border-cyan-500/50 hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-40">{percentage}%</button>)}</div>
            <div className="flex justify-center"><ArrowDown className="h-4 w-4 text-slate-600" /></div>
            <Field label="MINIMUM OUTPUT" suffix="USDC" value={minAmountOut} onChange={setMinAmountOut} disabled={lifecycle === "running"} />
            <div>
              <div className="mb-2 flex items-center justify-between"><label className="text-[10px] font-medium tracking-widest text-slate-500">SLIPPAGE TOLERANCE</label><span className="font-mono text-xs text-cyan-400">{slippage.toFixed(1)}%</span></div>
              <div className="grid grid-cols-3 gap-1.5">{[0.1, 0.5, 1].map((value) => <button key={value} type="button" disabled={lifecycle === "running"} onClick={() => setSlippage(value)} className={`border py-2 font-mono text-xs disabled:cursor-not-allowed disabled:opacity-40 ${slippage === value ? "border-cyan-500 bg-cyan-500/10 text-cyan-300" : "border-slate-800 bg-zinc-950 text-slate-400"}`}>{value.toFixed(1)}%</button>)}</div>
            </div>
            <Field label="KEEPER BOUNTY" suffix="BPS" value={feeBps} onChange={setFeeBps} disabled={lifecycle === "running"} />

            <div className="border border-slate-800 bg-zinc-950 p-3 font-mono text-[11px]">
              <Breakdown label="Input collateral" value={`${numericAmount.toFixed(7)} XLM`} />
              <Breakdown label="Keeper reward" value={`${keeperReward.toLocaleString()} stroops`} />
              <Breakdown label="Net swap amount" value={`${netSwapAmount.toFixed(7)} XLM`} />
              <Breakdown label="Effective trigger price" value={`${effectivePrice.toFixed(7)} USDC/XLM`} strong />
            </div>

            <button type="submit" disabled={lifecycle === "running"} className="flex w-full items-center justify-center gap-2 bg-cyan-500 py-3 text-xs font-bold tracking-wide text-slate-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-60">
              {lifecycle === "running" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              DEPOSIT & CREATE LIMIT ORDER
            </button>
          </form>

          <div className="mt-5 border-t border-slate-800 pt-4">
            <p className="mb-3 text-[10px] font-medium tracking-widest text-slate-500">TRANSACTION LIFECYCLE</p>
            <div className="grid grid-cols-4 gap-1">{lifecycleLabels.map((label, index) => { const done = lifecycleStep > index || lifecycle === "complete"; const current = lifecycle === "running" && lifecycleStep === index; return <div key={label} className="text-center"><div className={`mx-auto mb-2 grid h-7 w-7 place-items-center rounded-full border ${done ? "border-emerald-500 bg-emerald-500/10 text-emerald-400" : current ? "border-cyan-400 bg-cyan-500/10 text-cyan-300" : "border-slate-800 text-slate-600"}`}>{done ? <Check className="h-3.5 w-3.5" /> : current ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <span className="font-mono text-[10px]">{index + 1}</span>}</div><span className="text-[9px] leading-tight text-slate-500">{label}</span></div>; })}</div>
          </div>
          {message && <div className="mt-4 flex items-start gap-2 border border-slate-700 bg-slate-900 p-3 text-xs text-slate-300"><Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-400" />{message}</div>}
        </section>

        <section className="min-w-0 bg-zinc-950">
          <div className="flex flex-col gap-3 border-b border-slate-800 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div><h2 className="text-sm font-semibold text-white">On-Chain Orders & Telemetry</h2><p className="mt-1 text-[11px] text-slate-500">Deterministic execution queue and settlement history</p></div>
            <button onClick={() => void refreshChain()} className="flex items-center gap-2 border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-[10px] text-slate-400 hover:text-white"><RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />REFRESH CHAIN</button>
          </div>
          <div className="flex border-b border-slate-800">{([{ id: "active", label: "ACTIVE LIMIT ORDERS" }, { id: "history", label: "EXECUTED / HISTORICAL" }] as const).map((item) => <button key={item.id} onClick={() => setTab(item.id)} className={`border-r border-slate-800 px-5 py-3 font-mono text-[10px] tracking-wide ${tab === item.id ? "border-b-2 border-b-cyan-400 bg-slate-900 text-cyan-300" : "text-slate-500 hover:text-slate-300"}`}>{item.label}</button>)}</div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left">
              <thead className="border-b border-slate-800 bg-slate-950 font-mono text-[9px] uppercase tracking-wider text-slate-500"><tr><th className="px-4 py-3">Order</th><th className="px-4 py-3">Owner</th><th className="px-4 py-3 text-right">Collateral</th><th className="px-4 py-3 text-right">Min Output</th><th className="px-4 py-3 text-right">Bounty</th><th className="px-4 py-3">Created</th><th className="px-4 py-3 text-right">Action</th></tr></thead>
              <tbody className="divide-y divide-slate-800/80">{visibleOrders.map((order) => <tr key={order.id} className="font-mono text-xs hover:bg-slate-900/60"><td className="px-4 py-3 text-cyan-400">#{order.id}</td><td className="px-4 py-3 text-slate-400">{shortAddress(String(order.owner || ""))}</td><td className="px-4 py-3 text-right text-white">{(Number(order.amountIn) || 0).toFixed(4)} XLM</td><td className="px-4 py-3 text-right text-slate-300">≥ {(Number(order.minAmountOut) || 0).toFixed(4)} USDC</td><td className="px-4 py-3 text-right text-amber-300">{((Number(order.feeBps) || 0) / 100).toFixed(2)}%</td><td className="px-4 py-3 text-slate-500">{safeTime(order.createdAt)}</td><td className="px-4 py-3 text-right">{order.status === "Active" && order.owner === walletAddress ? <button disabled={lifecycle === "running"} onClick={() => void cancelOrder(order.id)} className="inline-flex items-center gap-1.5 border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-[10px] text-rose-300 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40"><X className="h-3 w-3" />CANCEL & RECLAIM</button> : <span className="text-slate-600">{String(order.status || "").toUpperCase()}</span>}</td></tr>)}</tbody>
            </table>
            {visibleOrders.length === 0 && <div className="grid min-h-64 place-items-center border-b border-slate-800"><div className="max-w-md px-6 text-center">{tab === "history" ? <><div className="relative mx-auto mb-4 h-12 w-12"><span className="absolute inset-0 animate-ping rounded-full border border-cyan-500/30" /><span className="absolute inset-2 animate-pulse rounded-full border border-cyan-400/50 bg-cyan-500/5" /><Activity className="absolute inset-0 m-auto h-5 w-5 text-cyan-400" /></div><p className="font-mono text-xs text-slate-400">NO HISTORICAL ORDERS</p><p className="mt-2 text-[10px] leading-relaxed text-slate-600">Autonomous keeper engine is actively scanning order book for price triggers</p></> : <><Clock3 className="mx-auto mb-3 h-6 w-6 text-slate-700" /><p className="font-mono text-xs text-slate-500">NO ACTIVE ORDERS</p><p className="mt-1 text-[10px] text-slate-700">Waiting for contract state updates</p></>}</div></div>}
          </div>
        </section>
      </main>
    </div>
  );
}

function TelemetryCell({ label, value, icon, healthy }: { label: string; value: string; icon: React.ReactNode; healthy?: boolean }) {
  return <div className="px-4 py-3"><div className="mb-1 flex items-center gap-1.5 text-[9px] uppercase tracking-widest text-slate-500">{icon}{label}</div><div className="flex items-center gap-2 font-mono text-xs text-slate-200">{healthy !== undefined && <span className={`h-1.5 w-1.5 rounded-full ${healthy ? "bg-emerald-400" : "bg-rose-400"}`} />}{value}</div></div>;
}

function Field({ label, suffix, value, onChange, disabled = false }: { label: string; suffix: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return <label className="block"><span className="mb-2 block text-[10px] font-medium tracking-widest text-slate-500">{label}</span><div className={`flex border border-slate-800 bg-zinc-950 focus-within:border-cyan-500/60 ${disabled ? "opacity-50" : ""}`}><input type="text" inputMode="decimal" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value.replace(",", "."))} className="min-w-0 flex-1 bg-transparent px-3 py-3 font-mono text-sm text-white outline-none disabled:cursor-not-allowed" /><span className="border-l border-slate-800 px-3 py-3 font-mono text-xs text-slate-500">{suffix}</span></div></label>;
}

function Breakdown({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <div className={`flex items-center justify-between py-1.5 ${strong ? "mt-1 border-t border-slate-800 pt-2.5" : ""}`}><span className="text-slate-500">{label}</span><span className={strong ? "text-cyan-300" : "text-slate-300"}>{value}</span></div>;
}

function ToastNotice({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  const success = notice.type === "success";
  const info = notice.type === "info";
  return (
    <div className={`animate-[toast-in_180ms_ease-out] border bg-slate-950 shadow-2xl ${success ? "border-emerald-500/50 shadow-emerald-950/40" : info ? "border-cyan-500/50 shadow-cyan-950/40" : "border-rose-500/50 shadow-rose-950/40"}`} role="status" aria-live="polite">
      <div className="flex items-start gap-3 p-4">
        <div className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full ${success ? "bg-emerald-500/15 text-emerald-400" : info ? "bg-cyan-500/15 text-cyan-400" : "bg-rose-500/15 text-rose-400"}`}>
          {success ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-white">{notice.title}</p>
          <p className="mt-1 break-words font-mono text-[10px] leading-relaxed text-slate-400">{notice.detail}</p>
          {notice.txHash && (
            <a
              href={`https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(notice.txHash)}`}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1.5 font-mono text-[10px] text-cyan-400 hover:text-cyan-300"
            >
              VIEW ON STELLAREXPERT
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <button onClick={onClose} className="text-slate-600 hover:text-white" aria-label="Close notification"><X className="h-4 w-4" /></button>
      </div>
      <div className={`h-0.5 ${success ? "bg-emerald-400" : info ? "bg-cyan-400" : "bg-rose-400"}`} />
    </div>
  );
}

export default function AppWithBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
