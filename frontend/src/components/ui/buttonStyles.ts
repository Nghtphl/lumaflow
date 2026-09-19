import { cn } from "../../lib/cn";

export type Variant = "primary" | "secondary" | "ghost" | "quiet" | "danger";
export type Size = "sm" | "md" | "lg";

/**
 * Exactly one variant carries the accent, and only `primary` carries a fill at
 * full strength. That is what keeps the 10% reading as 10%: on any screen there
 * is one blue button, everything else is a tinted or bare label.
 *
 * `quiet` is for actions that live inside a row of content — a row action is
 * already contained by its row, so wrapping it in a second box just adds an
 * edge. It earns its weight from the icon and from colour on hover.
 */
export const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-accent text-white hover:bg-accent-hover active:bg-accent-press disabled:bg-accent/40 disabled:text-white/60",
  secondary:
    "bg-fill text-ink hover:bg-fill-strong disabled:text-ink-4",
  ghost:
    "text-ink-2 hover:bg-fill hover:text-ink disabled:text-ink-4 disabled:hover:bg-transparent",
  quiet:
    "px-0 text-ink-3 hover:text-ink disabled:text-ink-4",
  danger:
    "bg-negative-soft text-negative-ink hover:bg-negative/20",
};

export const SIZES: Record<Size, string> = {
  sm: "h-8 gap-1.5 rounded-sm px-2.5 text-footnote",
  md: "h-10 gap-2 rounded-md px-4 text-callout",
  lg: "h-12 gap-2 rounded-md px-5 text-subhead",
};

/**
 * The button's look without the button. Router links and anchors need to read
 * as buttons without becoming them: a navigation is an `<a>`, and wrapping one
 * in a `<button>` breaks middle-click, copy-link and keyboard expectations.
 */
export const buttonStyles = ({
  variant = "secondary",
  size = "md",
  block = false,
  className,
}: {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  className?: string;
} = {}): string =>
  cn(
    "pressable inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap select-none",
    "disabled:pointer-events-none disabled:opacity-60",
    SIZES[size],
    VARIANTS[variant],
    block && "w-full",
    className,
  );
