import { describe, expect, it } from "vitest";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { assertValidChallenge } from "./sep10";
import type { AnchorConfig } from "./toml";

/**
 * A SEP-10 challenge is a transaction the user is asked to sign. Everything the
 * anchor claims about it — which network, which service, which account — arrives
 * inside the same payload the anchor controls, so each claim has to be checked
 * against something we already knew. These tests are the record of what "already
 * knew" means: the TOML's signing key, the configured home domain, the web auth
 * endpoint we called, and the wallet that is connected.
 *
 * Nothing here talks to a network. The challenges are built locally so the
 * failure modes can be produced on demand rather than waited for.
 */

const ANCHOR = Keypair.random();
const CLIENT = Keypair.random();
const OTHER = Keypair.random();
const HOME = "anchor.example";

const cfg = {
  homeDomain: HOME,
  webAuth: `https://${HOME}/auth`,
  signingKey: ANCHOR.publicKey(),
  networkPassphrase: Networks.TESTNET,
} as unknown as AnchorConfig;

interface ChallengeOptions {
  signer?: Keypair;
  clientAccount?: string;
  opName?: string;
  webAuthDomain?: string | null;
  sequence?: string;
  network?: string;
}

/** One challenge transaction, correct unless an option says otherwise. */
function challenge(options: ChallengeOptions = {}): string {
  const {
    signer = ANCHOR,
    clientAccount = CLIENT.publicKey(),
    opName = `${HOME} auth`,
    webAuthDomain = HOME,
    sequence = "-1", // Account(seq) increments to 0 on the first operation
    network = Networks.TESTNET,
  } = options;

  const builder = new TransactionBuilder(new Account(signer.publicKey(), sequence), {
    fee: "100",
    networkPassphrase: network,
  })
    .addOperation(
      Operation.manageData({
        name: opName,
        value: "dGVzdGNoYWxsZW5nZW5vbmNldmFsdWUwMDAwMDAwMA==",
        source: clientAccount,
      }),
    )
    .setTimeout(300);

  if (webAuthDomain !== null) {
    builder.addOperation(
      Operation.manageData({
        name: "web_auth_domain",
        value: webAuthDomain,
        source: signer.publicKey(),
      }),
    );
  }
  return builder.build().toXDR();
}

const check = (xdr: string, network = Networks.TESTNET, account = CLIENT.publicKey()) =>
  assertValidChallenge(cfg, xdr, network, account);

describe("assertValidChallenge", () => {
  it("accepts a well-formed challenge for the connected wallet", () => {
    expect(() => check(challenge())).not.toThrow();
  });

  it("refuses a challenge for another network", () => {
    expect(() => check(challenge({ network: Networks.PUBLIC }), Networks.PUBLIC)).toThrow(
      /not the expected testnet network/i,
    );
  });

  it("refuses a challenge that is not sourced by the published signing key", () => {
    expect(() => check(challenge({ signer: OTHER }))).toThrow(/SIGNING_KEY/i);
  });

  it("refuses a challenge whose sequence number is not 0", () => {
    // A real transaction, replayable against the account, rather than a
    // challenge that can never be submitted.
    expect(() => check(challenge({ sequence: "41" }))).toThrow(/sequence number is not 0/i);
  });

  it("refuses a challenge scoped to a different home domain", () => {
    expect(() => check(challenge({ opName: "evil.example auth" }))).toThrow(
      /scoped to/i,
    );
  });

  it("refuses a challenge that names a different client account", () => {
    // The wallet would otherwise be asked to sign a statement about an account
    // that is not the one connected.
    expect(() => check(challenge({ clientAccount: OTHER.publicKey() }))).toThrow(
      /not the connected wallet/i,
    );
  });

  it("refuses a challenge whose web_auth_domain names another service", () => {
    expect(() => check(challenge({ webAuthDomain: "evil.example" }))).toThrow(
      /web_auth_domain/i,
    );
  });

  it("tolerates a challenge with no web_auth_domain operation", () => {
    // The operation is optional in SEP-10. Absence is not evidence of an attack;
    // a mismatch is.
    expect(() => check(challenge({ webAuthDomain: null }))).not.toThrow();
  });
});
