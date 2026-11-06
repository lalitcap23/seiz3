// Shim: the CRE SDK's test utilities import `bun:test`; alias it to vitest so the offline
// simulations run under the repo's standard test runner (no bun required).
import { test as vitestTest } from "vitest";

export const test = vitestTest;
export default { test: vitestTest };
