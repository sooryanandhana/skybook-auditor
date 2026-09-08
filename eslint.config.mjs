import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    /*
     * The mutation harnesses are CommonJS scripts run directly by node, not
     * part of the application. `require` is how a .cjs file imports, so the
     * rule against it is asking these files to be something they are not.
     * Nothing here ships: no route, component or library imports this folder.
     */
    files: ["tools/mutation/**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);

export default eslintConfig;
