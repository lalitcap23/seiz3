/** Each step is one presenter click. Same order every run so the 3-minute demo is deterministic. */
export const STEPS = {
  /** Run once before judging: oracles, 3 Morpho markets, lenders, borrowers, thin v4 pool, LP deposit, Core margin. */
  setup: async () => {
    // TODO
  },
  /** Scene: set all three DemoOracles to the drop price at once. */
  scene: async () => {
    // TODO: demoOracle.setPrice(numberToMorphoPx(dropPrice)) ×3
  },
  /** Market A: NaiveLiquidator dumps into the thin pool → bad debt. */
  marketA: async () => {
    // TODO
  },
  /** Market B: nothing to liquidate (low LLTV); just narrate. */
  marketB: async () => {},
  /** Market C: keeper calls vault.liquidate, then syncHedge. */
  marketC: async () => {
    // TODO: trigger keeper tick(s)
  },
  /** Monday: deep liquidity, market-open flag, unwindStep loop. */
  monday: async () => {
    // TODO: SeedPool THIN=false; riskParams.setMarketOpen(true); loop unwindStep
  },
} as const;

export type StepName = keyof typeof STEPS;
