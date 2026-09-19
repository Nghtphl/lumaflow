import { useCallback, useEffect, useRef, useState } from "react";
import { loadAnchorConfig } from "./toml";
import type { AnchorConfig } from "./toml";
import { fetchAnchorRates } from "./sep38";
import type { AnchorRates } from "./sep38";
import { loadClassicBalances } from "./stellar";
import type { ClassicBalances } from "./stellar";

export const ANCHOR_HOME_DOMAIN =
  (import.meta.env.VITE_ANCHOR_HOME_DOMAIN as string | undefined)?.trim() ||
  "tr-mock-anchor.fly.dev";

/** Re-quote often enough that the lira figure on screen is never stale. */
const RATE_REFRESH_MS = 60_000;

export interface AnchorState {
  config: AnchorConfig | null;
  configError: string;
  rates: AnchorRates | null;
  ratesError: string;
  balances: ClassicBalances | null;
  balancesError: string;
  loadingBalances: boolean;
  refreshBalances: () => Promise<void>;
  refreshRates: () => Promise<void>;
}

/**
 * Owns everything the app needs from the anchor: SEP-1 discovery, the live
 * TRY/USDC book, and the user's classic balances. Held here rather than in the
 * ramp panel because the order form is priced off the same numbers.
 */
export function useAnchor(walletAddress: string): AnchorState {
  const [config, setConfig] = useState<AnchorConfig | null>(null);
  const [configError, setConfigError] = useState("");
  const [rates, setRates] = useState<AnchorRates | null>(null);
  const [ratesError, setRatesError] = useState("");
  const [balances, setBalances] = useState<ClassicBalances | null>(null);
  const [balancesError, setBalancesError] = useState("");
  const [loadingBalances, setLoadingBalances] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const resolved = await loadAnchorConfig(ANCHOR_HOME_DOMAIN);
        if (cancelled) return;
        setConfig(resolved);
        setConfigError("");
      } catch (error) {
        if (cancelled) return;
        setConfigError(
          error instanceof Error ? error.message : "Anchor discovery failed",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshRates = useCallback(async (): Promise<void> => {
    if (!config) return;
    try {
      const next = await fetchAnchorRates(config);
      if (!mounted.current) return;
      setRates(next);
      setRatesError("");
    } catch (error) {
      if (!mounted.current) return;
      setRatesError(error instanceof Error ? error.message : "Rate unavailable");
    }
  }, [config]);

  useEffect(() => {
    if (!config) return;
    void refreshRates();
    const timer = window.setInterval(() => void refreshRates(), RATE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [config, refreshRates]);

  const refreshBalances = useCallback(async (): Promise<void> => {
    if (!config || !walletAddress) {
      setBalances(null);
      return;
    }
    setLoadingBalances(true);
    try {
      const next = await loadClassicBalances(config, walletAddress);
      if (!mounted.current) return;
      setBalances(next);
      setBalancesError("");
    } catch (error) {
      if (!mounted.current) return;
      setBalancesError(
        error instanceof Error ? error.message : "Balances unavailable",
      );
    } finally {
      if (mounted.current) setLoadingBalances(false);
    }
  }, [config, walletAddress]);

  useEffect(() => {
    void refreshBalances();
  }, [refreshBalances]);

  return {
    config,
    configError,
    rates,
    ratesError,
    balances,
    balancesError,
    loadingBalances,
    refreshBalances,
    refreshRates,
  };
}
