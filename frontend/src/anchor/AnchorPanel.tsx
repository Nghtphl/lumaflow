import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Banknote,
  Check,
  Copy,
  ExternalLink,
  Landmark,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import type { AnchorState } from "./useAnchor";
import { authenticate, jwtProvider, withAuth } from "./sep10";
import { ensureTrustline } from "./trustline";
import {
  DEPOSIT_LADDER,
  WITHDRAW_LADDER,
  getTransaction,
  isTerminal,
  ladderIndex,
  pollTransaction,
  sendWithdrawalPayment,
  simulateBankTransfer,
  startDeposit,
  startWithdraw,
} from "./sep6";
import type {
  DepositInstructions,
  Sep6Transaction,
  WithdrawInstructions,
} from "./sep6";
import {
  FIAT_CODE,
  formatTry,
  priceTryToUsdc,
  priceUsdcToTry,
} from "./sep38";
import type { Sep38Price } from "./sep38";

type RampMode = "deposit" | "withdraw";

interface AnchorPanelProps {
  anchor: AnchorState;
  walletAddress: string;
  onNotice: (
    type: "success" | "error" | "info",
    title: string,
    detail: string,
    txHash?: string,
  ) => void;
  /** Fired whenever settled funds may have moved, so the vault view can resync. */
  onSettled: () => void;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const stroopString = (value: number): string => value.toFixed(7);

export default function AnchorPanel({
  anchor,
  walletAddress,
  onNotice,
  onSettled,
}: AnchorPanelProps) {
  const { config, configError, rates, ratesError, balances, refreshBalances } = anchor;

  const [mode, setMode] = useState<RampMode>("deposit");
  const [tryAmount, setTryAmount] = useState("500");
  const [usdcAmount, setUsdcAmount] = useState("5");
  const [iban, setIban] = useState("");
  const [preview, setPreview] = useState<Sep38Price | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [busy, setBusy] = useState("");
  const [depositOrder, setDepositOrder] = useState<DepositInstructions | null>(null);
  const [withdrawOrder, setWithdrawOrder] = useState<WithdrawInstructions | null>(null);
  const [transaction, setTransaction] = useState<Sep6Transaction | null>(null);
  const [copied, setCopied] = useState("");
  const stopPolling = useRef<(() => void) | null>(null);

  const trustlineMissing = Boolean(balances && balances.anchorAsset === null);
  const assetCode = config?.asset.code || "USDC";
  const amount = mode === "deposit" ? tryAmount : usdcAmount;

  useEffect(
    () => () => {
      stopPolling.current?.();
    },
    [],
  );

  // Live SEP-38 preview, debounced so typing does not hammer the quote server.
  useEffect(() => {
    if (!config) return;
    const parsed = Number(amount.replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setPreview(null);
      setPreviewError("");
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const quote =
            mode === "deposit"
              ? await priceTryToUsdc(config, parsed.toFixed(2))
              : await priceUsdcToTry(config, stroopString(parsed));
          if (cancelled) return;
          setPreview(quote);
          setPreviewError("");
        } catch (error) {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(describe(error));
        }
      })();
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [config, mode, amount]);

  const watch = useCallback(
    (id: string) => {
      if (!config || !walletAddress) return;
      stopPolling.current?.();
      stopPolling.current = pollTransaction(
        config,
        jwtProvider(config, walletAddress),
        id,
        (next) => {
          setTransaction(next);
          if (isTerminal(next.status)) {
            void refreshBalances();
            onSettled();
            if (next.status === "completed") {
              onNotice(
                "success",
                next.kind === "deposit"
                  ? `Deposit settled: ${next.amountOut} ${assetCode}`
                  : `Withdrawal settled: ${formatTry(Number(next.amountOut) || 0)}`,
                next.kind === "deposit"
                  ? `${next.amountIn} ${FIAT_CODE} converted at the anchor.`
                  : `Bank reference ${next.externalTransactionId || "issued"}.`,
                next.stellarTransactionId || undefined,
              );
            } else {
              onNotice(
                "error",
                `Anchor transfer ${next.status}`,
                next.statusMessage || "The anchor ended this transfer without settling it.",
              );
            }
          }
        },
        (error) => setPreviewError(describe(error)),
      );
    },
    [config, walletAddress, assetCode, refreshBalances, onSettled, onNotice],
  );

  const resetFlow = (): void => {
    stopPolling.current?.();
    stopPolling.current = null;
    setDepositOrder(null);
    setWithdrawOrder(null);
    setTransaction(null);
    setPreviewError("");
  };

  const copy = (label: string, value: string): void => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(label);
        window.setTimeout(() => setCopied(""), 1_500);
      })
      .catch(() => undefined);
  };

  const handleEnableAsset = async (): Promise<void> => {
    if (!config || !walletAddress) return;
    setBusy("trustline");
    try {
      const created = await ensureTrustline(config, walletAddress);
      await refreshBalances();
      onNotice(
        "success",
        created ? `${assetCode} enabled` : `${assetCode} already enabled`,
        created
          ? `Your account can now receive ${assetCode} from ${config.orgName}.`
          : "No change was needed.",
      );
    } catch (error) {
      onNotice("error", `Could not enable ${assetCode}`, describe(error));
    } finally {
      setBusy("");
    }
  };

  const handleStartDeposit = async (): Promise<void> => {
    if (!config || !walletAddress) return;
    const parsed = Number(tryAmount.replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      onNotice("error", "Invalid amount", `Enter the ${FIAT_CODE} amount you will transfer.`);
      return;
    }
    resetFlow();
    setBusy("deposit");
    try {
      await authenticate(config, walletAddress);
      const order = await withAuth(config, walletAddress, (jwt) =>
        startDeposit(config, jwt, {
          account: walletAddress,
          amount: parsed.toFixed(2),
        }),
      );
      setDepositOrder(order);
      const current = await withAuth(config, walletAddress, (jwt) =>
        getTransaction(config, jwt, order.id),
      );
      setTransaction(current);
      watch(order.id);
    } catch (error) {
      onNotice("error", "Deposit could not be opened", describe(error));
    } finally {
      setBusy("");
    }
  };

  const handleSimulateTransfer = async (): Promise<void> => {
    if (!config || !walletAddress || !depositOrder) return;
    setBusy("simulate");
    try {
      const parsed = Number(tryAmount.replace(",", ".")) || 0;
      await withAuth(config, walletAddress, (jwt) =>
        simulateBankTransfer(config, jwt, depositOrder.id, parsed.toFixed(2)),
      );
      onNotice(
        "info",
        "Bank transfer simulated",
        `${config.orgName} is converting ${parsed.toFixed(2)} ${FIAT_CODE} and paying ${assetCode} on Stellar.`,
      );
      watch(depositOrder.id);
    } catch (error) {
      onNotice("error", "Simulation failed", describe(error));
    } finally {
      setBusy("");
    }
  };

  const handleStartWithdraw = async (): Promise<void> => {
    if (!config || !walletAddress) return;
    const parsed = Number(usdcAmount.replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      onNotice("error", "Invalid amount", `Enter the ${assetCode} amount to off-ramp.`);
      return;
    }
    if (balances && balances.anchorAsset !== null && parsed > balances.anchorAsset) {
      onNotice(
        "error",
        "Insufficient balance",
        `You hold ${balances.anchorAsset.toFixed(7)} ${assetCode}.`,
      );
      return;
    }
    resetFlow();
    setBusy("withdraw");
    try {
      await authenticate(config, walletAddress);
      const order = await withAuth(config, walletAddress, (jwt) =>
        startWithdraw(config, jwt, {
          amount: stroopString(parsed),
          dest: iban.trim() || undefined,
        }),
      );
      setWithdrawOrder(order);
      const current = await withAuth(config, walletAddress, (jwt) =>
        getTransaction(config, jwt, order.id),
      );
      setTransaction(current);
    } catch (error) {
      onNotice("error", "Withdrawal could not be opened", describe(error));
    } finally {
      setBusy("");
    }
  };

  const handleSendWithdrawalPayment = async (): Promise<void> => {
    if (!config || !walletAddress || !withdrawOrder) return;
    setBusy("pay");
    try {
      const parsed = Number(usdcAmount.replace(",", ".")) || 0;
      const hash = await sendWithdrawalPayment(
        config,
        walletAddress,
        withdrawOrder,
        stroopString(parsed),
      );
      onNotice(
        "success",
        `${assetCode} sent to the anchor treasury`,
        `Memo ${withdrawOrder.memo} attached — this is what identifies your withdrawal.`,
        hash,
      );
      await refreshBalances();
      watch(withdrawOrder.id);
    } catch (error) {
      onNotice("error", "Payment failed", describe(error));
    } finally {
      setBusy("");
    }
  };

  if (configError) {
    return (
      <PanelShell title="FIAT RAIL" subtitle="Anchor discovery failed">
        <div className="flex items-start gap-2 border border-rose-500/40 bg-rose-500/5 p-3 text-[11px] text-rose-200">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="break-words">{configError}</span>
        </div>
      </PanelShell>
    );
  }

  if (!config) {
    return (
      <PanelShell title="FIAT RAIL" subtitle="Reading stellar.toml…">
        <div className="flex items-center gap-2 font-mono text-[11px] text-slate-500">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin text-cyan-400" />
          SEP-1 DISCOVERY
        </div>
      </PanelShell>
    );
  }

  const ladder = mode === "deposit" ? DEPOSIT_LADDER : WITHDRAW_LADDER;
  const activeStep = transaction ? ladderIndex(ladder, transaction.status) : -1;
  const failed = Boolean(
    transaction && isTerminal(transaction.status) && transaction.status !== "completed",
  );

  return (
    <PanelShell
      title="FIAT RAIL"
      subtitle={`${config.orgName} · SEP-1/6/10/38`}
      action={
        <a
          href={`https://${config.homeDomain}/.well-known/stellar.toml`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 font-mono text-[10px] text-slate-500 hover:text-cyan-300"
        >
          {config.homeDomain}
          <ExternalLink className="h-3 w-3" />
        </a>
      }
    >
      <p className="mb-4 border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[10px] leading-relaxed text-amber-200/90">
        Sandbox TRY anchor: the bank and KYC legs are simulated, the Stellar leg is
        real testnet {assetCode}. The same SEP-6 client works against a production
        anchor by changing the home domain.
      </p>

      <div className="mb-4 grid grid-cols-2 gap-px border border-slate-800 bg-slate-800">
        <Stat
          label={`${assetCode} (ANCHOR)`}
          value={
            balances?.anchorAsset === null
              ? "NOT ENABLED"
              : (balances?.anchorAsset ?? 0).toFixed(7)
          }
          muted={balances?.anchorAsset === null}
        />
        <Stat label="XLM" value={(balances?.native ?? 0).toFixed(4)} />
      </div>

      {!walletAddress && (
        <p className="mb-4 border border-slate-800 bg-zinc-950 px-3 py-2 text-[11px] text-slate-500">
          Connect Freighter to move lira in or out.
        </p>
      )}

      {walletAddress && trustlineMissing && (
        <div className="mb-4 border border-cyan-500/30 bg-cyan-500/5 p-3">
          <p className="text-[11px] leading-relaxed text-slate-300">
            Your Stellar account has not opted into {assetCode} yet, so the anchor
            has nowhere to pay. This is a one-time, free setup step.
          </p>
          <button
            type="button"
            onClick={() => void handleEnableAsset()}
            disabled={busy === "trustline"}
            className="mt-3 flex w-full items-center justify-center gap-2 bg-cyan-500 py-2.5 text-[11px] font-bold tracking-wide text-slate-950 hover:bg-cyan-400 disabled:cursor-wait disabled:opacity-60"
          >
            {busy === "trustline" ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5" />
            )}
            ENABLE {assetCode}
          </button>
        </div>
      )}

      <div className="mb-4 border border-slate-800 bg-zinc-950 p-3">
        <div className="flex items-center justify-between">
          <span className="text-[9px] uppercase tracking-widest text-slate-500">
            Live {FIAT_CODE}/{assetCode}
          </span>
          <button
            type="button"
            onClick={() => void anchor.refreshRates()}
            className="text-slate-600 hover:text-cyan-300"
            aria-label="Refresh anchor rate"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
        {rates ? (
          <>
            <div className="mt-2 flex items-baseline justify-between font-mono text-xs">
              <span className="text-slate-500">BUY</span>
              <span className="text-white">
                1 {assetCode} = {formatTry(rates.depositTryPerUsdc)}
              </span>
            </div>
            <div className="mt-1 flex items-baseline justify-between font-mono text-xs">
              <span className="text-slate-500">SELL</span>
              <span className="text-white">
                1 {assetCode} = {formatTry(rates.withdrawTryPerUsdc)}
              </span>
            </div>
            <p className="mt-2 text-[9px] leading-relaxed text-slate-600">
              Reflector USD/TRY oracle + anchor spread · quoted{" "}
              {rates.quotedAt.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </p>
          </>
        ) : (
          <p className="mt-2 font-mono text-[11px] text-slate-600">
            {ratesError || "Fetching SEP-38 quote…"}
          </p>
        )}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-px border border-slate-800 bg-slate-800">
        {(
          [
            { id: "deposit", label: "DEPOSIT TRY", icon: <ArrowDownToLine className="h-3.5 w-3.5" /> },
            { id: "withdraw", label: "WITHDRAW TO IBAN", icon: <ArrowUpFromLine className="h-3.5 w-3.5" /> },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              setMode(item.id);
              resetFlow();
            }}
            className={`flex items-center justify-center gap-1.5 py-2.5 font-mono text-[10px] tracking-wide ${
              mode === item.id
                ? "bg-slate-900 text-cyan-300"
                : "bg-zinc-950 text-slate-500 hover:text-slate-300"
            }`}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>

      {mode === "deposit" ? (
        <div className="space-y-3">
          <AmountField
            label={`AMOUNT TO TRANSFER`}
            suffix={FIAT_CODE}
            value={tryAmount}
            onChange={setTryAmount}
            disabled={Boolean(depositOrder) || busy !== ""}
          />
          {!depositOrder && (
            <div className="grid grid-cols-3 gap-1.5">
              {["100", "500", "1000"].map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTryAmount(value)}
                  className="border border-slate-800 bg-zinc-950 py-1.5 font-mono text-[10px] text-slate-400 hover:border-cyan-500/50 hover:text-cyan-300"
                >
                  {value} TL
                </button>
              ))}
            </div>
          )}

          <PreviewBox
            preview={preview}
            error={previewError}
            fromLabel={FIAT_CODE}
            toLabel={assetCode}
            mode="deposit"
          />

          {!depositOrder ? (
            <button
              type="button"
              onClick={() => void handleStartDeposit()}
              disabled={!walletAddress || trustlineMissing || busy !== ""}
              className="flex w-full items-center justify-center gap-2 bg-cyan-500 py-3 text-xs font-bold tracking-wide text-slate-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "deposit" ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Landmark className="h-4 w-4" />
              )}
              GET IBAN &amp; REFERENCE
            </button>
          ) : (
            <>
              <InstructionCard
                fields={depositOrder.fields}
                copied={copied}
                onCopy={copy}
              />
              <button
                type="button"
                onClick={() => void handleSimulateTransfer()}
                disabled={busy !== "" || (transaction ? activeStep >= 2 : false)}
                className="flex w-full items-center justify-center gap-2 border border-emerald-500/50 bg-emerald-500/10 py-3 text-xs font-bold tracking-wide text-emerald-200 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy === "simulate" ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Banknote className="h-4 w-4" />
                )}
                I SENT THE TRANSFER (SIMULATE BANK)
              </button>
              <p className="text-[9px] leading-relaxed text-slate-600">
                Sandbox shortcut for the moment a real bank confirms the incoming
                FAST/EFT transfer. On a production anchor this button does not exist —
                the bank tells the anchor.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <AmountField
            label="AMOUNT TO OFF-RAMP"
            suffix={assetCode}
            value={usdcAmount}
            onChange={setUsdcAmount}
            disabled={Boolean(withdrawOrder) || busy !== ""}
          />
          {!withdrawOrder && balances?.anchorAsset ? (
            <button
              type="button"
              onClick={() => setUsdcAmount(balances.anchorAsset!.toFixed(7))}
              className="w-full border border-slate-800 bg-zinc-950 py-1.5 font-mono text-[10px] text-slate-400 hover:border-cyan-500/50 hover:text-cyan-300"
            >
              MAX {balances.anchorAsset.toFixed(7)} {assetCode}
            </button>
          ) : null}

          <label className="block">
            <span className="mb-2 block text-[10px] font-medium tracking-widest text-slate-500">
              DESTINATION IBAN (OPTIONAL)
            </span>
            <input
              type="text"
              value={iban}
              disabled={Boolean(withdrawOrder) || busy !== ""}
              onChange={(event) => setIban(event.target.value.toUpperCase())}
              placeholder="TR00 0000 0000 0000 0000 0000 00"
              className="w-full border border-slate-800 bg-zinc-950 px-3 py-3 font-mono text-xs text-white outline-none placeholder:text-slate-700 focus:border-cyan-500/60 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>

          <PreviewBox
            preview={preview}
            error={previewError}
            fromLabel={assetCode}
            toLabel={FIAT_CODE}
            mode="withdraw"
          />

          {!withdrawOrder ? (
            <button
              type="button"
              onClick={() => void handleStartWithdraw()}
              disabled={!walletAddress || busy !== ""}
              className="flex w-full items-center justify-center gap-2 bg-cyan-500 py-3 text-xs font-bold tracking-wide text-slate-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "withdraw" ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Landmark className="h-4 w-4" />
              )}
              REQUEST PAYOUT DETAILS
            </button>
          ) : (
            <>
              <div className="border border-slate-800 bg-zinc-950 p-3">
                <CopyRow
                  label="TREASURY"
                  value={withdrawOrder.accountId}
                  copied={copied}
                  onCopy={copy}
                />
                <CopyRow
                  label={`MEMO (${withdrawOrder.memoType.toUpperCase()})`}
                  value={withdrawOrder.memo}
                  copied={copied}
                  onCopy={copy}
                />
                <p className="mt-2 flex items-start gap-1.5 text-[9px] leading-relaxed text-amber-300/80">
                  <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                  The memo is the only link between this payment and your payout.
                  A transfer without it cannot be matched to you.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleSendWithdrawalPayment()}
                disabled={busy !== "" || activeStep >= WITHDRAW_LADDER.length - 1}
                className="flex w-full items-center justify-center gap-2 border border-emerald-500/50 bg-emerald-500/10 py-3 text-xs font-bold tracking-wide text-emerald-200 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy === "pay" ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <ShieldCheck className="h-4 w-4" />
                )}
                SIGN &amp; SEND {usdcAmount} {assetCode}
              </button>
            </>
          )}
        </div>
      )}

      {transaction && (
        <div className="mt-4 border-t border-slate-800 pt-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-[10px] font-medium tracking-widest text-slate-500">
              ANCHOR STATUS
            </p>
            <button
              type="button"
              onClick={resetFlow}
              className="font-mono text-[10px] text-slate-600 hover:text-slate-300"
            >
              NEW TRANSFER
            </button>
          </div>
          <Ladder steps={ladder} activeStep={activeStep} failed={failed} />
          <p className="mt-3 font-mono text-[10px] text-slate-500">
            {transaction.status.toUpperCase().replace(/_/g, " ")}
            {transaction.statusMessage ? ` · ${transaction.statusMessage}` : ""}
          </p>
          {transaction.status === "pending_trust" && (
            <p className="mt-2 border border-amber-500/30 bg-amber-500/5 p-2 text-[10px] text-amber-200">
              The anchor is holding your {assetCode} because the account has no
              trustline. Enable {assetCode} above and it will be released.
            </p>
          )}
          {(transaction.amountIn || transaction.amountOut) && (
            <div className="mt-3 border border-slate-800 bg-zinc-950 p-3 font-mono text-[10px]">
              <Row label="Amount in" value={`${transaction.amountIn ?? "—"} ${labelFor(transaction.amountInAsset)}`} />
              <Row label="Anchor fee" value={`${transaction.amountFee ?? "—"} ${labelFor(transaction.amountFeeAsset)}`} />
              <Row label="Amount out" value={`${transaction.amountOut ?? "—"} ${labelFor(transaction.amountOutAsset)}`} />
              {transaction.externalTransactionId && (
                <Row label="Bank reference" value={transaction.externalTransactionId} />
              )}
            </div>
          )}
          {transaction.stellarTransactionId && (
            <a
              href={`https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(transaction.stellarTransactionId)}`}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 font-mono text-[10px] text-cyan-400 hover:text-cyan-300"
            >
              STELLAR PAYMENT ON STELLAREXPERT
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      )}
    </PanelShell>
  );
}

const labelFor = (asset: string | null | undefined): string => {
  if (!asset) return "";
  if (asset.startsWith("iso4217:")) return asset.slice("iso4217:".length);
  const parts = asset.split(":");
  return parts.length > 1 ? parts[1] : asset;
};

function PanelShell({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-slate-800 bg-slate-950 p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Banknote className="h-4 w-4 text-cyan-400" />
            <h2 className="text-sm font-semibold text-white">{title}</h2>
          </div>
          <p className="mt-1 text-[11px] text-slate-500">{subtitle}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="bg-zinc-950 px-3 py-2.5">
      <p className="text-[9px] uppercase tracking-widest text-slate-500">{label}</p>
      <p className={`mt-1 font-mono text-xs ${muted ? "text-amber-300" : "text-white"}`}>{value}</p>
    </div>
  );
}

function AmountField({
  label,
  suffix,
  value,
  onChange,
  disabled,
}: {
  label: string;
  suffix: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-[10px] font-medium tracking-widest text-slate-500">
        {label}
      </span>
      <div
        className={`flex border border-slate-800 bg-zinc-950 focus-within:border-cyan-500/60 ${
          disabled ? "opacity-50" : ""
        }`}
      >
        <input
          type="text"
          inputMode="decimal"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value.replace(",", "."))}
          className="min-w-0 flex-1 bg-transparent px-3 py-3 font-mono text-sm text-white outline-none disabled:cursor-not-allowed"
        />
        <span className="border-l border-slate-800 px-3 py-3 font-mono text-xs text-slate-500">
          {suffix}
        </span>
      </div>
    </label>
  );
}

function PreviewBox({
  preview,
  error,
  fromLabel,
  toLabel,
  mode,
}: {
  preview: Sep38Price | null;
  error: string;
  fromLabel: string;
  toLabel: string;
  mode: RampMode;
}) {
  if (error) {
    return (
      <p className="border border-rose-500/30 bg-rose-500/5 p-3 font-mono text-[10px] text-rose-300">
        {error}
      </p>
    );
  }
  if (!preview) {
    return (
      <p className="border border-slate-800 bg-zinc-950 p-3 font-mono text-[10px] text-slate-600">
        Enter an amount for a live SEP-38 quote.
      </p>
    );
  }
  const rate =
    mode === "deposit"
      ? preview.buyAmount > 0
        ? preview.sellAmount / preview.buyAmount
        : 0
      : preview.sellAmount > 0
        ? preview.buyAmount / preview.sellAmount
        : 0;
  return (
    <div className="border border-cyan-500/25 bg-cyan-500/5 p-3 font-mono text-[10px]">
      <Row
        label="You send"
        value={`${preview.sellAmount.toFixed(mode === "deposit" ? 2 : 7)} ${fromLabel}`}
      />
      <Row
        label="Anchor spread"
        value={`${preview.feeTotal} ${labelFor(preview.feeAsset)}`}
      />
      <Row
        label="You receive"
        value={`${preview.buyAmount.toFixed(mode === "deposit" ? 7 : 2)} ${toLabel}`}
        strong
      />
      <Row label="Effective rate" value={`1 ${mode === "deposit" ? toLabel : fromLabel} = ${formatTry(rate)}`} />
    </div>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      className={`flex items-center justify-between gap-3 py-1 ${
        strong ? "mt-1 border-t border-slate-800 pt-2" : ""
      }`}
    >
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className={`truncate text-right ${strong ? "text-cyan-300" : "text-slate-300"}`}>
        {value}
      </span>
    </div>
  );
}

function CopyRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: string;
  onCopy: (label: string, value: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <span className="shrink-0 font-mono text-[9px] uppercase tracking-widest text-slate-500">
        {label}
      </span>
      <button
        type="button"
        onClick={() => onCopy(label, value)}
        className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-slate-200 hover:text-cyan-300"
      >
        <span className="truncate">{value}</span>
        {copied === label ? (
          <Check className="h-3 w-3 shrink-0 text-emerald-400" />
        ) : (
          <Copy className="h-3 w-3 shrink-0 text-slate-600" />
        )}
      </button>
    </div>
  );
}

function InstructionCard({
  fields,
  copied,
  onCopy,
}: {
  fields: DepositInstructions["fields"];
  copied: string;
  onCopy: (label: string, value: string) => void;
}) {
  if (fields.length === 0) {
    return (
      <p className="border border-slate-800 bg-zinc-950 p-3 text-[11px] leading-relaxed text-slate-300">
        The anchor has not provided bank transfer instructions.
      </p>
    );
  }
  return (
    <div className="border border-slate-800 bg-zinc-950 p-3">
      {fields.map((field, index) => (
        <CopyRow
          key={`${field.label}-${index}`}
          label={field.label}
          value={field.value}
          copied={copied}
          onCopy={onCopy}
        />
      ))}
    </div>
  );
}

function Ladder({
  steps,
  activeStep,
  failed,
}: {
  steps: Array<{ label: string }>;
  activeStep: number;
  failed: boolean;
}) {
  return (
    <div className="space-y-2">
      {steps.map((step, index) => {
        const done = activeStep > index || (activeStep === steps.length - 1 && !failed && activeStep === index);
        const current = activeStep === index && !done;
        const isFailure = failed && activeStep === index;
        return (
          <div key={step.label} className="flex items-start gap-3">
            <div
              className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border ${
                isFailure
                  ? "border-rose-500 bg-rose-500/10 text-rose-400"
                  : done
                    ? "border-emerald-500 bg-emerald-500/10 text-emerald-400"
                    : current
                      ? "border-cyan-400 bg-cyan-500/10 text-cyan-300"
                      : "border-slate-800 text-slate-600"
              }`}
            >
              {isFailure ? (
                <TriangleAlert className="h-3 w-3" />
              ) : done ? (
                <Check className="h-3 w-3" />
              ) : current ? (
                <LoaderCircle className="h-3 w-3 animate-spin" />
              ) : (
                <span className="font-mono text-[9px]">{index + 1}</span>
              )}
            </div>
            <div className="min-w-0">
              <p
                className={`text-[11px] ${
                  done || current ? "text-slate-200" : "text-slate-600"
                }`}
              >
                {step.label}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
