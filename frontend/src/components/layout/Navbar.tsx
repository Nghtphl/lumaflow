import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Menu as MenuIcon, Radio, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { DURATION, EASE, dur, gsap, useGSAP } from "../../lib/motion";
import { ROUTES } from "../../routes";
import { IconButton } from "../ui/Button";
import { BrandMark } from "./BrandMark";

export interface NavSection {
  id: string;
  label: string;
}

export interface NavStatus {
  ledger: number | null;
  healthy: boolean;
  label: string;
}

export interface NavbarProps {
  /** In-page anchors for the current route. Empty hides the whole rail. */
  sections?: ReadonlyArray<NavSection>;
  /** The page's own primary control — wallet on the console, a CTA on landing. */
  right?: ReactNode;
  /** Live chain readout, shown only once the bar has condensed. */
  status?: NavStatus;
}

/**
 * The one piece of chrome present on every route, so it carries state rather
 * than just links:
 *
 *  · It condenses on scroll — tall and transparent over a masthead, then
 *    compact, blurred and hairlined once content runs underneath it.
 *  · A scroll-spy indicator slides between the current route's sections.
 *  · The live ledger height fades in only when condensed, where the page is
 *    no longer showing it.
 *  · A progress rail on the bottom edge reports position in the page.
 *
 * All of that state is scoped to one route, so the caller keys this component
 * by pathname: a route change remounts it with the new route's sections rather
 * than leaving it to unwind the previous route's highlight by hand.
 */
export function Navbar({ sections = [], right, status }: NavbarProps) {
  const [condensed, setCondensed] = useState(false);
  const [activeSection, setActiveSection] = useState(sections[0]?.id ?? "");
  const [mobileOpen, setMobileOpen] = useState(false);

  // A click is an explicit statement of intent, so the pill moves on the click
  // rather than waiting for the smooth scroll to arrive. While the page is
  // travelling the spy is held off: mid-flight it still reads the section
  // being left, and would drag the highlight back for the whole journey.
  const pinnedSection = useRef<string | null>(null);
  const pinTimer = useRef(0);

  const progressRef = useRef<HTMLSpanElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const linksRef = useRef<HTMLDivElement>(null);
  const linkNodes = useRef(new Map<string, HTMLAnchorElement>());
  const mobileSheetRef = useRef<HTMLDivElement>(null);
  const hasPlacedIndicator = useRef(false);

  const location = useLocation();
  const hasSections = sections.length > 0;

  // ── Scroll: condense + progress rail + section spy ────────────────────────
  useEffect(() => {
    let frame = 0;
    const read = (): void => {
      frame = 0;
      const y = window.scrollY;
      // Hysteresis: without a dead band the bar flickers when the page rests
      // exactly on the threshold.
      setCondensed((current) => (current ? y > 24 : y > 56));

      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      const ratio = scrollable > 0 ? Math.min(y / scrollable, 1) : 0;
      if (progressRef.current) {
        gsap.set(progressRef.current, { scaleX: ratio });
      }

      if (sections.length === 0) return;
      if (pinnedSection.current !== null) return;
      // The current section is the last one whose top has crossed the reading
      // line just under the bar. At the very bottom the final section wins
      // outright, so a short last section is still reachable.
      const line = 140;
      let current = sections[0]?.id ?? "";
      if (scrollable > 0 && scrollable - y < 4) {
        current = sections[sections.length - 1]?.id ?? current;
      } else {
        for (const section of sections) {
          const node = document.getElementById(section.id);
          if (node && node.getBoundingClientRect().top <= line) {
            current = section.id;
          }
        }
      }
      setActiveSection(current);
    };
    const onScroll = (): void => {
      if (frame) return;
      frame = window.requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [sections]);

  // ── Sliding section indicator ─────────────────────────────────────────────
  useGSAP(
    () => {
      const indicator = indicatorRef.current;
      const active = linkNodes.current.get(activeSection);
      if (!indicator || !active || active.offsetWidth === 0) return;
      gsap.to(indicator, {
        x: active.offsetLeft,
        width: active.offsetWidth,
        opacity: 1,
        duration: hasPlacedIndicator.current ? dur(DURATION.control) : 0,
        ease: EASE.ios,
        overwrite: "auto",
      });
      hasPlacedIndicator.current = true;
    },
    { dependencies: [activeSection, condensed, sections.length], scope: linksRef },
  );

  // ── Mobile sheet ──────────────────────────────────────────────────────────
  useEffect(() => {
    const sheet = mobileSheetRef.current;
    if (!sheet) return;
    gsap.to(sheet, {
      height: mobileOpen ? "auto" : 0,
      opacity: mobileOpen ? 1 : 0,
      duration: dur(DURATION.surface),
      ease: EASE.ios,
      overwrite: "auto",
    });
  }, [mobileOpen]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  const goToSection = useCallback((id: string) => {
    setMobileOpen(false);
    setActiveSection(id);

    pinnedSection.current = id;
    window.clearTimeout(pinTimer.current);
    // Long enough to cover a smooth scroll across the page, short enough that
    // a scroll the reader starts themselves takes over almost immediately.
    pinTimer.current = window.setTimeout(() => {
      pinnedSection.current = null;
    }, 900);

    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  useEffect(() => () => window.clearTimeout(pinTimer.current), []);

  const onBrandClick = useCallback(
    (event: React.MouseEvent) => {
      // Already home: the link would be a no-op, so make it mean "back to top".
      if (location.pathname === ROUTES.landing) {
        event.preventDefault();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    },
    [location.pathname],
  );

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-60 transition-[background-color,border-color] duration-400 ease-[cubic-bezier(0.32,0.72,0,1)]",
        condensed
          ? "border-b border-line bg-canvas-veil backdrop-blur-xl"
          : "border-b border-transparent bg-transparent",
      )}
    >
      <div
        className={cn(
          "mx-auto flex max-w-7xl items-center gap-4 px-4 transition-[height] duration-400 ease-[cubic-bezier(0.32,0.72,0,1)] sm:px-6 lg:px-8",
          condensed ? "h-14" : "h-20",
        )}
      >
        <Link
          to={ROUTES.landing}
          onClick={onBrandClick}
          className="flex min-w-0 items-center gap-2.5"
        >
          <span
            className={cn(
              "grid shrink-0 place-items-center transition-[width,height] duration-400 ease-[cubic-bezier(0.32,0.72,0,1)]",
              condensed ? "size-6" : "size-7",
            )}
          >
            <BrandMark />
          </span>
          <span className="truncate text-subhead font-medium text-ink">TriggerVault</span>
        </Link>

        {hasSections ? (
          <nav
            ref={linksRef}
            aria-label="Sections"
            className="relative ml-2 hidden items-center lg:flex"
          >
            {/* One pill that travels between the sections, rather than a
                background toggled on and off per link. */}
            <span
              ref={indicatorRef}
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-0 rounded-md bg-surface-3 shadow-sm opacity-0"
            />
            {sections.map((section) => (
              <a
                key={section.id}
                ref={(node) => {
                  if (node) linkNodes.current.set(section.id, node);
                  else linkNodes.current.delete(section.id);
                }}
                href={`#${section.id}`}
                aria-current={activeSection === section.id ? "true" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  goToSection(section.id);
                }}
                className={cn(
                  "relative z-10 cursor-pointer rounded-md px-3.5 py-1.5 text-callout",
                  "transition-all duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]",
                  activeSection === section.id
                    ? "font-medium text-ink"
                    : "font-normal text-ink-3 hover:bg-fill/60 hover:text-ink-2",
                )}
              >
                {section.label}
              </a>
            ))}
          </nav>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {status ? (
            <div
              aria-hidden={!condensed}
              className={cn(
                "hidden items-center gap-2 rounded-full bg-fill px-3 py-1.5 md:flex",
                "transition-[opacity,transform] duration-400 ease-[cubic-bezier(0.32,0.72,0,1)]",
                condensed
                  ? "translate-y-0 opacity-100"
                  : "pointer-events-none -translate-y-1 opacity-0",
              )}
            >
              <Radio
                className={cn(
                  "size-3.5 shrink-0",
                  status.healthy ? "text-accent-ink" : "text-ink-4",
                )}
                strokeWidth={2}
                aria-hidden="true"
              />
              <span className="font-mono text-caption tnum text-ink-2">
                {status.ledger === null
                  ? status.label
                  : `LEDGER ${status.ledger.toLocaleString()}`}
              </span>
            </div>
          ) : null}

          {right}

          {hasSections ? (
            <IconButton
              label={mobileOpen ? "Close menu" : "Open menu"}
              variant="secondary"
              onClick={() => setMobileOpen((current) => !current)}
              className="lg:hidden"
            >
              {mobileOpen ? (
                <X className="size-4" strokeWidth={2} aria-hidden="true" />
              ) : (
                <MenuIcon className="size-4" strokeWidth={2} aria-hidden="true" />
              )}
            </IconButton>
          ) : null}
        </div>
      </div>

      {hasSections ? (
        <div
          ref={mobileSheetRef}
          className="overflow-hidden border-t border-line bg-canvas-veil backdrop-blur-xl lg:hidden"
          style={{ height: 0, opacity: 0 }}
        >
          <nav aria-label="Sections" className="mx-auto max-w-7xl px-4 py-3 sm:px-6">
            {sections.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  goToSection(section.id);
                }}
                className={cn(
                  "flex items-center justify-between rounded-sm px-3 py-3 text-body font-medium transition-colors",
                  activeSection === section.id ? "bg-fill text-ink" : "text-ink-2 hover:bg-fill",
                )}
              >
                {section.label}
                {activeSection === section.id ? (
                  <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
                ) : null}
              </a>
            ))}
          </nav>
        </div>
      ) : null}

      <span
        ref={progressRef}
        aria-hidden="true"
        className={cn(
          "absolute inset-x-0 bottom-0 h-px origin-left scale-x-0 bg-accent transition-opacity duration-300",
          condensed ? "opacity-100" : "opacity-0",
        )}
      />
    </header>
  );
}
