#!/usr/bin/env node
// Thin launcher so `eventers <cmd>` works. Registers tsx so the TypeScript
// CLI can be imported directly with no build step.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { register } from 'tsx/esm/api';

const __dirname = dirname(fileURLToPath(import.meta.url));
const unregister = register();
try {
  await import(resolve(__dirname, '../src/cli/index.ts'));
} finally {
  unregister();
}
