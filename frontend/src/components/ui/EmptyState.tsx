import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}

/** Quiet placeholder. Nothing to frame, so nothing is framed. */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "grid min-h-48 place-items-center border-t border-line px-6 py-14 text-center",
        className,
      )}
    >
      <div className="max-w-xs">
        <span className="mx-auto mb-4 grid place-items-center text-ink-4">{icon}</span>
        <p className="text-subhead text-ink">{title}</p>
        <p className="mt-2 text-footnote leading-relaxed text-ink-3">{description}</p>
        {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
      </div>
    </div>
  );
}
