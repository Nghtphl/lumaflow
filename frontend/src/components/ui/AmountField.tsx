import { useId } from "react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface AmountFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Plain text unit shown when no richer control is supplied. */
  unit?: string;
  /** A token or currency picker rendered in place of the plain unit. */
  unitNode?: ReactNode;
  /** Secondary line under the figure, e.g. the lira equivalent. */
  hint?: ReactNode;
  /** Right-aligned helper above the input, e.g. the spendable balance. */
  aside?: ReactNode;
  disabled?: boolean;
  /** Halves the type size for fields that sit beside a larger one. */
  compact?: boolean;
  invalid?: boolean;
  className?: string;
}

/**
 * The primary money input. The figure is the largest type on the card because
 * it is the one number the user is actually deciding on; everything else about
 * the order is downstream of it.
 */
export function AmountField({
  label,
  value,
  onChange,
  unit,
  unitNode,
  hint,
  aside,
  disabled = false,
  compact = false,
  invalid = false,
  className,
}: AmountFieldProps) {
  const id = useId();

  return (
    <div className={cn("min-w-0", className)}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-caption uppercase text-ink-3">
          {label}
        </label>
        {aside ? (
          <span className="truncate text-caption text-ink-4">{aside}</span>
        ) : null}
      </div>

      <div
        className={cn(
          "well flex items-center rounded-md transition-colors duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]",
          "focus-within:border-accent/70",
          invalid && "border-negative/60",
          disabled && "opacity-50",
        )}
      >
        <div className="min-w-0 flex-1">
          <input
            id={id}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={value}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            onChange={(event) => onChange(event.target.value.replace(",", "."))}
            className={cn(
              "w-full min-w-0 bg-transparent px-4 font-medium text-ink outline-none",
              "placeholder:text-ink-4 disabled:cursor-not-allowed",
              compact ? "py-2.5 text-subhead" : hint ? "pt-3 pb-0.5 text-2xl" : "py-3 text-2xl",
            )}
            placeholder="0"
          />
          {hint ? (
            <span className="block px-4 pb-2.5 text-caption leading-snug text-ink-3">
              {hint}
            </span>
          ) : null}
        </div>
        <div className="mr-2.5 shrink-0">
          {unitNode ?? (
            <span className="rounded-full border border-line-strong bg-surface-2 px-3 py-1.5 text-footnote font-medium text-ink-2">
              {unit}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
