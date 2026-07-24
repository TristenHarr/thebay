import type { Config } from "tailwindcss";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Tokens live as CSS variables (see src/index.css) so light/dark + theming are
// runtime-swappable; Tailwind reads them here. Refined-professional, CS-nerd flavor.
export default {
  content: [resolve(here, "index.html"), resolve(here, "src/**/*.{ts,tsx}")],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        elev: "var(--elev)",
        border: "var(--border)",
        text: "var(--text)",
        muted: "var(--muted)",
        accent: "var(--accent)",
        "accent-ink": "var(--accent-ink)",
        ok: "var(--ok)",
        warn: "var(--warn)",
        crit: "var(--crit)",
        gold: "var(--gold)",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SF Mono", "Menlo", "monospace"],
      },
      borderRadius: { DEFAULT: "10px", lg: "14px", xl: "18px" },
      boxShadow: { soft: "0 1px 2px rgba(0,0,0,.35), 0 8px 24px -12px rgba(0,0,0,.5)" },
    },
  },
  plugins: [],
} satisfies Config;
