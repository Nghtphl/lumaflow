import { useRef } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Zap } from "lucide-react";
import { Button } from "../ui/Button";
import { buttonStyles } from "../ui/buttonStyles";
import { DURATION, fadeUp, useGSAP } from "../../lib/motion";
import { ROUTES } from "../../routes";

export interface MastheadProps {
  contractUrl: string;
}

/**
 * States what the product does in one sentence and hands over to the console.
 *
 * It used to be followed by three claim cards, which turned out to be the five
 * lifecycle steps below restated in shorter words. Saying the same thing twice
 * in two shapes does not make it land harder — it just makes the page longer.
 */
export function Masthead({ contractUrl }: MastheadProps) {
  const scopeRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const scope = scopeRef.current;
      if (!scope) return;
      const items = scope.querySelectorAll("[data-reveal]");
      if (items.length === 0) return;
      fadeUp(items, { stagger: 0.07, delay: DURATION.micro });
    },
    { scope: scopeRef },
  );

  return (
    <div ref={scopeRef} className="pt-32 pb-4 sm:pt-40 lg:pt-44">
      <h1
        data-reveal
        className="max-w-3xl text-balance text-4xl leading-[1.08] font-medium tracking-[-0.03em] text-ink sm:text-5xl"
      >
        Limit orders on Stellar
        <span className="block text-ink-3">that settle themselves.</span>
      </h1>

      <p
        data-reveal
        className="mt-5 max-w-xl text-pretty text-body leading-relaxed text-ink-2"
      >
        TriggerVault prices your exit in Turkish lira, holds the collateral in a
        Soroban contract, and lets an autonomous keeper close the position the
        moment your rate is reachable. No custody, no manual watching.
      </p>

      <div
        data-reveal
        className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center"
      >
        <Link
          to={ROUTES.console}
          className={buttonStyles({ variant: "primary", size: "lg" })}
        >
          <Zap className="size-4" strokeWidth={2} aria-hidden="true" />
          Open the console
        </Link>
        <Button
          size="lg"
          onClick={() => window.open(contractUrl, "_blank", "noreferrer")}
          iconRight={<ArrowUpRight className="size-4" strokeWidth={2} aria-hidden="true" />}
        >
          Inspect the contract
        </Button>
      </div>
    </div>
  );
}
