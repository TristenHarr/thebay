import { spawnSync } from "node:child_process";
import { buildSiteCommand } from "./build-site";

/** Build the static site + the /app SPA, then deploy to Cloudflare (needs `wrangler login`). */
export async function deployCommand(argv: string[]): Promise<void> {
  await buildSiteCommand(argv);
  // Build the React app (web/) into dist/site/app AFTER build-site (which recreates
  // dist/site). This supersedes the old Preact app/ build.
  console.log("\nBuilding /app (React)…");
  const appBuild = spawnSync("npx", ["vite", "build", "-c", "web/vite.config.ts"], { stdio: "inherit" });
  if (appBuild.status !== 0) process.exit(appBuild.status ?? 1);
  console.log("\nDeploying to Cloudflare…\n");
  const r = spawnSync("npx", ["wrangler", "deploy"], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(
      "\nDeploy failed. If this is an auth error, run:  npx wrangler login",
    );
    process.exit(r.status ?? 1);
  }
}
