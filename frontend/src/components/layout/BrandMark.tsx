import { cn } from "../../lib/cn";

/**
 * The product mark: a price path falling until it lands on the trigger line.
 * The line is the only accent in the lockup — a coloured badge here would
 * spend the 10% before the page has started.
 *
 * Deliberately not a stem-and-chevron: that shape is the universal download
 * glyph, and a logo that reads as a button in the top-left corner is a logo
 * that gets clicked by mistake.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
      className={cn("size-full", className)}
    >
      <path
        d="M5 8.5 11 15l4.5-4 7.5 8.5"
        stroke="var(--color-ink)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4.5 19.5h19"
        stroke="var(--color-accent)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
