import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(ScrollTrigger, useGSAP);

// Roboto swaps in after first paint and reflows the page, which leaves every
// ScrollTrigger holding a start position measured against the fallback font.
// One refresh once the faces are ready re-measures them all.
if (typeof document !== "undefined" && "fonts" in document) {
  void document.fonts.ready.then(() => ScrollTrigger.refresh());
}

/**
 * The motion vocabulary. Everything on screen moves with one of these four
 * curves and one of these five durations, which is what makes unrelated
 * elements feel like parts of the same machine.
 *
 * `ios` is the curve UIKit uses for sheets and navigation pushes: a fast
 * departure that settles without bouncing. It is the default for anything the
 * user directly caused. `expo` is for entrances, where the element should
 * arrive from further away and decelerate longer.
 */
export const EASE = {
  ios: "cubic-bezier(0.32, 0.72, 0, 1)",
  expo: "cubic-bezier(0.16, 1, 0.3, 1)",
  soft: "cubic-bezier(0.65, 0, 0.35, 1)",
  overshoot: "cubic-bezier(0.34, 1.4, 0.64, 1)",
} as const;

export const DURATION = {
  micro: 0.16,
  control: 0.26,
  surface: 0.42,
  entrance: 0.62,
  slow: 0.9,
} as const;

/**
 * True when the reader has asked their OS to reduce motion. Animations still
 * run so that state changes stay coherent, but they are collapsed to a length
 * the eye reads as instant.
 */
export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Scale a duration to zero-ish when reduced motion is on. */
export const dur = (seconds: number): number =>
  prefersReducedMotion() ? 0.001 : seconds;

/**
 * The house entrance: rise and fade. Used for hero copy, cards and list rows.
 * Distance is small by design — a long travel reads as a slideshow, not as an
 * interface settling into place.
 */
export const fadeUp = (
  targets: gsap.TweenTarget,
  options: { delay?: number; stagger?: number; distance?: number } = {},
): gsap.core.Tween => {
  const { delay = 0, stagger = 0.06, distance = 14 } = options;
  return gsap.fromTo(
    targets,
    { opacity: 0, y: distance },
    {
      opacity: 1,
      y: 0,
      duration: dur(DURATION.entrance),
      ease: EASE.expo,
      delay: prefersReducedMotion() ? 0 : delay,
      stagger: prefersReducedMotion() ? 0 : stagger,
      clearProps: "transform",
    },
  );
};

/**
 * Reveal on scroll. Fires once, slightly before the element reaches the fold,
 * so content is already settled by the time it is properly in view.
 */
export const revealOnScroll = (
  targets: gsap.TweenTarget,
  /**
   * The element whose position drives the trigger. It must be a single node —
   * handing ScrollTrigger the tween's target list would make it measure only
   * whichever element happened to come first.
   */
  trigger: Element,
  options: { stagger?: number; start?: string } = {},
): gsap.core.Tween => {
  const { stagger = 0.07, start = "top 92%" } = options;

  // With reduced motion on there is nothing to reveal, so skip the trigger
  // entirely. Hiding content behind a scroll position it might never reach is
  // a risk worth taking for an animation, and not for no animation at all.
  if (prefersReducedMotion()) {
    return gsap.set(targets, { opacity: 1, y: 0, clearProps: "transform" });
  }

  return gsap.fromTo(
    targets,
    { opacity: 0, y: 18 },
    {
      opacity: 1,
      y: 0,
      duration: dur(DURATION.entrance),
      ease: EASE.expo,
      stagger: prefersReducedMotion() ? 0 : stagger,
      clearProps: "transform",
      scrollTrigger: {
        trigger,
        start,
        once: true,
        // Content above can grow (orders arrive, quotes resolve) and shift this
        // element; without re-measuring, a reveal can be stranded at opacity 0.
        invalidateOnRefresh: true,
      },
    },
  );
};

/**
 * Count a numeric readout up to its new value. Used for balances and ledger
 * heights: a figure that snaps is easy to miss, one that rolls is not.
 */
export const countTo = (
  from: number,
  to: number,
  onUpdate: (value: number) => void,
): gsap.core.Tween => {
  const proxy = { value: from };
  return gsap.to(proxy, {
    value: to,
    duration: dur(Math.abs(to - from) > 0 ? DURATION.slow : 0),
    ease: EASE.expo,
    onUpdate: () => onUpdate(proxy.value),
    onComplete: () => onUpdate(to),
  });
};

export { gsap, ScrollTrigger, useGSAP };
