import { ArrowUpRight, Gauge, Layers, RefreshCw, Vault, Waves } from "lucide-react";
import { cn } from "../../lib/cn";
import { AnimatedNumber } from "../ui/AnimatedNumber";
import { IconButton } from "../ui/Button";
import { Stat } from "../ui/Stat";

export interface TelemetryBarProps {
  latency: number | null;
  ledger: number | null;
  healthy: boolean;
  updatedAt: Date | null;
  activeValue: number;
  activeValueTry: number | null;
  contractId: string;
  contractUrl: string;
  contractLabel: string;
  refreshing: boolean;
  onRefresh: () => void;
}

/**
 * Network and vault readings as a bare strip on the page — no card around it,
 * no fill behind it. These are readings, not objects: they belong on the page
 * the way a column header does, and a box would promote them above the console
 * they are only context for.
 */
export function TelemetryBar({
  latency,
  ledger,
  healthy,
  updatedAt,
  activeValue,
  activeValueTry,
  contractUrl,
  contractLabel,
  refreshing,
  onRefresh,
}: TelemetryBarProps) {
  // No probe has resolved yet. `healthy` is false at mount, so rendering it
  // directly makes the first paint accuse the network of being down before
  // anything has been asked of it. `updatedAt` is written on both the success
  // and the failure path, so its absence — and only its absence — means
  // "still asking".
  const pending = updatedAt === null;

  return (
    <div>
      <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <Waves
            className={cn(
              "size-3.5 shrink-0",
              healthy && !pending ? "text-accent-ink" : "text-ink-4",
            )}
            strokeWidth={2}
            aria-hidden="true"
          />
          <span className="truncate text-caption uppercase text-ink-3">
            {pending
              ? "Soroban RPC connecting"
              : healthy
                ? "Soroban RPC connected"
                : "Soroban RPC unreachable"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {updatedAt ? (
            <span className="hidden font-mono text-caption tnum text-ink-4 sm:inline">
              {updatedAt.toLocaleTimeString()}
            </span>
          ) : null}
          <IconButton label="Refresh chain state" size="sm" onClick={onRefresh}>
            <RefreshCw
              className={cn("size-3.5", refreshing && "animate-spin")}
              strokeWidth={2}
              aria-hidden="true"
            />
          </IconButton>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="RPC latency"
          icon={<Gauge className="size-3.5" strokeWidth={2} aria-hidden="true" />}
          value={
            <AnimatedNumber
              value={latency}
              format={(value) => `${Math.round(value)} ms`}
            />
          }
          meta={pending ? "Probing" : healthy ? "Healthy" : "Last probe failed"}
        />
        <Stat
          className="sm:border-l sm:border-line sm:pl-5"
          label="Latest ledger"
          icon={<Layers className="size-3.5" strokeWidth={2} aria-hidden="true" />}
          value={
            <AnimatedNumber
              value={ledger}
              format={(value) => Math.round(value).toLocaleString()}
            />
          }
          meta="Stellar Testnet"
          emphasis
        />
        <Stat
          className="lg:border-l lg:border-line lg:pl-5"
          label="Resting collateral"
          icon={<Vault className="size-3.5" strokeWidth={2} aria-hidden="true" />}
          value={
            <AnimatedNumber
              value={activeValue}
              format={(value) => `${value.toFixed(2)} USDC`}
            />
          }
          meta={
            activeValueTry === null
              ? "Awaiting anchor rate"
              : `≈ ${activeValueTry.toFixed(0)} TRY`
          }
        />
        <a
          href={contractUrl}
          target="_blank"
          rel="noreferrer"
          className="group relative flex min-w-0 flex-col justify-between gap-3 py-3.5 sm:border-l sm:border-line sm:pl-5"
        >
          <div className="flex items-center justify-between gap-2 text-caption uppercase text-ink-3">
            <span className="truncate">Vault contract</span>
            <ArrowUpRight
              className="size-3.5 shrink-0 text-ink-4 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-accent-ink"
              strokeWidth={2.25}
              aria-hidden="true"
            />
          </div>
          <div className="min-w-0">
            <div className="truncate font-mono text-subhead text-ink">{contractLabel}</div>
            <div className="mt-1 truncate text-caption text-ink-4 transition-colors group-hover:text-accent-ink">
              Stellar Expert
            </div>
          </div>
        </a>
      </div>
    </div>
  );
}
