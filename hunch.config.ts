import { choice, defineConfig, noul, score } from "@kelbie/hunch";

export default defineConfig({
  extends: ["hunch:recommended", "hunch:typescript", "hunch:rust"],
  include: ["packages/**/src/**/*.ts", "apps/**/{api,lib}/**/*.ts", "examples/review-showcase/**/*.{ts,rs}", "skills/hunch/**/*.md", "README.md"],
  // The skill is the user documentation. Generated pages are checked by tests; these are the
  // hand-written ones, and only the docs rule below is asked about them.
  ignore: ["skills/hunch/references/cli.md", "skills/hunch/examples/**"],
  skills: ["./.agents/skills/codebase-design"],
  agentsMd: true,
  // Explicit opt-out for this public repository on Vercel Hobby.
  zeroDataRetention: false,
  failOnError: false,
  rules: {
    "review/honest-coverage": ["warn", noul({
      instructions: "Does `hunk` represent a missing provider answer or skipped review work as evidence that the code passed review?",
      message: "A failed operation may now be reported as successful completion.",
    })],
    "security/trusted-policy": ["error", "PR content must not control the trusted policy used to judge that same PR."],
    "report/evidence": ["warn", "A report must distinguish a configured rule description from a model-generated explanation or an independently proven defect."],
    "docs/skill-matches-cli": ["warn", noul({
      files: ["skills/hunch/**/*.md", "README.md"],
      instructions: "Does the documentation added or changed in `hunk` state a Hunch command, flag, default value, exit code or output that contradicts the generated CLI reference in `reference`? Require a concrete statement in `hunk` and the specific entry in `reference` it disagrees with.",
      criteria: {
        true: "A command, flag, default, exit code or output described in the changed lines disagrees with the reference.",
        false: "Everything the changed lines say about the CLI matches the reference, or they describe something the reference does not cover.",
      },
      threshold: 0.8,
      reference: "skills/hunch/references/cli.md",
      message: "This documentation may contradict what the CLI actually accepts or does.",
    })],
    "demo/tenant-access": ["error", noul({
      files: ["examples/review-showcase/typescript/authorization.ts"],
      instructions: "Does the changed invoice lookup in `hunk` let a signed-in actor read a different tenant's invoice by supplying that tenant's ID, without verifying that the actor belongs to it? Require visible evidence of both the input and the missing authorization check.",
      message: "The invoice lookup may trust a caller-supplied tenant ID, allowing access to another tenant's invoices.",
      threshold: 0.85,
    })],
    "demo/payment-retry": ["error", choice({
      files: ["examples/review-showcase/typescript/payment.ts"],
      instructions: "Classify the payment retry behavior introduced by `hunk`. A gateway can accept a charge before its response times out. Judge the actual idempotency key used for successive attempts at the same payment.",
      criteria: {
        "stable-retry": "Every attempt uses the same idempotency key for the same payment, so the gateway can return the original charge.",
        "duplicate-charge": "Retries use different idempotency keys, so a timed-out successful charge can be charged again.",
        "not-applicable": "No payment retry is visible or there is insufficient evidence to decide.",
      },
      report: ["duplicate-charge"],
      minConfidence: 0.6,
      message: "A retry may charge the customer twice: each attempt gives the gateway a new idempotency key.",
    })],
    "demo/checkout-interface": ["warn", score({
      files: ["examples/review-showcase/typescript/checkout.ts"],
      instructions: "Rate how much checkout orchestration the changed interface in `hunk` requires of its caller. Use the visible caller and implementation, not method count or naming alone. Higher means the module owns the complete task.",
      criteria: [
        "The caller must coordinate reservation, payment and finalization, preserving intermediate handles and their ordering.",
        "The module owns some steps, but the caller must still coordinate multiple internal stages.",
        "One operation completes checkout, but the caller must supply an implementation-specific intermediate handle.",
        "One task-level operation owns the sequence and intermediate state; the caller supplies only the order.",
      ],
      reportBelow: 0.5,
      message: "Callers may have to coordinate internal steps and intermediate state, making the required order easy to misuse.",
    })],
  },
  // Code rules are not asked about documentation.
  overrides: [{
    files: ["skills/hunch/**/*.md", "README.md"],
    rules: {
      "failures/misleading-success": "off", "correctness/edge-case-regression": "off", "tests/weakened-test": "off",
      "docs/contradictory-comment": "off", "review/honest-coverage": "off", "security/trusted-policy": "off",
      "report/evidence": "off", "skill/*/*": "off", "agents-md/*/*": "off",
    },
  }],
});
