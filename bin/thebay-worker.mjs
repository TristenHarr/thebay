#!/usr/bin/env node
/**
 * `thebay-worker` — the volunteer entry point. Goes straight to the `work` command, so a
 * contributor never has to learn the rest of the CLI:
 *
 *   BAY_WORKER_TOKEN=… thebay-worker --url https://thebay.events
 *
 * Registers tsx so the TypeScript CLI imports with no build step, exactly as bin/eventers.mjs
 * does. Note the package is currently `private: true` — this works from a clone (`npm link`, or
 * `node bin/thebay-worker.mjs`); publishing it to npm is a deliberate, separate act.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { register } from 'tsx/esm/api';

const __dirname = dirname(fileURLToPath(import.meta.url));
const unregister = register();
try {
  const { workCommand } = await import(resolve(__dirname, '../src/cli/work.ts'));
  await workCommand(process.argv.slice(2));
} catch (err) {
  console.error(err?.message ?? String(err));
  process.exitCode = 1;
} finally {
  unregister();
}
