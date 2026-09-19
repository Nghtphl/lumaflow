import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Removes the default padding so a card can hold its own edge-to-edge rows. */
  flush?: boolean;
}

/** The standard raised surface: hairline, shadow, 1px top highlight. */
export function Card({ flush = false, className, children, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        "material rounded-xl",
        !flush && "p-5",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface CardHeaderProps {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  className?: string;
}

export function CardHeader({ icon, title, subtitle, action, className }: CardHeaderProps) {
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div className="flex min-w-0 items-start gap-2.5">
        {icon ? (
          <span className="mt-1 shrink-0 text-ink-3">{icon}</span>
        ) : null}
        <div className="min-w-0">
          <h2 className="truncate text-heading text-ink">{title}</h2>
          {subtitle ? (
            <p className="mt-1 text-footnote text-ink-3">{subtitle}</p>
          ) : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** Small all-caps label used above grouped fields. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("block text-caption uppercase text-ink-3", className)}>
      {children}
    </span>
  );
}
