import { defineConfig } from "vitest/config";

// Root config for the Worker + scraper unit/integration suite. Test discovery keeps
// the vitest default (**/*.test.ts); this only configures coverage of `src/`.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html"],
      reportsDirectory: "coverage",
      // Measure the code the Node/Worker suite actually exercises. The web app
      // (typechecked separately) and thin CLI command wrappers are excluded.
      include: ["src/**/*.ts"],
      exclude: [
        "src/cli/**",
        "src/**/*.d.ts",
        "src/**/types.ts",
        "src/worker/env.ts",
      ],
    },
  },
});
