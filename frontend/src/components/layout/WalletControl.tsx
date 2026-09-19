import { useCallback, useState } from "react";
import { Check, Copy, LogOut, Radio, Wallet } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { Menu, MenuItem } from "../ui/Menu";

export interface WalletControlProps {
  address: string;
  connecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  explorerBaseUrl: string;
  shortAddress: (value: string) => string;
}

/**
 * Connect button before a session exists, account menu after. It lives outside
 * the navbar so the landing page can leave the slot empty: connecting a wallet
 * is a console concern, and offering it next to a page that cannot use it just
 * asks for a signature nobody needs yet.
 */
export function WalletControl({
  address,
  connecting,
  onConnect,
  onDisconnect,
  explorerBaseUrl,
  shortAddress,
}: WalletControlProps) {
  const [copied, setCopied] = useState(false);

  const copyAddress = useCallback(() => {
    if (!address) return;
    void navigator.clipboard
      ?.writeText(address)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => setCopied(false));
  }, [address]);

  if (!address) {
    return (
      <Button
        variant="primary"
        onClick={onConnect}
        loading={connecting}
        icon={<Wallet className="size-4" strokeWidth={2} aria-hidden="true" />}
      >
        <span className="hidden sm:inline">
          {connecting ? "Connecting" : "Connect wallet"}
        </span>
        <span className="sm:hidden">{connecting ? "…" : "Connect"}</span>
      </Button>
    );
  }

  return (
    <Menu
      ariaLabel="Wallet menu"
      panelClassName="w-64"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          className={cn(
            "pressable flex h-10 items-center gap-2 rounded-md px-3",
            open ? "bg-fill-strong" : "bg-fill hover:bg-fill-strong",
          )}
        >
          <Wallet className="size-4 shrink-0 text-ink-3" strokeWidth={2} aria-hidden="true" />
          <span className="font-mono text-footnote text-ink">{shortAddress(address)}</span>
        </button>
      )}
    >
      {({ close }) => (
        <>
          <div className="px-2.5 py-2">
            <p className="text-caption uppercase text-ink-4">Connected account</p>
            <p className="mt-1 break-all font-mono text-footnote text-ink-2">{address}</p>
          </div>
          <div className="my-1 h-px bg-line" />
          <MenuItem onClick={copyAddress}>
            {copied ? (
              <Check className="size-4 shrink-0 text-positive-ink" strokeWidth={2} aria-hidden="true" />
            ) : (
              <Copy className="size-4 shrink-0 text-ink-3" strokeWidth={2} aria-hidden="true" />
            )}
            <span className="text-footnote">{copied ? "Address copied" : "Copy address"}</span>
          </MenuItem>
          <MenuItem
            onClick={() => {
              window.open(`${explorerBaseUrl}/account/${address}`, "_blank", "noreferrer");
              close();
            }}
          >
            <Radio className="size-4 shrink-0 text-ink-3" strokeWidth={2} aria-hidden="true" />
            <span className="text-footnote">View on Stellar Expert</span>
          </MenuItem>
          <MenuItem
            onClick={() => {
              onDisconnect();
              close();
            }}
            className="text-negative-ink hover:bg-negative-soft hover:text-negative-ink"
          >
            <LogOut className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
            <span className="text-footnote">Disconnect</span>
          </MenuItem>
        </>
      )}
    </Menu>
  );
}
