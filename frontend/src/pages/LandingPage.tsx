import { Banknote, Landmark, ShieldCheck, Timer, Zap } from "lucide-react";
import { Masthead } from "../components/layout/Masthead";
import { Reveal } from "../components/ui/Reveal";
import { SectionHeading } from "../components/ui/SectionHeading";

/**
 * The lifecycle, and the only explanation the landing page gives. Telemetry,
 * the order form and the public queue all moved to /console: none of them mean
 * anything to a reader who has not decided to use the thing yet, and a page
 * that opens with live RPC latency is answering a question nobody asked.
 */
const SETTLEMENT_FLOW = [
  {
    icon: Banknote,
    title: "Fund in lira",
    body: "A FAST/EFT transfer to the anchor settles over SEP-6 and credits testnet USDC to your Stellar account.",
  },
  {
    icon: Timer,
    title: "Set the trigger",
    body: "Choose a limit order or a stop-loss, then set the minimum you are willing to receive. That minimum is what the contract guards.",
  },
  {
    icon: ShieldCheck,
    title: "Collateral locks",
    body: "The collateral moves into the Soroban vault and stays escrowed there. Only you can cancel it, and cancelling refunds the whole amount.",
  },
  {
    icon: Zap,
    title: "An executor settles it",
    body: "Anyone can call the contract once the conditions hold. It measures what the swap actually returned, pays the bounty from that, and only then pays you — if your minimum is still met.",
  },
  {
    icon: Landmark,
    title: "Back to an IBAN",
    body: "Send USDC to the anchor treasury with its memo and the lira leg pays out to your bank account.",
  },
] as const;

export interface LandingPageProps {
  contractUrl: string;
}

export function LandingPage({ contractUrl }: LandingPageProps) {
  return (
    <main className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
      <Masthead contractUrl={contractUrl} />

      <section id="flow" className="pt-24 pb-4">
        <SectionHeading
          eyebrow="Lifecycle"
          title="How a trigger settles"
          description="Five steps from a bank transfer in Istanbul to a filled order on Soroban — and back again."
        />
        <Reveal
          stagger
          as="ol"
          className="mt-10 grid gap-x-8 gap-y-9 sm:grid-cols-2 lg:grid-cols-5"
        >
          {SETTLEMENT_FLOW.map((step, index) => {
            const Icon = step.icon;
            return (
              <li key={step.title} className="min-w-0 border-t border-line pt-4">
                <div className="flex items-center gap-2 text-ink-3">
                  <Icon className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
                  <span className="font-mono text-caption tnum text-ink-4">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                </div>
                <h3 className="mt-3 text-subhead text-ink">{step.title}</h3>
                <p className="mt-2 text-footnote leading-relaxed text-ink-3">{step.body}</p>
              </li>
            );
          })}
        </Reveal>
      </section>
    </main>
  );
}
