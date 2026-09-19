import { useRef } from "react";
import type { ElementType, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { revealOnScroll, useGSAP } from "../../lib/motion";

export interface RevealProps {
  children: ReactNode;
  /** Staggers the element's direct children instead of the element itself. */
  stagger?: boolean;
  delay?: number;
  as?: ElementType;
  className?: string;
  id?: string;
}

/**
 * Wraps content so it rises into place the first time it is scrolled to.
 * Purely additive: with reduced motion on, the tween collapses and the content
 * is simply there.
 */
export function Reveal({
  children,
  stagger = false,
  as: Tag = "div",
  className,
  id,
}: RevealProps) {
  const ref = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const node = ref.current;
      if (!node) return;
      const targets = stagger ? Array.from(node.children) : node;
      if (stagger && (targets as Element[]).length === 0) return;
      revealOnScroll(targets as gsap.TweenTarget, node);
    },
    { scope: ref },
  );

  return (
    <Tag ref={ref} id={id} className={cn(className)}>
      {children}
    </Tag>
  );
}
