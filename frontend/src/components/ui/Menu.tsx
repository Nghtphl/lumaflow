import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { DURATION, EASE, dur, gsap } from "../../lib/motion";

export interface MenuProps {
  /** Rendered inside the anchor; receives the current open state. */
  trigger: (state: { open: boolean; toggle: () => void }) => ReactNode;
  children: (state: { close: () => void }) => ReactNode;
  ariaLabel: string;
  align?: "left" | "right";
  panelClassName?: string;
  className?: string;
}

/**
 * Popover with the dismissal behaviour every menu is expected to have:
 * outside pointer-down, Escape, and a scale-from-the-edge entrance that makes
 * the panel look like it came out of the button rather than appearing over it.
 */
export function Menu({
  trigger,
  children,
  ariaLabel,
  align = "right",
  panelClassName,
  className,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Mount on the opening render so the panel exists in time to be animated in.
  if (open && !mounted) setMounted(true);

  useEffect(() => {
    if (!mounted) return;
    const panel = panelRef.current;
    if (!panel) return;
    if (open) {
      gsap.fromTo(
        panel,
        { opacity: 0, y: -6, scale: 0.96 },
        {
          opacity: 1,
          y: 0,
          scale: 1,
          duration: dur(DURATION.control),
          ease: EASE.expo,
          overwrite: "auto",
        },
      );
      return;
    }
    const tween = gsap.to(panel, {
      opacity: 0,
      y: -4,
      scale: 0.97,
      duration: dur(DURATION.micro),
      ease: EASE.soft,
      overwrite: "auto",
      onComplete: () => setMounted(false),
    });
    return () => {
      tween.kill();
    };
  }, [mounted, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      {trigger({ open, toggle: () => setOpen((current) => !current) })}
      {mounted ? (
        <div
          ref={panelRef}
          role="listbox"
          aria-label={ariaLabel}
          className={cn(
            "material absolute top-[calc(100%+0.5rem)] z-50 rounded-lg p-1.5 shadow-pop",
            align === "right" ? "right-0 origin-top-right" : "left-0 origin-top-left",
            panelClassName,
          )}
        >
          {children({ close: () => setOpen(false) })}
        </div>
      ) : null}
    </div>
  );
}

export interface MenuItemProps {
  selected?: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}

export function MenuItem({ selected = false, onClick, children, className }: MenuItemProps) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-sm px-2.5 py-2 text-left",
        "transition-colors duration-150 ease-[cubic-bezier(0.32,0.72,0,1)]",
        selected ? "bg-fill text-ink" : "text-ink-2 hover:bg-fill hover:text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}
