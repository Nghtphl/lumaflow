import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Banknote,
  Check,
  ExternalLink,
  Landmark,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  X,
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

type Flow = "none" | "deposit" | "withdraw";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export default function AnchorPanel({
  walletAddress,
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

  const [flow, setFlow] = useState<Flow>("none");
  const [busy, setBusy] = useState(false);

  const [tryAmount, setTryAmount] = useState("500");
  const [quote, setQuote] = useState<Sep38Price | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [deposit, setDeposit] = useState<DepositInstructions | null>(null);

  const [withdrawAmount, setWithdrawAmount] = useState("1");
  const [withdrawQuote, setWithdrawQuote] = useState<Sep38Price | null>(null);
  const [withdrawal, setWithdrawal] = useState<WithdrawInstructions | null>(null);
  const [paymentSent, setPaymentSent] = useState(false);

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
    if (!cfg || !walletAddress) return;
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

  const closeFlow = (): void => {
    stopPolling.current?.();
    stopPolling.current = null;
    setFlow("none");
    setTracked(null);
    setDeposit(null);
    setWithdrawal(null);
    setPaymentSent(false);
  };

  const requestDeposit = async (): Promise<void> => {
    if (!cfg || !walletAddress) return;
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
    if (!cfg || !walletAddress || !deposit) return;
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
    if (!cfg || !walletAddress) return;
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
    if (!cfg || !walletAddress || !withdrawal) return;
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

  const anchorLabel = useMemo(
    () => (cfg ? `${cfg.orgName} · ${cfg.homeDomain}` : ANCHOR_HOME_DOMAIN),
    [cfg],
  );

  return (
    <div className="mb-5 border border-slate-800 bg-zinc-950">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Landmark className="h-4 w-4 shrink-0 text-cyan-400" />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-white">Fund your vault</p>
            <p className="truncate font-mono text-[9px] text-slate-500">{anchorLabel}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refreshBalance()}
          className="text-slate-600 hover:text-cyan-300"
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
        <div className="px-3 py-3">
          <div className="mb-3 flex items-center justify-between border border-slate-800 bg-slate-950 px-3 py-2">
            <div>
              <p className="text-[9px] uppercase tracking-widest text-slate-500">
                {cfg.asset.code} (anchor)
              </p>
              <p className="font-mono text-sm text-white">{usdcBalance.toFixed(4)}</p>
            </div>
            {!walletAddress ? (
              <span className="font-mono text-[10px] text-slate-600">CONNECT WALLET</span>
            ) : trustlineReady ? (
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => void openDeposit()}
                  className="flex items-center gap-1.5 border border-cyan-500/50 bg-cyan-500/10 px-2.5 py-1.5 font-mono text-[10px] text-cyan-200 hover:border-cyan-400"
                >
                  <ArrowDownToLine className="h-3 w-3" />
                  DEPOSIT TRY
                </button>
                <button
                  type="button"
                  onClick={() => void openWithdraw()}
                  disabled={usdcBalance <= 0}
                  className="flex items-center gap-1.5 border border-slate-700 px-2.5 py-1.5 font-mono text-[10px] text-slate-300 hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ArrowUpFromLine className="h-3 w-3" />
                  TO IBAN
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void enableUsdc()}
                disabled={enablingTrustline}
                className="flex items-center gap-1.5 border border-amber-500/50 bg-amber-500/10 px-2.5 py-1.5 font-mono text-[10px] text-amber-200 disabled:cursor-wait"
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

          {walletAddress && !trustlineReady && (
            <p className="mb-3 text-[10px] leading-relaxed text-slate-500">
              Your Stellar account has to accept {cfg.asset.code} once before the
              anchor can pay you. It is a single signature and costs no fee beyond
              a small reserve.
            </p>
          )}

          {flow === "deposit" && (
            <div className="space-y-3 border-t border-slate-800 pt-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-medium tracking-widest text-slate-500">
                  DEPOSIT TRY
                </p>
                <button type="button" onClick={closeFlow} className="text-slate-600 hover:text-white">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              {!deposit && (
                <>
                  <label className="block">
                    <span className="mb-1.5 block text-[10px] tracking-widest text-slate-500">
                      AMOUNT
                    </span>
                    <div className="flex border border-slate-800 bg-zinc-950 focus-within:border-cyan-500/60">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={tryAmount}
                        onChange={(event) => setTryAmount(event.target.value.replace(",", "."))}
                        className="min-w-0 flex-1 bg-transparent px-3 py-2.5 font-mono text-sm text-white outline-none"
                      />
                      <span className="border-l border-slate-800 px-3 py-2.5 font-mono text-xs text-slate-500">
                        TRY
                      </span>
                    </div>
                  </label>

                  <div className="border border-slate-800 bg-slate-950 p-2.5 font-mono text-[10px]">
                    {quoteError ? (
                      <p className="text-rose-300">{quoteError}</p>
                    ) : quote ? (
                      <>
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
                      </>
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
                    className="flex w-full items-center justify-center gap-2 bg-cyan-500 py-2.5 text-[11px] font-bold tracking-wide text-slate-950 hover:bg-cyan-400 disabled:cursor-wait disabled:opacity-60"
                  >
                    {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Banknote className="h-3.5 w-3.5" />}
                    GET BANK INSTRUCTIONS
                  </button>
                </>
              )}

              {deposit && (
                <>
                  <div className="border border-slate-800 bg-slate-950 p-2.5">
                    {deposit.fields.map((field) => (
                      <div
                        key={`${field.label}-${field.value}`}
                        className="flex items-start justify-between gap-3 py-1 font-mono text-[10px]"
                      >
                        <span className="shrink-0 text-slate-500">{field.label}</span>
                        <span className="break-all text-right text-slate-200">{field.value}</span>
                      </div>
                    ))}
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
                    className="flex w-full items-center justify-center gap-2 border border-emerald-500/50 bg-emerald-500/10 py-2.5 font-mono text-[10px] tracking-wide text-emerald-200 hover:border-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    I SENT THE TRY (SIMULATE BANK TRANSFER)
                  </button>
                  <p className="text-[9px] leading-relaxed text-slate-600">
                    Sandbox only: a production anchor learns this from its bank. The
                    USDC payout that follows is a real testnet transaction.
                  </p>
                </>
              )}

              <StatusLadder ladder={ladder} activeStep={activeStep} tracked={tracked} />
            </div>
          )}

          {flow === "withdraw" && (
            <div className="space-y-3 border-t border-slate-800 pt-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-medium tracking-widest text-slate-500">
                  WITHDRAW TO IBAN
                </p>
                <button type="button" onClick={closeFlow} className="text-slate-600 hover:text-white">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              {!withdrawal && (
                <>
                  <label className="block">
                    <span className="mb-1.5 block text-[10px] tracking-widest text-slate-500">
                      AMOUNT
                    </span>
                    <div className="flex border border-slate-800 bg-zinc-950 focus-within:border-cyan-500/60">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={withdrawAmount}
                        onChange={(event) =>
                          setWithdrawAmount(event.target.value.replace(",", "."))
                        }
                        className="min-w-0 flex-1 bg-transparent px-3 py-2.5 font-mono text-sm text-white outline-none"
                      />
                      <span className="border-l border-slate-800 px-3 py-2.5 font-mono text-xs text-slate-500">
                        {cfg.asset.code}
                      </span>
                    </div>
                  </label>
                  <div className="border border-slate-800 bg-slate-950 p-2.5 font-mono text-[10px]">
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
                    className="flex w-full items-center justify-center gap-2 bg-cyan-500 py-2.5 text-[11px] font-bold tracking-wide text-slate-950 hover:bg-cyan-400 disabled:cursor-wait disabled:opacity-60"
                  >
                    {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpFromLine className="h-3.5 w-3.5" />}
                    START WITHDRAWAL
                  </button>
                </>
              )}

              {withdrawal && (
                <>
                  <div className="border border-slate-800 bg-slate-950 p-2.5 font-mono text-[10px]">
                    <div className="flex items-start justify-between gap-3 py-1">
                      <span className="text-slate-500">Treasury</span>
                      <span className="break-all text-right text-slate-200">
                        {withdrawal.accountId}
                      </span>
                    </div>
                    <div className="flex items-start justify-between gap-3 py-1">
                      <span className="text-slate-500">Memo ({withdrawal.memoType})</span>
                      <span className="break-all text-right text-slate-200">
                        {withdrawal.memo}
                      </span>
                    </div>
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
                </>
              )}

              <StatusLadder ladder={ladder} activeStep={activeStep} tracked={tracked} />
            </div>
          )}
        </div>
      )}
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
  return (
    <div className="border border-slate-800 bg-slate-950 p-2.5">
      <div className="space-y-1.5">
        {ladder.map((step, index) => {
          const done = !failed && index < activeStep;
          const current = !failed && index === activeStep;
          return (
            <div key={step.status} className="flex items-center gap-2">
              <span
                className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[8px] ${
                  done
                    ? "border-emerald-500 bg-emerald-500/10 text-emerald-400"
                    : current
                      ? "border-cyan-400 bg-cyan-500/10 text-cyan-300"
                      : "border-slate-800 text-slate-600"
                }`}
              >
                {done ? <Check className="h-2.5 w-2.5" /> : current ? <LoaderCircle className="h-2.5 w-2.5 animate-spin" /> : index + 1}
              </span>
              <span
                className={`font-mono text-[10px] ${
                  done || current ? "text-slate-300" : "text-slate-600"
                }`}
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-2 border-t border-slate-800 pt-2 font-mono text-[9px] text-slate-500">
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
        {tracked.stellarTransactionId && (
          <a
            href={`https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(tracked.stellarTransactionId)}`}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1.5 text-cyan-400 hover:text-cyan-300"
          >
            VIEW STELLAR PAYMENT
            <ExternalLink className="h-2.5 w-2.5" />
          </a>
        )}
      </div>
    </div>
  );
}
