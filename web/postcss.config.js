import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

// Resolve the Tailwind config absolutely so builds work regardless of cwd.
const here = dirname(fileURLToPath(import.meta.url));
export default {
  plugins: [tailwindcss(resolve(here, "tailwind.config.ts")), autoprefixer],
};
