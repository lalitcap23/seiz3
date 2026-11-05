import { STEPS, type StepName } from "./steps.js";

const step = process.argv[2] as StepName | undefined;

if (!step || !(step in STEPS)) {
  console.log(`usage: pnpm replay <${Object.keys(STEPS).join("|")}>`);
  process.exit(1);
}

console.log(`[replay] ${step}`);
await STEPS[step]();
console.log(`[replay] ${step} done`);
