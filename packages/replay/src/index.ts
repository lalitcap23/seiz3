import { STEPS, type StepName } from "./steps.js";

const step = process.argv[2] as StepName | undefined;

if (!step || !(step in STEPS)) {
  console.log(`usage: pnpm replay <${Object.keys(STEPS).join("|")}>`);
  process.exit(1);
}

console.log(`[replay] ${step}`);
try {
  await STEPS[step]();
  console.log(`[replay] ${step} done`);
} catch (error) {
  console.error(`[replay] ${step} failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  process.exit(1);
}
