import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { connectApp, vercelSecrets } from "./app.js";
import { registerApp } from "./register.js";

const HELP = `GitHub App setup (Node 22+, macOS/Linux)

  hunch app register --name NAME --webhook-url https://HOST/api/webhook [--organization ORG]
  hunch app connect --app-id ID --webhook-url https://HOST/api/webhook --vercel-project PROJECT --scope TEAM [--private-key PATH]

Register prints a local browser link for GitHub confirmation and saves credentials
under ~/.config/hunch/apps with private permissions. Run it on your local computer.
Connect uploads production secrets using the authenticated Vercel CLI and updates
the GitHub webhook. It can resume after a partial failure. Existing Apps need a PEM
file on their first connection. Redeploy Vercel afterward, then install the App.
See https://github.com/Kelbie/hunch/blob/main/docs/cli-setup.md`;

export async function runAppCommand(args: string[]) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0]!)) { console.log(HELP); return; }
  const [command, ...rest] = args;
  if (command !== "register" && command !== "connect") throw new Error("Unknown App command. Run hunch app --help.");
  const names = command === "register" ? ["name", "webhook-url", "organization"] : ["app-id", "webhook-url", "vercel-project", "scope", "private-key"];
  const { values } = parseArgs({ args: rest, options: Object.fromEntries(names.map(name => [name, { type: "string" as const }])) });
  const required = (name: string): string => {
    const value = values[name];
    if (typeof value !== "string" || !value) throw new Error(`Missing --${name}. Run hunch app --help.`);
    return value;
  };
  if (command === "register") {
    const app = await registerApp({ name: required("name"), webhook: required("webhook-url"), organization: values.organization as string | undefined,
      onReady: url => console.log(`Open this link on this computer to confirm registration:\n${url}`) });
    console.log(`Registered ${app.slug} (App ID ${app.id}). Credentials saved privately.\nNext: hunch app connect --app-id ${app.id} --webhook-url ${required("webhook-url")} --vercel-project PROJECT --scope TEAM\nInstall: ${app.installationUrl}`);
    return;
  }
  const idText = required("app-id");
  const id = Number(idText);
  if (!/^[0-9]+$/.test(idText) || !Number.isSafeInteger(id) || id <= 0) throw new Error("App ID must be a positive integer.");
  const setSecret = vercelSecrets(required("vercel-project"), required("scope"));
  let privateKey: string | undefined;
  if (values["private-key"]) {
    try { privateKey = readFileSync(String(values["private-key"]), "utf8"); }
    catch { throw new Error("Could not read the App private-key file."); }
  }
  console.log("Connecting App and uploading production credentials; values are never displayed.");
  const app = await connectApp({ id, privateKey, webhook: required("webhook-url"), setSecret });
  console.log(`Connected ${app.slug}. Redeploy Vercel to activate the credentials.\nInstall: ${app.installationUrl}`);
  if (app.missingEvents.length) {
    console.error(`Setup incomplete: enable ${app.missingEvents.join(" and ")} at https://github.com/settings/apps/${app.slug}/permissions`);
    process.exitCode = 2;
  }
}
