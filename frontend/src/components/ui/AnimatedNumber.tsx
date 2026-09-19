import { useEffect, useRef, useState } from "react";
import { countTo } from "../../lib/motion";

export interface AnimatedNumberProps {
  value: number | null;
  /** Renders the tweened value. Keep it pure — it runs on every frame. */
  format: (value: number) => string;
  /** Shown when `value` is null, i.e. the figure genuinely is not known yet. */
  placeholder?: string;
  className?: string;
}

/**
 * Rolls a readout from its previous value to the next one. Balances and ledger
 * heights update on a timer, and a number that snaps in place is easy to miss
 * entirely; a number that travels is read as "this just changed".
 */
export function AnimatedNumber({
  value,
  format,
  placeholder = "—",
  className,
}: AnimatedNumberProps) {
  const [display, setDisplay] = useState(value ?? 0);
  const previous = useRef(value ?? 0);
  // The first reading has nothing to travel from: rolling a ledger height up
  // from zero is a second of noise that says nothing. Land it, then animate
  // every change after that.
  const hasValue = useRef(value !== null);

  useEffect(() => {
    if (value === null) return;
    if (!hasValue.current) {
      hasValue.current = true;
      previous.current = value;
      setDisplay(value);
      return;
    }
    const tween = countTo(previous.current, value, setDisplay);
    previous.current = value;
    return () => {
      tween.kill();
    };
  }, [value]);

  return (
    <span className={className}>
      {value === null ? placeholder : format(display)}
    </span>
  );
}
