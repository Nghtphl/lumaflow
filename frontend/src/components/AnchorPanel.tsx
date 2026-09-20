import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpRight,
  Banknote,
  Check,
  Copy,
  Info,
  Landmark,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
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
import { cn } from "../lib/cn";
import { AmountField } from "./ui/AmountField";
import { Badge } from "./ui/Badge";
import { Button, IconButton } from "./ui/Button";
import { Segmented } from "./ui/Segmented";
import { Stepper } from "./ui/Stepper";

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
  /** Shared SAC balance owned by App so every tab renders the same value. */
  usdcBalance: number;
  /** Re-reads XLM and USDC balances in App. */
  refreshBalances: () => Promise<void>;
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
}

type Flow = "deposit" | "withdraw";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export default function AnchorPanel({
  walletAddress,
  onRequireWallet,
  usdcBalance,
  refreshBalances,
  onRate,
  notify,
  onSettled,
}: AnchorPanelProps) {
  const [cfg, setCfg] = useState<AnchorConfig | null>(null);
  const [discoveryError, setDiscoveryError] = useState("");
  const [info, setInfo] = useState<Sep6Info | null>(null);

  const [trustlineReady, setTrustlineReady] = useState(false);
  const [enablingTrustline, setEnablingTrustline] = useState(false);

  const [flow, setFlow] = useState<Flow>("deposit");
  const [busy, setBusy] = useState(false);

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

  // Trustline readiness remains anchor-specific. The actual balance is read
  // globally from the SAC by App so it is available before this panel mounts.
  const refreshTrustline = useCallback(async (): Promise<void> => {
    if (!cfg || !walletAddress) return;
    try {
      const state = await getTrustlineState(cfg, walletAddress);
      setTrustlineReady(state.exists);
    } catch {
      // An unfunded or unreachable account is not an anchor failure.
    }
  }, [cfg, walletAddress]);

  const refreshPanelBalances = useCallback(async (): Promise<void> => {
    await Promise.all([refreshTrustline(), refreshBalances()]);
  }, [refreshBalances, refreshTrustline]);

  useEffect(() => {
    if (!walletAddress) {
      setTrustlineReady(false);
      return;
    }
    void refreshPanelBalances();
  }, [walletAddress, refreshPanelBalances]);

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
          // `total_price` carries this deposit's fee, so it answers "what would
          // buying this have cost" — but the console spends it on "what is a
          // USDC worth", across collateral and resting orders that have no
          // deposit behind them. `price` is the fee-free rate that question
          // wants, and it does not drift with the amount typed here.
          const rate = priced.price || priced.totalPrice;
          if (rate > 0) onRate(rate, `SEP-38 · ${cfg.orgName}`);
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
            void refreshPanelBalances();
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
    [notify, onSettled, refreshPanelBalances],
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
      await refreshPanelBalances();
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
      await refreshPanelBalances();
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

  const anchorLabel = useMemo(() => {
    if (!cfg) return ANCHOR_HOME_DOMAIN;
    // This anchor publishes its domain as its org name, so the pair renders as
    // the same string twice. Show it once rather than looking like a bug.
    return cfg.orgName === cfg.homeDomain
      ? cfg.homeDomain
      : `${cfg.orgName} · ${cfg.homeDomain}`;
  }, [cfg]);

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
    <div className="notranslate" translate="no">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <Landmark
            className="mt-1 size-4 shrink-0 text-ink-3"
            strokeWidth={2}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h3 className="text-heading text-ink">TRY bank bridge</h3>
            <p className="mt-1 truncate text-caption text-ink-4">{anchorLabel}</p>
          </div>
        </div>
        <IconButton
          label="Refresh bridge balance"
          size="sm"
          onClick={() => void refreshPanelBalances()}
        >
          <RefreshCw className="size-3.5" strokeWidth={2} aria-hidden="true" />
        </IconButton>
      </div>

      {discoveryError ? (
        <div className="mt-5 flex items-start gap-2.5">
          <TriangleAlert
            className="mt-0.5 size-4 shrink-0 text-negative-ink"
            strokeWidth={2}
            aria-hidden="true"
          />
          <p className="text-footnote leading-relaxed text-negative-ink">
            Anchor discovery failed: {discoveryError}
          </p>
        </div>
      ) : !cfg ? (
        <div className="mt-5 flex items-center gap-2.5">
          <LoaderCircle
            className="size-4 shrink-0 animate-spin text-ink-3"
            strokeWidth={2}
            aria-hidden="true"
          />
          <p className="text-footnote text-ink-3">Reading stellar.toml…</p>
        </div>
      ) : (
        <div className="mt-5">
          {/* Bridge account state */}
          <div className="flex flex-wrap items-end justify-between gap-4 border-t border-line pt-4">
            <div className="min-w-0">
              <p className="text-caption uppercase text-ink-4">Bridge balance</p>
              <p className="mt-1 font-mono text-2xl tnum text-ink">
                {usdcBalance.toFixed(2)}
                <span className="ml-1.5 text-footnote text-ink-3">{cfg.asset.code}</span>
              </p>
            </div>

            {!walletAddress ? (
              <Button size="sm" variant="primary" onClick={onRequireWallet}>
                Connect wallet
              </Button>
            ) : trustlineReady ? (
              <Badge
                tone="neutral"
                icon={<ShieldCheck className="size-3" strokeWidth={2.25} aria-hidden="true" />}
              >
                Trustline active
              </Badge>
            ) : (
              <Button
                size="sm"
                variant="primary"
                loading={enablingTrustline}
                onClick={() => void enableUsdc()}
                icon={<ShieldCheck className="size-3.5" strokeWidth={2} aria-hidden="true" />}
              >
                Enable {cfg.asset.code}
              </Button>
            )}
          </div>

          {walletAddress && !trustlineReady ? (
            <p className="mt-3 text-footnote leading-relaxed text-ink-3">
              Your Stellar account has to accept {cfg.asset.code} once before the
              anchor can pay you. One signature, and it costs nothing beyond a
              small reserve.
            </p>
          ) : null}

          <Segmented
            ariaLabel="Bank bridge direction"
            className="mt-4"
            value={flow}
            onChange={(next) => void (next === "deposit" ? openDeposit() : openWithdraw())}
            options={[
              {
                id: "deposit",
                label: "Deposit TRY",
                icon: <ArrowDownToLine className="size-3.5" strokeWidth={2} aria-hidden="true" />,
              },
              {
                id: "withdraw",
                label: "Withdraw TRY",
                icon: <ArrowUpFromLine className="size-3.5" strokeWidth={2} aria-hidden="true" />,
              },
            ]}
          />

          {/* ── Deposit ────────────────────────────────────────────────── */}
          {flow === "deposit" ? (
            <div key="deposit-flow" className="mt-5 space-y-4">
              {!deposit && (
                <div key="deposit-form" className="space-y-4">
                  <AmountField
                    label="You send"
                    unit="TRY"
                    value={tryAmount}
                    onChange={setTryAmount}
                    aside={`Limits ${minTry}–${maxTry} TRY`}
                    invalid={
                      Number(tryAmount.replace(",", ".")) > 0 &&
                      (Number(tryAmount.replace(",", ".")) < minTry ||
                        Number(tryAmount.replace(",", ".")) > maxTry)
                    }
                  />

                  <div className="border-t border-line">
                    {quoteError ? (
                      <BridgeRow label="Quote" value={quoteError} tone="negative" last />
                    ) : quote ? (
                      <div key="deposit-quote">
                        <BridgeRow
                          label="You receive"
                          value={`≈ ${previewUsdc.toFixed(7)} ${cfg.asset.code}`}
                          tone="accent"
                        />
                        <BridgeRow
                          label="Rate"
                          value={`1 ${cfg.asset.code} = ${(quote.price || quote.totalPrice).toFixed(4)} TRY`}
                        />
                        <BridgeRow
                          label="Anchor fee"
                          value={`${quote.feeTotal.toFixed(2)} TRY`}
                          last
                        />
                      </div>
                    ) : (
                      <BridgeRow label="Quote" value="Pricing…" last />
                    )}
                  </div>

                  <p className="text-caption leading-relaxed text-ink-4">
                    SEP-38 · {cfg.orgName}. Indicative price, not a locked quote.
                  </p>

                  <Button
                    variant="primary"
                    size="lg"
                    block
                    loading={busy}
                    onClick={() => void requestDeposit()}
                    icon={<Banknote className="size-4" strokeWidth={2} aria-hidden="true" />}
                  >
                    Get bank instructions
                  </Button>
                </div>
              )}

              {deposit && (
                <div key="deposit-instructions" className="space-y-4">
                  <div className="border-t border-line">
                    <CopyDetail
                      label="Bank name"
                      value="TR Mock Bank A.Ş."
                      copied={copied === "Bank name"}
                      onCopy={copyValue}
                    />
                    <CopyDetail
                      label="IBAN"
                      value={depositIban}
                      copied={copied === "IBAN"}
                      onCopy={copyValue}
                    />
                    <CopyDetail
                      label="Transfer reference"
                      value={deposit.reference || "—"}
                      copied={copied === "Transfer reference"}
                      onCopy={copyValue}
                      last
                    />
                  </div>

                  {deposit.reference ? (
                    <Callout tone="warning">
                      The reference is how the anchor recognises your transfer. A
                      payment without it cannot be matched.
                    </Callout>
                  ) : null}

                  <Button
                    size="lg"
                    block
                    loading={busy}
                    disabled={tracked ? isTerminal(tracked.status) : false}
                    onClick={() => void confirmBankTransfer()}
                    icon={<Check className="size-4" strokeWidth={2.25} aria-hidden="true" />}
                  >
                    I sent the TRY — simulate the transfer
                  </Button>

                  <p className="text-caption leading-relaxed text-ink-4">
                    Sandbox only: a production anchor learns this from its bank.
                    The USDC payout that follows is a real testnet transaction.
                  </p>
                </div>
              )}

              <BridgeStatus ladder={ladder} activeStep={activeStep} tracked={tracked} />
            </div>
          ) : null}

          {/* ── Withdraw ───────────────────────────────────────────────── */}
          {flow === "withdraw" ? (
            <div key="withdraw-flow" className="mt-5 space-y-4">
              {!withdrawal && (
                <div key="withdraw-form" className="space-y-4">
                  <AmountField
                    label="You send"
                    unit={cfg.asset.code}
                    value={withdrawAmount}
                    onChange={setWithdrawAmount}
                    aside={`Minimum ${minUsdc} ${cfg.asset.code}`}
                  />

                  <div className="border-t border-line">
                    <BridgeRow
                      label="You receive"
                      value={`≈ ${withdrawPreviewTry.toFixed(2)} TRY`}
                      tone="accent"
                      last
                    />
                  </div>

                  <p className="text-caption leading-relaxed text-ink-4">
                    The lira leg is simulated in this sandbox. The Stellar payment
                    that funds it is real.
                  </p>

                  <Button
                    variant="primary"
                    size="lg"
                    block
                    loading={busy}
                    onClick={() => void requestWithdraw()}
                    icon={<ArrowUpFromLine className="size-4" strokeWidth={2} aria-hidden="true" />}
                  >
                    Start withdrawal
                  </Button>
                </div>
              )}

              {withdrawal && (
                <div key="withdraw-instructions" className="space-y-4">
                  <div className="border-t border-line">
                    <CopyDetail
                      label="Treasury"
                      value={withdrawal.accountId}
                      copied={copied === "Treasury"}
                      onCopy={copyValue}
                    />
                    <CopyDetail
                      label={`Memo (${withdrawal.memoType})`}
                      value={withdrawal.memo}
                      copied={copied === `Memo (${withdrawal.memoType})`}
                      onCopy={copyValue}
                      last
                    />
                  </div>

                  <Callout tone="warning">
                    The memo is the only link between your payment and this
                    withdrawal. Use the button below so it is attached for you.
                  </Callout>

                  <Button
                    size="lg"
                    block
                    loading={busy}
                    disabled={paymentSent}
                    onClick={() => void payWithdrawal()}
                    icon={<Check className="size-4" strokeWidth={2.25} aria-hidden="true" />}
                  >
                    {paymentSent ? "Payment sent" : `Sign & send ${cfg.asset.code} with memo`}
                  </Button>
                </div>
              )}

              <BridgeStatus ladder={ladder} activeStep={activeStep} tracked={tracked} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function BridgeRow({
  label,
  value,
  tone = "neutral",
  last = false,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "accent" | "negative";
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
      <span
        className={cn(
          "min-w-0 truncate text-right font-mono text-footnote tnum",
          tone === "accent"
            ? "text-accent-ink"
            : tone === "negative"
              ? "text-negative-ink"
              : "text-ink",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function Callout({
  tone,
  children,
}: {
  tone: "warning" | "info";
  children: ReactNode;
}) {
  const Icon = tone === "warning" ? TriangleAlert : Info;
  return (
    <div className="flex items-start gap-2.5">
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "warning" ? "text-warning-ink" : "text-accent-ink",
        )}
        strokeWidth={2}
        aria-hidden="true"
      />
      <p className="text-footnote leading-relaxed text-ink-2">{children}</p>
    </div>
  );
}

function CopyDetail({
  label,
  value,
  copied,
  onCopy,
  last = false,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: (label: string, value: string) => void;
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 py-3",
        !last && "border-b border-line",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-caption uppercase text-ink-4">{label}</p>
        <p className="mt-1 break-all font-mono text-footnote text-ink">{value}</p>
      </div>
      <Button
        size="sm"
        variant="quiet"
        onClick={() => onCopy(label, value)}
        icon={
          copied ? (
            <Check className="size-3.5 text-positive-ink" strokeWidth={2.5} aria-hidden="true" />
          ) : (
            <Copy className="size-3.5" strokeWidth={2} aria-hidden="true" />
          )
        }
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function BridgeStatus({
  ladder,
  activeStep,
  tracked,
}: {
  ladder: ReadonlyArray<{ status: string; label: string }>;
  activeStep: number;
  tracked: Sep6Transaction | null;
}) {
  if (!tracked) return null;
  const failed = tracked.status === "error" || tracked.status === "expired";
  const completed = tracked.status === "completed";

  return (
    <div className="border-t border-line pt-5">
      <Stepper
        steps={ladder.map((step) => step.label)}
        current={activeStep}
        complete={completed}
        failed={failed}
      />

      <dl className="mt-5 space-y-2 border-t border-line pt-4">
        <div className="flex items-center justify-between gap-4">
          <dt className="text-footnote text-ink-3">Anchor status</dt>
          <dd
            className={cn(
              "font-mono text-footnote",
              failed ? "text-negative-ink" : completed ? "text-positive-ink" : "text-ink",
            )}
          >
            {tracked.status}
          </dd>
        </div>
        {tracked.amountIn ? (
          <div className="flex items-center justify-between gap-4">
            <dt className="text-footnote text-ink-3">Amount in / out</dt>
            <dd className="min-w-0 truncate font-mono text-footnote tnum text-ink">
              {tracked.amountIn} → {tracked.amountOut || "—"}
            </dd>
          </div>
        ) : null}
        {tracked.externalTransactionId ? (
          <div className="flex items-center justify-between gap-4">
            <dt className="text-footnote text-ink-3">Bank reference</dt>
            <dd className="min-w-0 truncate font-mono text-footnote text-ink">
              {tracked.externalTransactionId}
            </dd>
          </div>
        ) : null}
      </dl>

      {completed && tracked.stellarTransactionId ? (
        <a
          href={`https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(tracked.stellarTransactionId)}`}
          target="_blank"
          rel="noreferrer"
          className="group mt-4 inline-flex items-center gap-1.5 text-footnote font-medium text-accent-ink transition-colors hover:text-accent-hover"
        >
          Open the Stellar payment
          <ArrowUpRight
            className="size-3.5 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
            strokeWidth={2.25}
            aria-hidden="true"
          />
        </a>
      ) : null}
    </div>
  );
}
