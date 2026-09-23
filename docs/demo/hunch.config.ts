import { choice, defineConfig, noul, score } from "@kelbie/hunch";

export default defineConfig({
  include: ["wallet/src/**", "app/features/**"],

  // rules/bips-spec.json in Kelbie/hunch, BIP-321 only
  packs: ["Kelbie/hunch/bips-spec#bip321/*"],

  rules: {
    // A sentence is a rule. Flagged when a change looks like it breaks it.
    "wallet/mint-trust": ["error", "A mint is only ever added after the user approves it."],

    // noul: one yes/no question, flagged when P(yes) reaches the threshold.
    "wallet/amount-units": ["error", noul({
      instructions: "Does `hunk` mix sats and decimal BTC in one calculation?",
      criteria: {
        true: "A BTC decimal and a sat integer meet with no conversion between them.",
        false: "One unit throughout, or every crossing converts explicitly.",
      },
      threshold: 0.8,
      when: /sat|btc|amount/i,          // cheap prefilter: skip hunks that cannot match
      reference: "wallet/src/units.ts", // sent alongside the hunk, from the base commit
    })],

    // choice: Jev picks one label. `report` labels are findings; `abstain`
    // labels are coverage gaps, which is not the same as passing.
    "payments/retry-safety": ["error", choice({
      instructions: "If the payment in `hunk` is retried, what happens to the customer?",
      criteria: {
        safe: "The retry reuses the same idempotency key, so one charge happens.",
        "double-charge": "A retry can charge the customer a second time.",
        unrelated: "No payment is sent here.",
        unclear: "The key's lifetime is not visible in this hunk.",
      },
      report: ["double-charge"],
      abstain: ["unclear"],
      minConfidence: 0.7,
      files: ["wallet/src/**"],
    })],

    // score: ordered rungs, lowest first. Flagged below reportBelow.
    "tests/assert-outcomes": ["warn", score({
      instructions: "How precisely does this test pin the behaviour it covers?",
      criteria: [
        "It only checks that nothing threw.",
        "It checks a broad shape, such as a value being defined.",
        "It checks the exact result for the main case.",
        "It checks exact results, including the failure paths.",
      ],
      reportBelow: 0.5,
      files: ["**/*.test.ts", "**/*.test.tsx"],
      message: "This test may not fail when the behaviour it covers breaks.",
    })],
  },
});
