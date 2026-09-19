import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { DURATION, EASE, dur, gsap, useGSAP } from "../../lib/motion";

export interface SegmentedOption<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
}

export interface SegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: "sm" | "md";
  className?: string;
}

/**
 * iOS-style segmented control. The selected state is a real element that
 * travels between segments rather than a class that blinks on and off — the
 * movement is what tells you which way you just went.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = "md",
  className,
}: SegmentedProps<T>) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  const buttonRefs = useRef(new Map<T, HTMLButtonElement>());
  // The very first placement must not animate in from x:0, or the thumb slides
  // across the whole control on mount.
  const hasPlaced = useRef(false);

  const place = (animate: boolean): void => {
    const track = trackRef.current;
    const thumb = thumbRef.current;
    const active = buttonRefs.current.get(value);
    if (!track || !thumb || !active) return;

    const left = active.offsetLeft;
    const width = active.offsetWidth;
    if (width === 0) return;

    gsap.to(thumb, {
      x: left,
      width,
      duration: animate ? dur(DURATION.control) : 0,
      ease: EASE.ios,
      overwrite: "auto",
    });
  };

  useGSAP(
    () => {
      place(hasPlaced.current);
      hasPlaced.current = true;
    },
    { dependencies: [value, options.length], scope: trackRef },
  );

  // Segment widths change with the container (a two-up grid that stacks on
  // phones), so the thumb has to be re-measured, not just re-rendered.
  useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => place(false));
    observer.observe(track);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const pad = size === "sm" ? "p-0.5" : "p-1";
  const cell = size === "sm" ? "h-8 text-footnote" : "h-10 text-callout";

  return (
    <div
      ref={trackRef}
      role="tablist"
      aria-label={ariaLabel}
      className={cn("well relative grid rounded-md", pad, className)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <span
        ref={thumbRef}
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-0 rounded-sm border border-line-strong bg-surface-2 shadow-card",
          size === "sm" ? "top-0.5 bottom-0.5" : "top-1 bottom-1",
        )}
      />
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            ref={(node) => {
              if (node) buttonRefs.current.set(option.id, node);
              else buttonRefs.current.delete(option.id);
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(option.id)}
            className={cn(
              "relative z-10 inline-flex items-center justify-center gap-2 rounded-sm px-3 font-medium",
              "transition-colors duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]",
              cell,
              selected ? "text-ink" : "text-ink-3 hover:text-ink-2",
            )}
          >
            {option.icon}
            <span className="truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
