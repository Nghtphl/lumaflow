import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { SectionLabel } from "./Card";

export interface SectionHeadingProps {
  eyebrow: string;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

/** The one heading shape used at the top of every page section. */
export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
  className,
}: SectionHeadingProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
    >
      <div className="max-w-xl">
        <SectionLabel>{eyebrow}</SectionLabel>
        <h2 className="mt-2 text-title text-ink">{title}</h2>
        {description ? (
          <p className="mt-2 text-callout leading-relaxed text-ink-3">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
