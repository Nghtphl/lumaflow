import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface StatProps {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  /** Promotes the value to the accent colour. Reserve it for the live figure. */
  emphasis?: boolean;
  className?: string;
}

/**
 * One telemetry reading. Values are monospaced and tabular so a four-digit
 * latency does not shove the label around when it drops to three.
 */
export function Stat({ label, value, icon, meta, emphasis = false, className }: StatProps) {
  return (
    <div
      className={cn(
        "group relative flex min-w-0 flex-col justify-between gap-3 py-3.5",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-caption uppercase text-ink-3">
        {icon ? <span className="text-ink-4">{icon}</span> : null}
        <span className="truncate">{label}</span>
      </div>
      <div className="min-w-0">
        <div
          className={cn(
            "truncate font-mono text-subhead tnum",
            emphasis ? "text-accent-ink" : "text-ink",
          )}
        >
          {value}
        </div>
        {meta ? (
          <div className="mt-1 truncate text-caption text-ink-4">{meta}</div>
        ) : null}
      </div>
    </div>
  );
}
