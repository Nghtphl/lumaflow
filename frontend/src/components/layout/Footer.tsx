import { ArrowUpRight } from "lucide-react";
import { BrandMark } from "./BrandMark";

export interface FooterProps {
  contractId: string;
  contractUrl: string;
  networkLabel: string;
  shortAddress: (value: string) => string;
}

const STANDARDS = ["SEP-1", "SEP-6", "SEP-10", "SEP-38", "Soroban"] as const;

export function Footer({ contractId, contractUrl, networkLabel, shortAddress }: FooterProps) {
  return (
    <footer className="mt-20 border-t border-line">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 px-4 py-10 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
        <div className="flex items-center gap-3">
          <span className="grid size-7 shrink-0 place-items-center">
            <BrandMark />
          </span>
          <div>
            <p className="text-callout font-medium tracking-wide text-ink">LUMAFLOW</p>
            <p className="mt-0.5 text-caption text-ink-4">
              {networkLabel} · non-custodial · collateral never leaves the contract
            </p>
          </div>
        </div>

        <p className="font-mono text-caption text-ink-4">
          {STANDARDS.join(" · ")}
        </p>

        <a
          href={contractUrl}
          target="_blank"
          rel="noreferrer"
          className="group inline-flex items-center gap-2 text-footnote text-ink-3 transition-colors hover:text-accent-ink"
        >
          <span className="font-mono">{shortAddress(contractId)}</span>
          <ArrowUpRight
            className="size-3.5 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
            strokeWidth={2.25}
            aria-hidden="true"
          />
        </a>
      </div>
    </footer>
  );
}
