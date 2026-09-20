import { useRef } from "react";
import { Check, LoaderCircle, TriangleAlert } from "lucide-react";
import { cn } from "../../lib/cn";
import { DURATION, EASE, dur, gsap, useGSAP } from "../../lib/motion";

export interface StepperProps {
  steps: ReadonlyArray<string>;
  /** Index of the step in progress. -1 before anything has started. */
  current: number;
  /** All steps read as done regardless of `current`. */
  complete?: boolean;
  failed?: boolean;
  className?: string;
}

/**
 * Transaction lifecycle. The rail behind the markers fills as the ledger work
 * progresses, which gives the wait a length the user can see — the spinner
 * alone never says how much is left.
 */
export function Stepper({
  steps,
  current,
  complete = false,
  failed = false,
  className,
}: StepperProps) {
  const railRef = useRef<HTMLSpanElement>(null);
  const scopeRef = useRef<HTMLDivElement>(null);

  const reached = complete ? steps.length : Math.max(current, 0);
  const progress = steps.length > 1 ? reached / (steps.length - 1) : 0;

  useGSAP(
    () => {
      if (!railRef.current) return;
      gsap.to(railRef.current, {
        scaleX: Math.min(Math.max(progress, 0), 1),
        duration: dur(DURATION.surface),
        ease: EASE.ios,
        overwrite: "auto",
      });
    },
    { dependencies: [progress], scope: scopeRef },
  );

  return (
    <div ref={scopeRef} className={cn("relative", className)}>
      {/* Rail sits behind the markers, inset so it starts and ends at centres. */}
      <div
        className="pointer-events-none absolute top-3.5 h-px"
        style={{
          left: `${50 / steps.length}%`,
          right: `${50 / steps.length}%`,
        }}
        aria-hidden="true"
      >
        <span className="absolute inset-0 bg-line" />
        <span
          ref={railRef}
          className={cn(
            "absolute inset-0 origin-left scale-x-0",
            failed ? "bg-negative/60" : "bg-accent",
          )}
        />
      </div>

      <ol
        className="relative grid gap-1"
        style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
      >
        {steps.map((label, index) => {
          const done = !failed && (complete || index < current);
          const active = !failed && !complete && index === current;
          const errored = failed && index === Math.max(current, 0);
          return (
            <li key={label} className="flex min-w-0 flex-col items-center text-center">
              <span
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-full border text-caption",
                  "ring-4 ring-surface transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
                  errored
                    ? "border-negative/60 bg-negative-soft text-negative-ink"
                    : done
                      ? "border-accent bg-accent text-white"
                      : active
                        ? "border-accent bg-surface text-accent-ink"
                        : "border-line bg-surface text-ink-4",
                )}
              >
                {errored ? (
                  <TriangleAlert className="size-3.5" strokeWidth={2.25} aria-hidden="true" />
                ) : done ? (
                  <Check className="size-3.5" strokeWidth={2.75} aria-hidden="true" />
                ) : active ? (
                  <LoaderCircle className="size-3.5 animate-spin" strokeWidth={2.25} aria-hidden="true" />
                ) : (
                  index + 1
                )}
              </span>
              <span
                className={cn(
                  // `text-balance` keeps a two-word label from breaking into a
                  // lonely orphan; the hyphens let the longest one ("Ledger
                  // Confirmation") wrap instead of spilling past its column at
                  // 375px, where the four cells are 72px wide.
                  "mt-2 w-full break-words text-[0.625rem] leading-tight transition-colors duration-300 sm:text-caption",
                  done || active ? "text-ink-2" : "text-ink-4",
                )}
                lang="en"
              >
                {label}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
