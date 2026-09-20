import { Ban, TriangleAlert, Wallet, Zap } from "lucide-react";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";

export interface OrderCardProps {
  id: number;
  owner: string;
  ownerLabel: string;
  status: "Active" | "Executed" | "Cancelled";
  inputSymbol: string;
  outputSymbol: string;
  amountIn: number;
  minAmountOut: number;
  feeBps: number;
  /** Lira value of the collateral, or null when no anchor rate is published. */
  collateralTry: number | null;
  /** Implied lira price of one XLM at the trigger, or null without a rate. */
  triggerTry: number | null;
  /**
   * Why this order can never settle, or null when it can. Unfillable orders are
   * real on-chain state, so they are shown rather than hidden — but they must
   * not look like an order that is merely waiting for its price.
   */
  unfillableReason: string | null;
  isOwn: boolean;
  /**
   * Whether the cancel affordance is offered. Distinct from `isOwn`: with no
   * wallet connected the button is shown for every resting order so the click
   * can raise the connect prompt, which is where the ownership check lands.
   */
  canCancel: boolean;
  busy: boolean;
  onCancel: () => void;
  onExecute: () => void;
}

const STATUS_TONE = {
  Active: "accent",
  Executed: "positive",
  Cancelled: "neutral",
} as const;

const STATUS_LABEL = {
  Active: "Resting",
  Executed: "Filled",
  Cancelled: "Cancelled",
} as const;

/**
 * One row of the public execution queue. A single hairline box, and inside it
 * nothing but type and two rules — the figures were previously sunk into their
 * own inset panel, which put three nested edges between the reader and a
 * number. Amounts are monospaced so the column lines up down the list and can
 * be scanned rather than read one card at a time.
 */
export function OrderCard({
  id,
  ownerLabel,
  status,
  unfillableReason,
  inputSymbol,
  outputSymbol,
  amountIn,
  minAmountOut,
  feeBps,
  collateralTry,
  triggerTry,
  isOwn,
  canCancel,
  busy,
  onCancel,
  onExecute,
}: OrderCardProps) {
  return (
    <article className="group rounded-lg border border-line p-4 transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:border-line-strong">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-mono text-callout font-medium text-ink">#{id}</h3>
            {status === "Active" && unfillableReason ? (
              <Badge
                tone="warning"
                icon={<TriangleAlert className="size-3" strokeWidth={2.25} aria-hidden="true" />}
              >
                Unfillable
              </Badge>
            ) : (
              <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
            )}
            {isOwn ? (
              <Badge
                tone="neutral"
                icon={<Wallet className="size-3" strokeWidth={2.25} aria-hidden="true" />}
              >
                Yours
              </Badge>
            ) : null}
          </div>
          <p className="mt-1.5 truncate font-mono text-caption text-ink-4">{ownerLabel}</p>
        </div>
        <span
          className="shrink-0 font-mono text-caption text-ink-3"
          title={unfillableReason ?? undefined}
        >
          {inputSymbol}/{outputSymbol}
        </span>
      </header>

      <div className="mt-4 grid grid-cols-2 gap-4 border-t border-line pt-4">
        <div className="min-w-0">
          <p className="text-caption uppercase text-ink-4">Collateral</p>
          <p className="mt-1 truncate font-mono text-subhead tnum text-ink">
            {amountIn.toFixed(2)}
            <span className="ml-1 text-footnote text-ink-3">{inputSymbol}</span>
          </p>
          {collateralTry !== null ? (
            <p className="mt-1 truncate font-mono text-caption tnum text-ink-4">
              ≈ {collateralTry.toFixed(2)} TRY
            </p>
          ) : null}
        </div>
        <div className="min-w-0 text-right">
          <p className="text-caption uppercase text-ink-4">Minimum output</p>
          <p className="mt-1 truncate font-mono text-subhead tnum text-ink">
            {minAmountOut.toFixed(4)}
            <span className="ml-1 text-footnote text-ink-3">{outputSymbol}</span>
          </p>
          {triggerTry !== null ? (
            <p className="mt-1 truncate font-mono text-caption tnum text-accent-ink">
              1 XLM ≈ {triggerTry.toFixed(2)} TRY
            </p>
          ) : null}
        </div>
      </div>

      <footer className="mt-4 flex flex-wrap items-center justify-between gap-x-5 gap-y-2 border-t border-line pt-3">
        <span className="font-mono text-caption tnum text-ink-4">
          Keeper bounty {(feeBps / 100).toFixed(2)}%
        </span>
        {status === "Active" ? (
          <div className="flex flex-wrap items-center justify-end gap-5">
            <Button
              size="sm"
              variant="quiet"
              disabled={busy || unfillableReason !== null}
              onClick={onExecute}
              title={unfillableReason ?? undefined}
              icon={<Zap className="size-3.5" strokeWidth={2.25} aria-hidden="true" />}
            >
              Execute
            </Button>
            {canCancel ? (
              <Button
                size="sm"
                variant="quiet"
                disabled={busy}
                onClick={onCancel}
                className="hover:text-negative-ink"
                icon={<Ban className="size-3.5" strokeWidth={2.25} aria-hidden="true" />}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        ) : null}
      </footer>
    </article>
  );
}
