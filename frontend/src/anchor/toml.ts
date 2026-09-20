import { Networks } from "@stellar/stellar-sdk";

export interface AnchorConfig {
  homeDomain: string;
  webAuth: string; // WEB_AUTH_ENDPOINT
  transferServer: string; // TRANSFER_SERVER
  kycServer: string; // KYC_SERVER
  quoteServer: string; // ANCHOR_QUOTE_SERVER
  signingKey: string; // SIGNING_KEY — validates the SEP-10 challenge
  networkPassphrase: string;
  orgName: string;
  asset: { code: string; issuer: string };
}

interface ParsedToml {
  root: Record<string, string>;
  currencies: Array<Record<string, string>>;
}

/**
 * Minimal SEP-1 reader. A stellar.toml only ever needs scalar keys, `[SECTION]`
 * tables and `[[CURRENCIES]]` array-of-tables, so a full TOML parser would be a
 * dependency bought for nothing. Anything this does not understand is skipped
 * rather than thrown on: an unfamiliar key in someone else's TOML must not stop
 * discovery of the keys we do need.
 */
/**
 * Keys that must never be written onto a parsed table.
 *
 * The key pattern below accepts letters and underscores, which `__proto__`
 * satisfies. Upper-casing it happens to produce a harmless `__PROTO__`, but that
 * is an accident of formatting rather than a decision, and an accident is a poor
 * thing to rest prototype safety on. This states it.
 */
const UNSAFE_KEYS = new Set(["__PROTO__", "CONSTRUCTOR", "PROTOTYPE"]);

const emptyTable = (): Record<string, string> => Object.create(null) as Record<string, string>;

function parseToml(text: string): ParsedToml {
  const root: Record<string, string> = emptyTable();
  const currencies: Array<Record<string, string>> = [];
  let target: Record<string, string> = root;
  let inCurrency = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const arrayTable = /^\[\[\s*([A-Za-z0-9_]+)\s*\]\]$/.exec(line);
    if (arrayTable) {
      inCurrency = arrayTable[1].toUpperCase() === "CURRENCIES";
      if (inCurrency) {
        target = emptyTable();
        currencies.push(target);
      } else {
        target = emptyTable();
      }
      continue;
    }

    if (/^\[[^[\]]+\]$/.test(line)) {
      // A plain [SECTION] such as [DOCUMENTATION]; its keys are not ours.
      inCurrency = false;
      target = emptyTable();
      continue;
    }

    const pair = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    const [, key, rawValue] = pair;
    const value = rawValue.trim();

    // Arrays (ACCOUNTS=[…]) and inline tables are not needed by this client.
    if (value.startsWith("[") || value.startsWith("{")) continue;

    const name = key.toUpperCase();
    if (UNSAFE_KEYS.has(name)) continue;
    const quoted = /^"(.*)"$/.exec(value) || /^'(.*)'$/.exec(value);
    target[name] = quoted ? quoted[1] : value.replace(/\s+#.*$/, "");
  }

  return { root, currencies };
}

const cache = new Map<string, Promise<AnchorConfig>>();

async function fetchAnchorConfig(homeDomain: string): Promise<AnchorConfig> {
  const domain = homeDomain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!domain) throw new Error("Anchor home domain is not configured");

  const tomlUrl = `https://${domain}/.well-known/stellar.toml`;
  const response = await fetch(tomlUrl, { headers: { Accept: "text/plain" } });
  if (!response.ok) {
    throw new Error(`Anchor discovery failed: ${tomlUrl} returned HTTP ${response.status}`);
  }

  const { root, currencies } = parseToml(await response.text());

  // Fail loudly on a network mismatch rather than letting the user sign a
  // mainnet challenge from a testnet session (or the reverse).
  const networkPassphrase = root.NETWORK_PASSPHRASE || "";
  if (networkPassphrase !== Networks.TESTNET) {
    throw new Error(
      `Anchor ${domain} runs on "${networkPassphrase || "an unspecified network"}", ` +
        `but this app is built for "${Networks.TESTNET}".`,
    );
  }

  const required: Array<[keyof AnchorConfig, string]> = [
    ["webAuth", "WEB_AUTH_ENDPOINT"],
    ["transferServer", "TRANSFER_SERVER"],
    ["signingKey", "SIGNING_KEY"],
  ];
  for (const [, tomlKey] of required) {
    if (!root[tomlKey]) {
      throw new Error(`Anchor ${domain} is missing ${tomlKey} in its stellar.toml`);
    }
  }

  const fallbackIssuer =
    (import.meta.env.VITE_USDC_ISSUER as string | undefined)?.trim() || "";
  const currency =
    currencies.find((item) => item.CODE?.toUpperCase() === "USDC") || currencies[0];
  const code = currency?.CODE || "USDC";
  const issuer = currency?.ISSUER || fallbackIssuer;
  if (!issuer) {
    throw new Error(`Anchor ${domain} does not publish an issuer for ${code}`);
  }

  const trimSlash = (value: string): string => value.replace(/\/+$/, "");

  return {
    homeDomain: domain,
    webAuth: trimSlash(root.WEB_AUTH_ENDPOINT),
    transferServer: trimSlash(root.TRANSFER_SERVER),
    kycServer: trimSlash(root.KYC_SERVER || ""),
    quoteServer: trimSlash(root.ANCHOR_QUOTE_SERVER || ""),
    signingKey: root.SIGNING_KEY,
    networkPassphrase,
    orgName: root.ORG_NAME || domain,
    asset: { code, issuer },
  };
}

/** SEP-1 discovery. Cached per home domain for the lifetime of the page. */
export async function loadAnchorConfig(homeDomain: string): Promise<AnchorConfig> {
  const key = homeDomain.trim().toLowerCase();
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = fetchAnchorConfig(homeDomain).catch((error: unknown) => {
    // A failed discovery must not be cached, or a transient network blip would
    // wedge the anchor panel for the rest of the session.
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}

/** `stellar:USDC:G…` — the SEP-38 identifier for the anchor's asset. */
export function sep38Asset(cfg: AnchorConfig): string {
  return `stellar:${cfg.asset.code}:${cfg.asset.issuer}`;
}
