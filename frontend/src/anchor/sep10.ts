import { Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { signTransaction } from "@stellar/freighter-api";
import type { AnchorConfig } from "./toml";

/**
 * SEP-10 web authentication.
 *
 * The anchor hands out a challenge transaction; the account proves ownership by
 * signing it, and gets a short-lived JWT back. The JWT is kept in memory (with a
 * sessionStorage mirror so a reload inside the same tab does not force another
 * Freighter prompt) and never in localStorage — a bearer token that outlives the
 * browser session is a liability, not a convenience.
 */

interface CachedToken {
  jwt: string;
  expiresAt: number; // epoch ms; 0 when the token carries no exp claim
}

const memory = new Map<string, CachedToken>();

const cacheKey = (cfg: AnchorConfig, account: string): string =>
  `sep10:${cfg.homeDomain}:${account}`;

/** Decode the `exp` claim without verifying — the anchor is the only verifier. */
function readExpiry(jwt: string): number {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return 0;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const claims = JSON.parse(json) as { exp?: number };
    return typeof claims.exp === "number" ? claims.exp * 1_000 : 0;
  } catch {
    return 0;
  }
}

function readCache(key: string): string | null {
  let entry = memory.get(key);
  if (!entry) {
    try {
      const stored = window.sessionStorage.getItem(key);
      if (stored) entry = { jwt: stored, expiresAt: readExpiry(stored) };
    } catch {
      // Private-mode sessionStorage can throw; the in-memory copy is enough.
    }
  }
  if (!entry) return null;
  // Treat a token inside its last 30s as already gone: better one extra
  // signature than a 401 halfway through a deposit poll.
  if (entry.expiresAt && entry.expiresAt - 30_000 < Date.now()) {
    clearToken(key);
    return null;
  }
  memory.set(key, entry);
  return entry.jwt;
}

function writeCache(key: string, jwt: string): void {
  memory.set(key, { jwt, expiresAt: readExpiry(jwt) });
  try {
    window.sessionStorage.setItem(key, jwt);
  } catch {
    // Non-fatal: the token still lives in module memory for this page.
  }
}

function clearToken(key: string): void {
  memory.delete(key);
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Nothing to do — the memory copy is already gone.
  }
}

/**
 * Refuse to sign anything that is not the challenge this anchor is supposed to
 * have issued. An unchecked SEP-10 client will happily sign a payment dressed up
 * as a challenge, so every one of these assertions is load-bearing.
 */
export function assertValidChallenge(
  cfg: AnchorConfig,
  xdrText: string,
  networkPassphrase: string,
  account: string,
): void {
  if (networkPassphrase !== Networks.TESTNET) {
    throw new Error(
      `Anchor challenge is for "${networkPassphrase}", not the expected testnet network.`,
    );
  }
  const transaction = TransactionBuilder.fromXDR(xdrText, networkPassphrase);
  if ("innerTransaction" in transaction) {
    throw new Error("Anchor returned a fee-bump transaction as its SEP-10 challenge.");
  }
  if (transaction.source !== cfg.signingKey) {
    throw new Error(
      `Challenge is signed by ${transaction.source}, not the anchor's published SIGNING_KEY.`,
    );
  }
  if (transaction.sequence !== "0") {
    throw new Error("Challenge sequence number is not 0 — this is not a SEP-10 challenge.");
  }
  const [first] = transaction.operations;
  if (!first || first.type !== "manageData") {
    throw new Error("Challenge does not start with a manageData operation.");
  }
  if (first.name !== `${cfg.homeDomain} auth`) {
    throw new Error(
      `Challenge is scoped to "${first.name}", not "${cfg.homeDomain} auth".`,
    );
  }
  // SEP-10 binds the challenge to the account being authenticated by making it
  // the source of the first operation. Without this check the wallet would sign
  // a challenge minted for somebody else's account — the signature would not
  // authenticate them, but the user would have signed a statement about an
  // account that is not theirs, and we would have asked them to.
  if (first.source !== account) {
    throw new Error(
      `Challenge names ${first.source || "no account"} as the client, not the connected wallet.`,
    );
  }
  // `web_auth_domain`, when the anchor sends it, must name the server that
  // issued the challenge. It is what stops a challenge from one service being
  // replayed against another that trusts the same signing key. It is optional
  // in the spec, so absence is tolerated and a mismatch is not.
  const webAuthDomain = transaction.operations.find(
    (operation) => operation.type === "manageData" && operation.name === "web_auth_domain",
  );
  if (webAuthDomain && webAuthDomain.type === "manageData") {
    const expected = new URL(cfg.webAuth).host;
    const claimed = webAuthDomain.value ? new TextDecoder().decode(webAuthDomain.value) : "";
    if (claimed !== expected) {
      throw new Error(
        `Challenge claims web_auth_domain "${claimed}", not "${expected}".`,
      );
    }
  }
}

async function requestToken(cfg: AnchorConfig, account: string): Promise<string> {
  const challengeUrl = `${cfg.webAuth}?account=${encodeURIComponent(account)}&home_domain=${encodeURIComponent(cfg.homeDomain)}`;
  const challengeResponse = await fetch(challengeUrl, {
    headers: { Accept: "application/json" },
  });
  if (!challengeResponse.ok) {
    throw new Error(
      `Anchor authentication challenge failed (HTTP ${challengeResponse.status}).`,
    );
  }
  const challenge = (await challengeResponse.json()) as {
    transaction?: string;
    network_passphrase?: string;
    error?: string;
  };
  if (challenge.error || !challenge.transaction) {
    throw new Error(challenge.error || "Anchor returned an empty SEP-10 challenge.");
  }

  const passphrase = challenge.network_passphrase || cfg.networkPassphrase;
  assertValidChallenge(cfg, challenge.transaction, passphrase, account);

  const signed = await signTransaction(challenge.transaction, {
    networkPassphrase: passphrase,
    address: account,
  });
  if (signed.error || !signed.signedTxXdr) {
    throw new Error("Anchor sign-in was rejected in the wallet.");
  }

  const tokenResponse = await fetch(cfg.webAuth, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ transaction: signed.signedTxXdr }),
  });
  const token = (await tokenResponse.json().catch(() => ({}))) as {
    token?: string;
    error?: string;
  };
  if (!tokenResponse.ok || !token.token) {
    throw new Error(
      token.error || `Anchor rejected the signed challenge (HTTP ${tokenResponse.status}).`,
    );
  }
  return token.token;
}

/** Returns a valid JWT, prompting Freighter only when the cache is cold. */
export async function authenticate(
  cfg: AnchorConfig,
  account: string,
): Promise<string> {
  const key = cacheKey(cfg, account);
  const cached = readCache(key);
  if (cached) return cached;
  const jwt = await requestToken(cfg, account);
  writeCache(key, jwt);
  return jwt;
}

/** Drop a token the anchor has stopped accepting, forcing a fresh challenge. */
export function invalidateToken(cfg: AnchorConfig, account: string): void {
  clearToken(cacheKey(cfg, account));
}

/**
 * Run an authenticated anchor call, re-authenticating once on a 401. JWTs expire
 * mid-flow during a long deposit poll; a transparent retry is the difference
 * between a demo that finishes and one that dies at step three.
 */
export async function withAuth<T>(
  cfg: AnchorConfig,
  account: string,
  call: (jwt: string) => Promise<T>,
): Promise<T> {
  const jwt = await authenticate(cfg, account);
  try {
    return await call(jwt);
  } catch (error) {
    if (!(error instanceof AnchorUnauthorizedError)) throw error;
    invalidateToken(cfg, account);
    return call(await authenticate(cfg, account));
  }
}

/** Thrown by the SEP-6/SEP-38 clients so `withAuth` can recognise an expiry. */
export class AnchorUnauthorizedError extends Error {
  constructor(message = "Anchor session expired") {
    super(message);
    this.name = "AnchorUnauthorizedError";
  }
}

/** A cached token or a lazy source that refreshes it before a request. */
export type Jwt = string | (() => Promise<string>);

export async function resolveJwt(jwt: Jwt): Promise<string> {
  return typeof jwt === "string" ? jwt : jwt();
}

export function jwtProvider(cfg: AnchorConfig, account: string): () => Promise<string> {
  return () => authenticate(cfg, account);
}
