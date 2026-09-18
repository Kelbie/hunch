import { VERSION } from "./version.js";

export const TS_TEMPLATE = `import { defineConfig } from "@kelbie/hunch";

export default defineConfig({
  extends: ["hunch:recommended", "hunch:typescript"],
  include: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
  ignore: ["dist/**", "node_modules/**", "**/*.generated.ts"],
});
`;
export const TOML_TEMPLATE = `extends = ["hunch:recommended", "hunch:rust"]
include = ["**/*.rs"]
ignore = ["target/**"]
`;

export const GENERAL_TEMPLATE = `extends = ["hunch:recommended"]
ignore = ["node_modules/**", "dist/**", "target/**", ".git/**"]
`;

export const GITHUB_WORKFLOW = `name: Hunch
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, edited]
permissions:
  contents: read
concurrency:
  group: hunch-\${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  review:
    if: >-
      !github.event.pull_request.draft &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      github.actor != 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - name: Check API key setup
        env:
          AI_GATEWAY_API_KEY: \${{ secrets.AI_GATEWAY_API_KEY }}
        run: |
          if [ -z "$AI_GATEWAY_API_KEY" ]; then
            echo '::error::Add AI_GATEWAY_API_KEY in Settings > Secrets and variables > Actions.'
            exit 1
          fi
      - uses: actions/checkout@v7
        with:
          ref: \${{ github.event.pull_request.base.sha }}
          fetch-depth: 0
          persist-credentials: false
      - uses: Kelbie/hunch@v${VERSION}
        with:
          base: \${{ github.event.pull_request.base.sha }}
          head: \${{ github.event.pull_request.head.sha }}
        env:
          AI_GATEWAY_API_KEY: \${{ secrets.AI_GATEWAY_API_KEY }}
`;
