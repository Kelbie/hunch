// Synthetic public inputs only. Explicitly opt out of ZDR for this test on Hobby;
// production/repository-review configuration is never changed here.
import { gatewayClient } from "../packages/core/src/jev.js";
const zdr = process.env.HUNCH_SMOKE_ZDR !== "false";
try {
  const result = await gatewayClient({ zeroDataRetention: zdr }).evaluate({
    model: "jev-1.13.0", state: { text: "The sky is blue." }, questions: {
      boolean: { type: "noul", instructions: "Does `text` say the sky is blue?" },
      choice: { type: "choice", instructions: "What color is the sky in `text`?", criteria: { blue: "Blue", red: "Red" } },
      score: { type: "score", instructions: "How clearly does `text` state the sky's color?", criteria: ["No color stated", "A color is stated explicitly"] },
    },
  });
  console.log(JSON.stringify({ syntheticDataOnly: true, zeroDataRetention: zdr, ...result }, null, 2));
} catch (error) {
  console.error("Synthetic Gateway request failed", error instanceof Error ? error.name : "unknown error");
  process.exitCode = 1;
}
