import { describe, expect, it } from "vitest";
import { parseFreighterAddress } from "./wallet";

/**
 * The console once showed a connected wallet that Freighter had never
 * authorised for the origin: the restore path read the address the extension
 * returned and, when that was empty, fell back to the one in localStorage. The
 * interface looked connected and the first signature asked for authorisation.
 *
 * The fallback is gone. What remains load-bearing is that this reader returns
 * nothing falsy-adjacent for a refusal — an empty string, an error envelope or a
 * shape it does not recognise all have to read as "no session", because the
 * caller now treats anything falsy as disconnected.
 */
describe("parseFreighterAddress", () => {
  const ADDRESS = "GAJGMHHGNFGYICIINPHY6QOVQKHUTTAT5PZ5E3IULVY6JUZD7UMOSSLR";

  it("reads the address Freighter returns", () => {
    expect(parseFreighterAddress({ address: ADDRESS })).toBe(ADDRESS);
    expect(parseFreighterAddress({ publicKey: ADDRESS })).toBe(ADDRESS);
    expect(parseFreighterAddress(ADDRESS)).toBe(ADDRESS);
  });

  it("returns nothing when the wallet refused", () => {
    // What a locked wallet, or an origin that was never granted access, sends
    // back. None of these may become a session.
    expect(parseFreighterAddress({ address: "", error: "User declined access" })).toBe("");
    expect(parseFreighterAddress({ error: "Freighter is locked" })).toBe("");
    expect(parseFreighterAddress({})).toBe("");
    expect(parseFreighterAddress(null)).toBe("");
    expect(parseFreighterAddress(undefined)).toBe("");
    expect(parseFreighterAddress({ address: 42 })).toBe("");
  });
});
