import { describe, expect, it } from "vitest";
import {
  PRICE_SCALE,
  fromPriceAtoms,
  stopBlockedReason,
  toPriceAtoms,
  toStopConfig,
  toStopOrder,
  type StopOrderView,
} from "./stopVault";

/**
 * These cover the places where the console turns contract data into a number or
 * a sentence a user acts on. Every one of them is a path where a silent wrong
 * answer is worse than a thrown error: a mis-scaled stop price is an order that
 * triggers at the wrong level, and a guessed enum is a claim about an order the
 * chain does not agree with.
 */

const armed = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id: 1,
  owner: "GAAA",
  token_in: "CIN",
  token_out: "COUT",
  amount_in: 90000000n,
  min_user_out: 9000000n,
  fee_bps: 100,
  deadline: 1789981071,
  trigger: ["PublicStopBelow", 17000000000000n],
  policy_version: 1,
  status: 0,
  triggered_at: 0,
  observed_price: 0n,
  observed_timestamp: 0,
  ...over,
});

describe("toPriceAtoms", () => {
  it("scales a decimal to the feed's 14-digit integer", () => {
    expect(toPriceAtoms("0.17")).toBe(17000000000000n);
    expect(toPriceAtoms("1")).toBe(PRICE_SCALE);
    expect(toPriceAtoms("0.18985273102759")).toBe(18985273102759n);
  });

  it("accepts a comma as the decimal separator", () => {
    expect(toPriceAtoms("0,17")).toBe(toPriceAtoms("0.17"));
  });

  it("does not silently round away precision it cannot represent", () => {
    // 15 decimals is one more than the feed's scale. Truncating would move the
    // trigger level without telling anyone, so it throws instead.
    expect(() => toPriceAtoms("0.123456789012345")).toThrow();
  });

  it("rejects input that is not a positive decimal", () => {
    for (const bad of ["", " ", "abc", "-1", "1e5", "0x10", "1.2.3", "--1"]) {
      expect(() => toPriceAtoms(bad)).toThrow();
    }
  });

  it("round-trips through fromPriceAtoms at display precision", () => {
    expect(fromPriceAtoms(toPriceAtoms("0.1700000"))).toBe("0.1700000");
  });
});

describe("toStopOrder", () => {
  it("reads an armed order as the contract stored it", () => {
    const order = toStopOrder(armed()) as StopOrderView;
    expect(order).not.toBeNull();
    expect(order.stopPrice).toBe(17000000000000n);
    expect(order.amountIn).toBe(90000000n);
    expect(order.minUserOut).toBe(9000000n);
    expect(order.status).toBe("Armed");
  });

  it("maps every status discriminant the contract defines", () => {
    const expected = ["Armed", "Triggered", "Executed", "Cancelled"];
    expected.forEach((name, discriminant) => {
      expect(toStopOrder(armed({ status: discriminant }))?.status).toBe(name);
    });
  });

  it("refuses a status this build does not know rather than guessing", () => {
    // A later contract could add a state. Defaulting it to "Armed" would offer
    // a Trigger button for an order that is not armed.
    expect(toStopOrder(armed({ status: 4 }))).toBeNull();
    expect(toStopOrder(armed({ status: -1 }))).toBeNull();
  });

  it("refuses a trigger variant this build does not understand", () => {
    expect(toStopOrder(armed({ trigger: ["SealedStopBelow", 1n] }))).toBeNull();
    expect(toStopOrder(armed({ trigger: "PublicStopBelow" }))).toBeNull();
    expect(toStopOrder(armed({ trigger: [] }))).toBeNull();
    expect(toStopOrder(armed({ trigger: undefined }))).toBeNull();
  });
});

describe("toStopConfig", () => {
  const config = {
    collateral_token: "CIN",
    payout_token: "COUT",
    max_amount_in: 100000000n,
    router: "CROUTER",
    policy: { decimals: 14, version: 1 },
  };

  it("reads the cap and the policy scale off the contract", () => {
    const parsed = toStopConfig(config);
    expect(parsed?.maxAmountIn).toBe(100000000n);
    expect(parsed?.policyDecimals).toBe(14);
    expect(parsed?.policyVersion).toBe(1);
  });

  it("returns null rather than inventing a cap", () => {
    // A missing cap must not become 0 (blocks every order) or Infinity (blocks
    // none). Null leaves the contract as the only authority, which it is.
    expect(toStopConfig({ ...config, max_amount_in: undefined })).toBeNull();
    expect(toStopConfig({ ...config, policy: undefined })).toBeNull();
    expect(toStopConfig({})).toBeNull();
  });
});

describe("stopBlockedReason", () => {
  const view = (over: Partial<StopOrderView> = {}): StopOrderView =>
    ({ ...(toStopOrder(armed()) as StopOrderView), ...over });

  it("leaves an open order actionable", () => {
    expect(stopBlockedReason(view(), 1000)).toBeNull();
  });

  it("names why a terminal order cannot be acted on", () => {
    expect(stopBlockedReason(view({ status: "Executed" }), 1000)).toMatch(/settled/i);
    expect(stopBlockedReason(view({ status: "Cancelled" }), 1000)).toMatch(/cancelled/i);
  });

  it("treats the deadline as passed at the deadline, matching the contract", () => {
    // The contract refuses at `now >= deadline`, so the interface must not
    // offer an action one second before it starts failing on chain.
    const order = view({ deadline: 5_000 });
    expect(stopBlockedReason(order, 4_999)).toBeNull();
    expect(stopBlockedReason(order, 5_000)).toMatch(/deadline/i);
  });

  it("points an expired order at cancellation rather than a dead end", () => {
    expect(stopBlockedReason(view({ deadline: 10 }), 99)).toMatch(/cancel/i);
  });
});
