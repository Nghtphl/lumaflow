import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Banknote,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Landmark,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { loadAnchorConfig } from "../anchor/toml";
import type { AnchorConfig } from "../anchor/toml";
import { AnchorUnauthorizedError, withAuth } from "../anchor/sep10";
import { ensureTrustline, getTrustlineState } from "../anchor/trustline";
import {
  DEPOSIT_LADDER,
  WITHDRAW_LADDER,
  anchorInfo,
  getTransaction,
  isTerminal,
  ladderIndex,
  pollTransaction,
  sendWithdrawalPayment,
  simulateBankTransfer,
  startDeposit,
  startWithdraw,
} from "../anchor/sep6";
import type {
  DepositInstructions,
  Sep6Info,
  Sep6Transaction,
  WithdrawInstructions,
} from "../anchor/sep6";
import { priceTryToUsdc, priceUsdcToTry } from "../anchor/sep38";
import type { Sep38Price } from "../anchor/sep38";

const ANCHOR_HOME_DOMAIN =
  (import.meta.env.VITE_ANCHOR_HOME_DOMAIN as string | undefined)?.trim() ||
  "tr-mock-anchor.fly.dev";

// The anchor publishes its own limits via /sep6/info; these are the fallbacks
// used only until that call resolves, so the form can validate immediately.
const FALLBACK_MIN_TRY = 50;
const FALLBACK_MAX_TRY = 3_000;
const FALLBACK_MIN_USDC = 1;

export interface AnchorPanelProps {
  walletAddress: string;
  /** Opens the shared Freighter prompt for any protected bridge action. */
  onRequireWallet: () => void;
  /** Called whenever the on-chain USDC balance is re-read. */
  onUsdcBalance: (balance: number) => void;
  /** TRY per 1 USDC, so the order form can price triggers in lira. */
  onRate: (tryPerUsdc: number, label: string) => void;
  notify: (
    type: "success" | "error" | "info",
    title: string,
    detail: string,
    txHash?: string,
  ) => void;
  /** Refresh the rest of the terminal after USDC moves. */
  onSettled: () => void;
  /** Hands the parent a way to re-read the USDC balance after a vault action. */
  registerRefresh: (refresh: () => void) => void;
}

type Flow = "deposit" | "withdraw";
type DisplayCurrency = "TRY" | "USDC" | "XLM";

const CURRENCY_OPTIONS: ReadonlyArray<{
  code: DisplayCurrency;
  icon: string;
  name: string;
}> = [
  { code: "TRY", icon: "🇹🇷", name: "Turkish Lira Anchor" },
  { code: "USDC", icon: "💵", name: "Circle Testnet" },
  { code: "XLM", icon: "✦", name: "Stellar Lumens" },
];

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export default function AnchorPanel({
  walletAddress,
  onRequireWallet,
  onUsdcBalance,
  onRate,
  notify,
  onSettled,
  registerRefresh,
}: AnchorPanelProps) {
  const [cfg, setCfg] = useState<AnchorConfig | null>(null);
  const [discoveryError, setDiscoveryError] = useState("");
  const [info, setInfo] = useState<Sep6Info | null>(null);

  const [trustlineReady, setTrustlineReady] = useState(false);
  const [usdcBalance, setUsdcBalance] = useState(0);
  const [enablingTrustline, setEnablingTrustline] = useState(false);

  const [flow, setFlow] = useState<Flow>("deposit");
  const [busy, setBusy] = useState(false);
  const [displayCurrency, setDisplayCurrency] = useState<DisplayCurrency>("TRY");
  const [currencyMenuOpen, setCurrencyMenuOpen] = useState(false);

  const [tryAmount, setTryAmount] = useState("500");
  const [quote, setQuote] = useState<Sep38Price | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [deposit, setDeposit] = useState<DepositInstructions | null>(null);

  const [withdrawAmount, setWithdrawAmount] = useState("1");
  const [withdrawQuote, setWithdrawQuote] = useState<Sep38Price | null>(null);
  const [withdrawal, setWithdrawal] = useState<WithdrawInstructions | null>(null);
  const [paymentSent, setPaymentSent] = useState(false);
  const [copied, setCopied] = useState("");

  const [tracked, setTracked] = useState<Sep6Transaction | null>(null);
  const stopPolling = useRef<(() => void) | null>(null);

  const minTry = info?.minAmount ?? FALLBACK_MIN_TRY;
  const maxTry = info?.maxAmount ?? FALLBACK_MAX_TRY;
  const minUsdc = info?.minWithdrawAmount ?? FALLBACK_MIN_USDC;

  // ── SEP-1 discovery ───────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void loadAnchorConfig(ANCHOR_HOME_DOMAIN)
      .then((resolved) => {
        if (!cancelled) setCfg(resolved);
      })
      .catch((error: unknown) => {
        if (!cancelled) setDiscoveryError(messageOf(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Trustline + USDC balance ──────────────────────────────────────────────
  const refreshBalance = useCallback(async (): Promise<void> => {
    if (!cfg || !walletAddress) return;
    try {
      const state = await getTrustlineState(cfg, walletAddress);
      setTrustlineReady(state.exists);
      const balance = Number(state.balance) || 0;
      setUsdcBalance(balance);
      onUsdcBalance(balance);
    } catch {
      // An unfunded or unreachable account is not an anchor failure; the panel
      // keeps its last known state rather than shouting at the user.
    }
  }, [cfg, walletAddress, onUsdcBalance]);

  useEffect(() => {
    registerRefresh(() => void refreshBalance());
  }, [registerRefresh, refreshBalance]);

  useEffect(() => {
    if (!walletAddress) {
      setTrustlineReady(false);
      setUsdcBalance(0);
      onUsdcBalance(0);
      return;
    }
    void refreshBalance();
  }, [walletAddress, refreshBalance, onUsdcBalance]);

  // ── Indicative TRY price, refreshed as the user types ─────────────────────
  useEffect(() => {
    if (!cfg) return;
    const amount = Number(tryAmount.replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void priceTryToUsdc(cfg, amount.toFixed(2))
        .then((priced) => {
          if (cancelled) return;
          setQuote(priced);
          setQuoteError("");
          if (priced.totalPrice > 0) onRate(priced.totalPrice, `SEP-38 · ${cfg.orgName}`);
        })
        .catch((error: unknown) => {
          if (!cancelled) setQuoteError(messageOf(error));
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cfg, tryAmount, onRate]);

  // ── Indicative price for the off-ramp ─────────────────────────────────────
  useEffect(() => {
    if (!cfg || flow !== "withdraw") return;
    const amount = Number(withdrawAmount.replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) {
      setWithdrawQuote(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void priceUsdcToTry(cfg, amount.toFixed(7))
        .then((priced) => {
          if (!cancelled) setWithdrawQuote(priced);
        })
        .catch(() => {
          if (!cancelled) setWithdrawQuote(null);
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cfg, flow, withdrawAmount]);

  useEffect(
    () => () => {
      stopPolling.current?.();
    },
    [],
  );

  const loadInfo = useCallback(async (): Promise<void> => {
    if (!cfg || !walletAddress || info) return;
    try {
      const resolved = await withAuth(cfg, walletAddress, (jwt) =>
        anchorInfo(cfg, jwt),
      );
      setInfo(resolved);
    } catch {
      // /info needs authentication on this anchor; the fallback limits stand in
      // until the user signs in as part of the first deposit.
    }
  }, [cfg, walletAddress, info]);

  const track = useCallback(
    (config: AnchorConfig, jwt: string, id: string): void => {
      stopPolling.current?.();
      stopPolling.current = pollTransaction(
        config,
        jwt,
        id,
        (transaction) => {
          setTracked(transaction);
          if (transaction.status === "completed") {
            stopPolling.current?.();
            stopPolling.current = null;
            void refreshBalance();
            onSettled();
            notify(
              "success",
              transaction.kind === "withdrawal"
                ? "TRY sent to your IBAN"
                : "USDC delivered to your wallet",
              transaction.externalTransactionId
                ? `Bank reference ${transaction.externalTransactionId}`
                : "The anchor reported the transfer as completed.",
              transaction.stellarTransactionId || undefined,
            );
          } else if (isTerminal(transaction.status)) {
            notify(
              "error",
              "Anchor transfer did not complete",
              transaction.statusMessage || `Anchor status: ${transaction.status}`,
            );
          }
        },
        () => notify("error", "Anchor session expired", "Sign in to the anchor again to keep tracking this transfer."),
      );
    },
    [notify, onSettled, refreshBalance],
  );

  const enableUsdc = async (): Promise<void> => {
    if (!walletAddress) {
      onRequireWallet();
      return;
    }
    if (!cfg) return;
    setEnablingTrustline(true);
    try {
      const created = await ensureTrustline(cfg, walletAddress);
      await refreshBalance();
      notify(
        "success",
        created ? "USDC enabled" : "USDC already enabled",
        created
          ? "Your wallet can now receive USDC from the anchor."
          : "This wallet already trusts the anchor's USDC.",
      );
    } catch (error) {
      notify("error", "Could not enable USDC", messageOf(error));
    } finally {
      setEnablingTrustline(false);
    }
  };

  const openDeposit = async (): Promise<void> => {
    setFlow("deposit");
    setDeposit(null);
    setTracked(null);
    stopPolling.current?.();
    await loadInfo();
  };

  const openWithdraw = async (): Promise<void> => {
    setFlow("withdraw");
    setWithdrawal(null);
    setPaymentSent(false);
    setTracked(null);
    stopPolling.current?.();
    await loadInfo();
  };

  const requestDeposit = async (): Promise<void> => {
    if (!walletAddress) {
      onRequireWallet();
      return;
    }
    if (!cfg) return;
    const amount = Number(tryAmount.replace(",", "."));
    if (!Number.isFinite(amount) || amount < minTry || amount > maxTry) {
      notify(
        "error",
        "Amount outside the anchor's limits",
        `This anchor accepts ${minTry}–${maxTry} TRY per deposit.`,
      );
      return;
    }
    setBusy(true);
    try {
      const instructions = await withAuth(cfg, walletAddress, (jwt) =>
        startDeposit(cfg, jwt, {
          account: walletAddress,
          amount: amount.toFixed(2),
        }),
      );
      setDeposit(instructions);
      const jwt = await withAuth(cfg, walletAddress, async (token) => token);
      const current = await getTransaction(cfg, jwt, instructions.id);
      setTracked(current);
      track(cfg, jwt, instructions.id);
      notify(
        "info",
        "Bank instructions ready",
        "Send the TRY to the IBAN below with the reference attached.",
      );
    } catch (error) {
      notify(
        "error",
        error instanceof AnchorUnauthorizedError
          ? "Anchor sign-in required"
          : "Deposit could not be started",
        messageOf(error),
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmBankTransfer = async (): Promise<void> => {
    if (!walletAddress) {
      onRequireWallet();
      return;
    }
    if (!cfg || !deposit) return;
    setBusy(true);
    try {
      const amount = Number(tryAmount.replace(",", ".")).toFixed(2);
      await withAuth(cfg, walletAddress, (jwt) =>
        simulateBankTransfer(cfg, jwt, deposit.id, amount),
      );
      notify(
        "info",
        "Bank transfer simulated",
        "The sandbox anchor is now paying out real testnet USDC.",
      );
    } catch (error) {
      notify("error", "Simulation failed", messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const requestWithdraw = async (): Promise<void> => {
    if (!walletAddress) {
      onRequireWallet();
      return;
    }
    if (!cfg) return;
    const amount = Number(withdrawAmount.replace(",", "."));
    if (!Number.isFinite(amount) || amount < minUsdc) {
      notify(
        "error",
        "Amount below the anchor's minimum",
        `Withdrawals start at ${minUsdc} ${cfg.asset.code}.`,
      );
      return;
    }
    if (amount > usdcBalance) {
      notify(
        "error",
        "Insufficient USDC",
        `Your wallet holds ${usdcBalance.toFixed(7)} ${cfg.asset.code}.`,
      );
      return;
    }
    setBusy(true);
    try {
      const instructions = await withAuth(cfg, walletAddress, (jwt) =>
        startWithdraw(cfg, jwt, { amount: amount.toFixed(7) }),
      );
      setWithdrawal(instructions);
      const jwt = await withAuth(cfg, walletAddress, async (token) => token);
      setTracked(await getTransaction(cfg, jwt, instructions.id));
      track(cfg, jwt, instructions.id);
    } catch (error) {
      notify("error", "Withdrawal could not be started", messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const payWithdrawal = async (): Promise<void> => {
    if (!walletAddress) {
      onRequireWallet();
      return;
    }
    if (!cfg || !withdrawal) return;
    setBusy(true);
    try {
      const amount = Number(withdrawAmount.replace(",", ".")).toFixed(7);
      const hash = await sendWithdrawalPayment(cfg, walletAddress, withdrawal, amount);
      setPaymentSent(true);
      await refreshBalance();
      notify(
        "success",
        "USDC sent to the anchor treasury",
        "The anchor is matching the payment by its memo and paying out TRY.",
        hash,
      );
    } catch (error) {
      notify("error", "Withdrawal payment failed", messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const ladder = flow === "withdraw" ? WITHDRAW_LADDER : DEPOSIT_LADDER;
  const activeStep = tracked ? ladderIndex(ladder, tracked.status) : -1;

  const previewUsdc = quote?.buyAmount || 0;
  const withdrawPreviewTry = withdrawQuote?.buyAmount || 0;
  const depositIban =
    deposit?.fields.find((field) => field.label.toLowerCase().includes("iban"))?.value || "—";

  const anchorLabel = useMemo(
    () => (cfg ? `${cfg.orgName} · ${cfg.homeDomain}` : ANCHOR_HOME_DOMAIN),
    [cfg],
  );

  const copyValue = (label: string, value: string): void => {
    if (!navigator.clipboard) {
      notify("error", "Copy unavailable", "Your browser does not expose clipboard access.");
      return;
    }
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(label);
        window.setTimeout(() => setCopied(""), 1_500);
      })
      .catch((error: unknown) => {
        notify("error", "Copy failed", messageOf(error));
      });
  };

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-cyan-500/10 text-cyan-300"><Landmark className="h-4 w-4" /></div>
          <div className="min-w-0">
            <p className="text-lg font-semibold text-white">TRY Bank Bridge</p>
            <p className="truncate text-[10px] text-slate-500">{anchorLabel}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refreshBalance()}
          className="rounded-lg p-2 text-slate-600 transition hover:bg-slate-800 hover:text-cyan-300"
          aria-label="Refresh anchor balance"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {discoveryError ? (
        <p className="px-3 py-3 font-mono text-[10px] leading-relaxed text-rose-300">
          Anchor discovery failed: {discoveryError}
        </p>
      ) : !cfg ? (
        <p className="flex items-center gap-2 px-3 py-3 font-mono text-[10px] text-slate-500">
          <LoaderCircle className="h-3 w-3 animate-spin" />
          Reading stellar.toml…
        </p>
      ) : (
        <div>
          <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-slate-800/80 bg-slate-950/50 px-4 py-3">
            <div>
              <p className="text-[9px] uppercase tracking-widest text-slate-500">Bridge wallet balance</p>
              <p className="text-xl font-semibold text-white">{usdcBalance.toFixed(2)} <span className="text-xs font-medium text-slate-500">{cfg.asset.code}</span></p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <CurrencySelector
                selected={displayCurrency}
                open={currencyMenuOpen}
                onToggle={() => setCurrencyMenuOpen((current) => !current)}
                onSelect={(currency) => {
                  setDisplayCurrency(currency);
                  setCurrencyMenuOpen(false);
                }}
              />
              {!walletAddress ? (
                <button
                  type="button"
                  onClick={onRequireWallet}
                  className="font-mono text-[10px] text-purple-300 transition hover:text-purple-200"
                >
                  CONNECT WALLET
                </button>
              ) : trustlineReady ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1.5 text-[10px] font-semibold text-emerald-300"><Check className="h-3 w-3" />Bridge ready</span>
              ) : (
                <button
                  type="button"
                  onClick={() => void enableUsdc()}
                  disabled={enablingTrustline}
                  className="flex items-center gap-1.5 rounded-lg border border-amber-500/50 bg-amber-500/10 px-2.5 py-1.5 font-mono text-[10px] text-amber-200 disabled:cursor-wait"
                >
                  {enablingTrustline ? (
                    <LoaderCircle className="h-3 w-3 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-3 w-3" />
                  )}
                  ENABLE USDC
                </button>
              )}
            </div>
          </div>

          <div className="mb-4 grid grid-cols-2 rounded-xl bg-slate-950/70 p-1" role="tablist" aria-label="Bank bridge direction">
            <button
              type="button"
              role="tab"
              aria-selected={flow === "deposit"}
              onClick={() => void openDeposit()}
              className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold transition ${flow === "deposit" ? "bg-slate-800 text-white shadow-lg shadow-black/30" : "text-slate-500 hover:text-slate-300"}`}
            >
              <ArrowDownToLine className="h-3.5 w-3.5" />Deposit TRY
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={flow === "withdraw"}
              onClick={() => void openWithdraw()}
              className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold transition ${flow === "withdraw" ? "bg-slate-800 text-white shadow-lg shadow-black/30" : "text-slate-500 hover:text-slate-300"}`}
            >
              <ArrowUpFromLine className="h-3.5 w-3.5" />Withdraw TRY
            </button>
          </div>

          {walletAddress && !trustlineReady && (
            <p className="mb-3 text-[10px] leading-relaxed text-slate-500">
              Your Stellar account has to accept {cfg.asset.code} once before the
              anchor can pay you. It is a single signature and costs no fee beyond
              a small reserve.
            </p>
          )}

          {flow === "deposit" ? (
            <div key="deposit-flow" className="space-y-4 border-t border-slate-800/80 pt-4">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-medium tracking-widest text-slate-500">
                  DEPOSIT TRY
                </p>
              </div>

              {!deposit && (
                <div key="deposit-form" className="space-y-4">
                  <label className="block">
                    <span className="mb-1.5 block text-[10px] tracking-widest text-slate-500">
                      AMOUNT
                    </span>
                    <div className="flex items-center rounded-xl border border-slate-800 bg-slate-950/60 focus-within:border-cyan-500/60 focus-within:ring-2 focus-within:ring-cyan-500/10">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={tryAmount}
                        onChange={(event) => setTryAmount(event.target.value.replace(",", "."))}
                        className="min-w-0 flex-1 bg-transparent px-4 py-3 text-2xl font-semibold text-white outline-none"
                      />
                      <span className="mr-3 rounded-full border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200">
                        TRY
                      </span>
                    </div>
                  </label>

                  <div className="rounded-xl border border-slate-800/80 bg-slate-950/50 p-3 text-[10px]">
                    {quoteError ? (
                      <p className="text-rose-300">{quoteError}</p>
                    ) : quote ? (
                      <div key="deposit-quote">
                        <div className="flex justify-between py-0.5">
                          <span className="text-slate-500">You receive</span>
                          <span className="text-cyan-300">
                            ≈ {previewUsdc.toFixed(7)} {cfg.asset.code}
                          </span>
                        </div>
                        <div className="flex justify-between py-0.5">
                          <span className="text-slate-500">Rate</span>
                          <span className="text-slate-300">
                            1 {cfg.asset.code} = {quote.totalPrice.toFixed(4)} TRY
                          </span>
                        </div>
                        <div className="flex justify-between py-0.5">
                          <span className="text-slate-500">Anchor fee</span>
                          <span className="text-slate-300">{quote.feeTotal.toFixed(2)} TRY</span>
                        </div>
                        <p className="mt-1.5 border-t border-slate-800 pt-1.5 text-[9px] leading-relaxed text-slate-600">
                          SEP-38 · {cfg.orgName}. Indicative SEP-38 price, not a locked quote.
                        </p>
                      </div>
                    ) : (
                      <p className="text-slate-600">Pricing…</p>
                    )}
                  </div>

                  <p className="text-[9px] text-slate-600">
                    Anchor limits: {minTry}–{maxTry} TRY per deposit.
                  </p>

                  <button
                    type="button"
                    onClick={() => void requestDeposit()}
                    disabled={busy}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-400 to-blue-500 py-3.5 text-sm font-bold text-slate-950 shadow-lg shadow-cyan-950/40 transition hover:brightness-110 disabled:cursor-wait disabled:opacity-60"
                  >
                    {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Banknote className="h-3.5 w-3.5" />}
                    GET BANK INSTRUCTIONS
                  </button>
                </div>
              )}

              {deposit && (
                <div key="deposit-instructions" className="space-y-4">
                  <div className="rounded-xl border border-cyan-500/20 bg-slate-950/80 p-3 shadow-inner shadow-black/20">
                    <CopyDetail label="Bank Name" value="TR Mock Bank A.Ş." copied={copied === "Bank Name"} onCopy={copyValue} />
                    <CopyDetail label="IBAN" value={depositIban} copied={copied === "IBAN"} onCopy={copyValue} />
                    <CopyDetail label="Transfer Reference" value={deposit.reference || "—"} copied={copied === "Transfer Reference"} onCopy={copyValue} />
                    {deposit.reference && (
                      <p className="mt-2 border-t border-slate-800 pt-2 text-[9px] leading-relaxed text-amber-300">
                        The reference is how the anchor recognises your transfer. A
                        payment without it cannot be matched.
                      </p>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => void confirmBankTransfer()}
                    disabled={busy || (tracked ? isTerminal(tracked.status) : false)}
                    className="flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 py-3 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    I SENT THE TRY (SIMULATE BANK TRANSFER)
                  </button>
                  <p className="text-[9px] leading-relaxed text-slate-600">
                    Sandbox only: a production anchor learns this from its bank. The
                    USDC payout that follows is a real testnet transaction.
                  </p>
                </div>
              )}

              <StatusLadder ladder={ladder} activeStep={activeStep} tracked={tracked} />
            </div>
          ) : null}

          {flow === "withdraw" ? (
            <div key="withdraw-flow" className="space-y-4 border-t border-slate-800/80 pt-4">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-medium tracking-widest text-slate-500">
                  WITHDRAW TO IBAN
                </p>
              </div>

              {!withdrawal && (
                <div key="withdraw-form" className="space-y-4">
                  <label className="block">
                    <span className="mb-1.5 block text-[10px] tracking-widest text-slate-500">
                      AMOUNT
                    </span>
                    <div className="flex items-center rounded-xl border border-slate-800 bg-slate-950/60 focus-within:border-cyan-500/60 focus-within:ring-2 focus-within:ring-cyan-500/10">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={withdrawAmount}
                        onChange={(event) =>
                          setWithdrawAmount(event.target.value.replace(",", "."))
                        }
                        className="min-w-0 flex-1 bg-transparent px-4 py-3 text-2xl font-semibold text-white outline-none"
                      />
                      <span className="mr-3 rounded-full border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200">
                        {cfg.asset.code}
                      </span>
                    </div>
                  </label>
                  <div className="rounded-xl border border-slate-800/80 bg-slate-950/50 p-3 text-[10px]">
                    <div className="flex justify-between py-0.5">
                      <span className="text-slate-500">You receive</span>
                      <span className="text-cyan-300">
                        ≈ {withdrawPreviewTry.toFixed(2)} TRY
                      </span>
                    </div>
                    <p className="mt-1.5 text-[9px] text-slate-600">
                      Minimum {minUsdc} {cfg.asset.code}. Bank leg is simulated.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void requestWithdraw()}
                    disabled={busy}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-400 to-blue-500 py-3.5 text-sm font-bold text-slate-950 shadow-lg shadow-cyan-950/40 transition hover:brightness-110 disabled:cursor-wait disabled:opacity-60"
                  >
                    {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpFromLine className="h-3.5 w-3.5" />}
                    START WITHDRAWAL
                  </button>
                </div>
              )}

              {withdrawal && (
                <div key="withdraw-instructions" className="space-y-4">
                  <div className="rounded-xl border border-cyan-500/20 bg-slate-950/80 p-3 shadow-inner shadow-black/20">
                    <CopyDetail label="Treasury" value={withdrawal.accountId} copied={copied === "Treasury"} onCopy={copyValue} />
                    <CopyDetail label={`Memo (${withdrawal.memoType})`} value={withdrawal.memo} copied={copied === `Memo (${withdrawal.memoType})`} onCopy={copyValue} />
                    <p className="mt-2 border-t border-slate-800 pt-2 text-[9px] leading-relaxed text-amber-300">
                      The memo is the only link between your payment and this
                      withdrawal. Use the button below so it is attached for you.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void payWithdrawal()}
                    disabled={busy || paymentSent}
                    className="flex w-full items-center justify-center gap-2 border border-emerald-500/50 bg-emerald-500/10 py-2.5 font-mono text-[10px] tracking-wide text-emerald-200 hover:border-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    {paymentSent ? "PAYMENT SENT" : "SIGN & SEND USDC WITH MEMO"}
                  </button>
                </div>
              )}

              <StatusLadder ladder={ladder} activeStep={activeStep} tracked={tracked} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function CurrencySelector({
  selected,
  open,
  onToggle,
  onSelect,
}: {
  selected: DisplayCurrency;
  open: boolean;
  onToggle: () => void;
  onSelect: (currency: DisplayCurrency) => void;
}) {
  const selectedOption =
    CURRENCY_OPTIONS.find((option) => option.code === selected) || CURRENCY_OPTIONS[0];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-full border border-slate-700/70 bg-slate-800/80 px-3 py-2 text-xs font-semibold text-slate-100 shadow-lg shadow-black/20 transition hover:border-purple-500/40 hover:bg-slate-800"
      >
        <span aria-hidden="true">{selectedOption.icon}</span>
        {selectedOption.code}
        <ChevronDown className={`h-3.5 w-3.5 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label="Bridge currency"
          className="animate-in fade-in zoom-in-95 absolute right-0 top-full z-30 mt-2 w-64 rounded-2xl border border-slate-700/60 bg-slate-900/90 p-2 shadow-2xl backdrop-blur-xl duration-150"
        >
          {CURRENCY_OPTIONS.map((option) => (
            <button
              key={option.code}
              type="button"
              role="option"
              aria-selected={selected === option.code}
              onClick={() => onSelect(option.code)}
              className="flex w-full items-center gap-3 rounded-xl p-2.5 text-left text-slate-300 transition-all hover:bg-purple-500/10 hover:text-purple-300"
            >
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-slate-800/80 text-lg" aria-hidden="true">
                {option.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-semibold">{option.code}</span>
                <span className="mt-0.5 block truncate text-[10px] text-slate-500">
                  {option.name}
                </span>
              </span>
              {selected === option.code ? <Check className="h-4 w-4 text-purple-300" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CopyDetail({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: (label: string, value: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-slate-800/70 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="text-[9px] font-medium uppercase tracking-widest text-slate-500">{label}</p>
        <p className="mt-1 break-all font-mono text-xs font-medium text-white">{value}</p>
      </div>
      <button
        type="button"
        onClick={() => onCopy(label, value)}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/70 px-2.5 py-2 text-[10px] font-medium text-slate-300 transition hover:border-cyan-500/40 hover:text-cyan-300"
      >
        {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

function StatusLadder({
  ladder,
  activeStep,
  tracked,
}: {
  ladder: Array<{ status: string; label: string }>;
  activeStep: number;
  tracked: Sep6Transaction | null;
}) {
  if (!tracked) return null;
  const failed = tracked.status === "error" || tracked.status === "expired";
  const completed = tracked.status === "completed";
  return (
    <div className="rounded-xl border border-slate-800/80 bg-slate-950/50 p-3">
      <div className="relative grid grid-cols-4 gap-1">
        <div className="absolute left-[12.5%] right-[12.5%] top-3 h-px bg-slate-800" />
        {ladder.map((step, index) => {
          const done = !failed && (index < activeStep || (completed && index === activeStep));
          const current = !failed && !completed && index === activeStep;
          return (
            <div
              key={step.status}
              className="relative z-10 flex min-w-0 flex-col items-center text-center"
            >
              <span
                className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[8px] ring-4 ring-slate-950 ${
                  done
                    ? "bg-emerald-400 text-slate-950"
                    : current
                      ? "border border-cyan-400 bg-slate-950 text-cyan-300"
                      : "border border-slate-700 bg-slate-950 text-slate-600"
                }`}
              >
                {done ? <Check className="h-2.5 w-2.5" /> : current ? <LoaderCircle className="h-2.5 w-2.5 animate-spin" /> : index + 1}
              </span>
              <span
                className={`mt-2 line-clamp-2 text-[9px] font-medium ${
                  done || current ? "text-slate-300" : "text-slate-600"
                }`}
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-3 border-t border-slate-800/80 pt-3 text-[10px] text-slate-500">
        <div className="flex justify-between">
          <span>Anchor status</span>
          <span className={failed ? "text-rose-300" : "text-slate-300"}>{tracked.status}</span>
        </div>
        {tracked.amountIn && (
          <div className="flex justify-between">
            <span>Amount in / out</span>
            <span className="text-slate-300">
              {tracked.amountIn} → {tracked.amountOut || "—"}
            </span>
          </div>
        )}
        {tracked.externalTransactionId && (
          <div className="flex justify-between">
            <span>Bank reference</span>
            <span className="text-slate-300">{tracked.externalTransactionId}</span>
          </div>
        )}
        {completed && tracked.stellarTransactionId ? (
          <a
            href={`https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(tracked.stellarTransactionId)}`}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 font-semibold text-emerald-300 transition hover:bg-emerald-500/15"
          >
            Open Stellar Payment
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
      </div>
    </div>
  );
}
