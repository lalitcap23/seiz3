import { describe, expect, it } from "vitest";

import { BuyerWindow } from "../../src/buyerWindow.js";

describe("BuyerWindow", () => {
  it("is off at 0: never holds an unwind", () => {
    const w = new BuyerWindow(0n);
    w.observe(10n, 100n);
    expect(w.holds(0n, 100n)).toBe(false);
  });

  it("holds new stock for the window, then lets the push through", () => {
    const w = new BuyerWindow(45n);
    w.observe(0n, 90n);
    w.observe(10n, 100n); // a liquidation
    expect(w.holds(0n, 100n)).toBe(true);
    expect(w.holds(0n, 144n)).toBe(true);
    expect(w.holds(0n, 145n)).toBe(false); // window over: no buyer, the keeper pushes anyway
  });

  it("closes as soon as a sale lands (a hook fill sets lastUnwindAt)", () => {
    const w = new BuyerWindow(45n);
    w.observe(10n, 100n);
    w.observe(9n, 112n); // a buyer took some through the hook
    expect(w.holds(112n, 113n)).toBe(false);
  });

  it("an older sale (the last round's) doesn't close a new window", () => {
    const w = new BuyerWindow(45n);
    w.observe(10n, 100n);
    expect(w.holds(80n, 101n)).toBe(true);
  });

  it("restarts on more stock (a second liquidation), and clears when flat", () => {
    const w = new BuyerWindow(45n);
    w.observe(10n, 100n);
    w.observe(9n, 110n); // sold one
    w.observe(15n, 120n); // liquidated again
    expect(w.holds(110n, 121n)).toBe(true);
    w.observe(0n, 200n);
    expect(w.holds(0n, 201n)).toBe(false);
    expect(w.remaining(201n)).toBe(0n);
  });
});
