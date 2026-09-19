import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/cn";
import { DURATION, EASE, dur, gsap } from "../../lib/motion";
import { IconButton } from "./Button";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Visually hides the title but keeps it as the dialog's accessible name. */
  hideTitle?: boolean;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/**
 * A dialog that arrives the way a macOS sheet does: the backdrop dims and
 * blurs, the panel comes up a few pixels and settles. It stays mounted through
 * its exit so closing is a movement rather than a disappearance.
 */
export function Modal({
  open,
  onClose,
  title,
  hideTitle = false,
  description,
  children,
  footer,
  className,
}: ModalProps) {
  const [mounted, setMounted] = useState(open);
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Mount on the same render that opens, rather than in an effect that would
  // cost an extra paint before the enter animation can start.
  if (open && !mounted) setMounted(true);

  // Latest-callback ref: the Escape listener and backdrop handler must not
  // re-subscribe every time the parent hands down a fresh inline closure.
  const closerRef = useRef(onClose);
  useEffect(() => {
    closerRef.current = onClose;
  });

  // Enter / exit. Kept in one effect so an interrupted close (reopened before
  // the exit finished) simply retargets the same tweens.
  useEffect(() => {
    if (!mounted) return;
    const backdrop = backdropRef.current;
    const panel = panelRef.current;
    if (!backdrop || !panel) return;

    const timeline = gsap.timeline();
    if (open) {
      timeline
        .fromTo(
          backdrop,
          { opacity: 0 },
          { opacity: 1, duration: dur(DURATION.control), ease: EASE.ios },
        )
        .fromTo(
          panel,
          { opacity: 0, y: 12, scale: 0.97 },
          {
            opacity: 1,
            y: 0,
            scale: 1,
            duration: dur(DURATION.surface),
            ease: EASE.expo,
          },
          "<0.02",
        );
    } else {
      timeline
        .to(panel, {
          opacity: 0,
          y: 8,
          scale: 0.98,
          duration: dur(DURATION.control),
          ease: EASE.soft,
        })
        .to(
          backdrop,
          { opacity: 0, duration: dur(DURATION.control), ease: EASE.soft },
          "<",
        )
        .then(() => setMounted(false));
    }
    return () => {
      timeline.kill();
    };
  }, [mounted, open]);

  // Escape closes, and the page behind must not scroll while a sheet is up.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closerRef.current();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Move focus into the dialog so keyboard users are not left behind on the page.
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const onBackdropDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) closerRef.current();
    },
    [],
  );

  if (!mounted) return null;

  return (
    <div
      ref={backdropRef}
      onMouseDown={onBackdropDown}
      className="fixed inset-0 z-70 flex items-center justify-center bg-canvas/70 p-4 backdrop-blur-md"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-description={description}
        tabIndex={-1}
        className={cn(
          "material relative w-full max-w-md rounded-2xl p-6 shadow-modal outline-none",
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2
              className={cn(
                "text-title text-ink",
                hideTitle && "sr-only",
              )}
            >
              {title}
            </h2>
            {description ? (
              <p className="mt-2 text-callout leading-relaxed text-ink-2">
                {description}
              </p>
            ) : null}
          </div>
          <IconButton
            label="Close dialog"
            size="sm"
            onClick={onClose}
            className="-mt-1 -mr-1"
          >
            <X className="size-4" strokeWidth={2} aria-hidden="true" />
          </IconButton>
        </div>

        <div className="mt-5">{children}</div>

        {footer ? (
          <div className="mt-6 border-t border-line pt-4">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
