import { Check, ChevronDown } from "lucide-react";
import { cn } from "../../lib/cn";
import { Menu, MenuItem } from "../ui/Menu";

export interface TokenOption<T extends string> {
  symbol: T;
  name: string;
  glyph: string;
}

export interface TokenSelectorProps<T extends string> {
  options: ReadonlyArray<TokenOption<T>>;
  value: T;
  balances: Record<T, number>;
  disabled?: boolean;
  onSelect: (token: T) => void;
}

/**
 * Asset picker that sits inside the amount field. Token marks are monochrome
 * glyphs on a neutral chip — giving each asset its own colour would put four
 * unrelated hues into a field whose only accent should be the focus ring.
 */
export function TokenSelector<T extends string>({
  options,
  value,
  balances,
  disabled = false,
  onSelect,
}: TokenSelectorProps<T>) {
  const selected = options.find((option) => option.symbol === value) ?? options[0];

  return (
    <Menu
      ariaLabel="Available Stellar assets"
      panelClassName="w-56"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          disabled={disabled}
          onClick={toggle}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`Selected asset ${value}. Change asset.`}
          className={cn(
            "pressable flex h-9 items-center gap-2 rounded-full border px-2.5",
            "disabled:pointer-events-none disabled:opacity-50",
            open
              ? "border-line-strong bg-surface-3"
              : "border-line-strong bg-surface-2 hover:bg-surface-3",
          )}
        >
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-fill-strong font-mono text-caption text-ink-2">
            {selected.glyph}
          </span>
          <span className="text-footnote font-medium text-ink">{selected.symbol}</span>
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 text-ink-4 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
              open && "rotate-180",
            )}
            strokeWidth={2.25}
            aria-hidden="true"
          />
        </button>
      )}
    >
      {({ close }) =>
        options.map((option) => (
          <MenuItem
            key={option.symbol}
            selected={option.symbol === value}
            onClick={() => {
              onSelect(option.symbol);
              close();
            }}
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-fill-strong font-mono text-footnote text-ink-2">
              {option.glyph}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-footnote font-medium text-ink">
                {option.symbol}
              </span>
              <span className="block truncate text-caption text-ink-4">{option.name}</span>
            </span>
            <span className="shrink-0 text-right font-mono text-caption tnum text-ink-3">
              {balances[option.symbol].toFixed(2)}
            </span>
            {option.symbol === value ? (
              <Check className="size-3.5 shrink-0 text-accent-ink" strokeWidth={2.5} aria-hidden="true" />
            ) : null}
          </MenuItem>
        ))
      }
    </Menu>
  );
}
