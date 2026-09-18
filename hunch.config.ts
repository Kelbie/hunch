import { defineConfig } from "@kelbie/hunch";

export default defineConfig({
  extends: ["hunch:recommended"],
  include: ["packages/**/src/**/*.ts", "apps/**/{api,lib}/**/*.ts"],
  skills: ["./.agents/skills/codebase-design"],
  agentsMd: true,
  failOnError: false,
  rules: {
    "review/honest-coverage": ["warn", "A missing provider answer or skipped review work must not be represented as evidence that the code passed review."],
    "security/trusted-policy": ["error", "PR content must not control the trusted policy used to judge that same PR."],
    "report/evidence": ["warn", "A report must distinguish a configured rule description from a model-generated explanation or an independently proven defect."],
  },
});
