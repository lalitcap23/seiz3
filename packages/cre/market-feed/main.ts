import { Runner } from "@chainlink/cre-sdk";
import { configSchema, initWorkflow } from "../src/workflow";

export async function main() {
  const runner = await Runner.newRunner({ configSchema });
  await runner.run(initWorkflow);
}

main(); // a bare call: cre-compile only spots `main()` / `await main()` and otherwise appends a second one
