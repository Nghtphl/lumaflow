import { useRef } from "react";
import { ArrowUpRight, CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { EASE, dur, gsap, useGSAP } from "../../lib/motion";

export type NoticeType = "success" | "error" | "info";

export interface Notice {
  id: number;
  type: NoticeType;
  title: string;
  detail: string;
  txHash?: string;
}

const ICONS = {
  success: CircleCheck,
  error: CircleAlert,
  info: Info,
} as const;

const ICON_TONES = {
  success: "text-positive-ink",
  error: "text-negative-ink",
  info: "text-accent-ink",
} as const;

const RAIL_TONES = {
  success: "bg-positive/70",
  error: "bg-negative/70",
  info: "bg-accent/70",
} as const;

export interface ToastProps {
  notice: Notice;
  onClose: () => void;
  /** Must match the caller's dismissal timer so the rail lands on zero. */
  duration?: number;
  explorerBaseUrl: string;
}

/**
 * A notification, not a light show: neutral surface, one tinted icon, and a
 * rail that drains for exactly as long as the toast will live, so its
 * disappearance is never a surprise.
 */
export function Toast({ notice, onClose, duration = 4500, explorerBaseUrl }: ToastProps) {
  const railRef = useRef<HTMLSpanElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const Icon = ICONS[notice.type];

  useGSAP(
    () => {
      if (!railRef.current) return;
      gsap.fromTo(
        railRef.current,
        { scaleX: 1 },
        { scaleX: 0, duration: duration / 1000, ease: "none" },
      );
    },
    { scope: rootRef },
  );

  const dismiss = (): void => {
    const node = rootRef.current;
    if (!node) {
      onClose();
      return;
    }
    gsap.to(node, {
      opacity: 0,
      x: 16,
      scale: 0.98,
      duration: dur(0.2),
      ease: EASE.soft,
      onComplete: onClose,
    });
  };

  return (
    <div
      ref={rootRef}
      role="status"
      aria-live="polite"
      className="material animate-toast-in overflow-hidden rounded-lg shadow-pop"
    >
      <div className="flex items-start gap-3 p-3.5">
        <Icon
          className={cn("mt-0.5 size-4.5 shrink-0", ICON_TONES[notice.type])}
          strokeWidth={2}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="text-callout font-medium text-ink">{notice.title}</p>
          <p className="mt-1 break-words text-footnote leading-relaxed text-ink-3">
            {notice.detail}
          </p>
          {notice.txHash ? (
            <a
              href={`${explorerBaseUrl}/tx/${encodeURIComponent(notice.txHash)}`}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-footnote font-medium text-accent-ink transition-colors hover:text-accent-hover"
            >
              View on Stellar Expert
              <ArrowUpRight className="size-3.5" strokeWidth={2.25} aria-hidden="true" />
            </a>
          ) : null}
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss notification"
          className="pressable -mt-1 -mr-1 grid size-7 shrink-0 place-items-center rounded-sm text-ink-4 hover:bg-fill hover:text-ink-2"
        >
          <X className="size-3.5" strokeWidth={2.25} aria-hidden="true" />
        </button>
      </div>
      <span
        ref={railRef}
        aria-hidden="true"
        className={cn("block h-0.5 origin-left", RAIL_TONES[notice.type])}
      />
    </div>
  );
}
