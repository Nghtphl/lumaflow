import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

type Tone = "neutral" | "accent" | "positive" | "negative" | "warning";

/**
 * Status is carried by a tinted label with an icon — never by a coloured dot,
 * and never by anything that pulses. The tint alone is the signal: an outline
 * around it just adds a second edge for the eye to trace.
 */
const TONES: Record<Tone, string> = {
  neutral: "bg-fill text-ink-2",
  accent: "bg-accent-soft text-accent-ink",
  positive: "bg-positive-soft text-positive-ink",
  negative: "bg-negative-soft text-negative-ink",
  warning: "bg-warning-soft text-warning-ink",
};

export interface BadgeProps {
  tone?: Tone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  uppercase?: boolean;
}

export function Badge({
  tone = "neutral",
  icon,
  children,
  className,
  uppercase = false,
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-caption font-medium whitespace-nowrap",
        uppercase && "uppercase",
        TONES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
