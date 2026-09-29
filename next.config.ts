import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * A self-contained server bundle for the container image: `next build` emits
   * `.next/standalone/server.js` with only the traced runtime dependencies, so
   * the Docker runner stage copies that rather than the whole project and its
   * dev dependencies.
   */
  output: "standalone",

  /*
   * Puppeteer is kept external rather than bundled. It resolves its own files
   * (and, in the container, a system Chromium via PUPPETEER_EXECUTABLE_PATH) at
   * runtime from node_modules; letting the bundler pull it in breaks that
   * resolution. The dependency trace still copies it into the standalone output.
   */
  serverExternalPackages: ["puppeteer"],

  /*
   * The PDF fonts and logo are read from disk at module load (see fonts.ts /
   * logo.ts) through a path built from `import.meta.url`. The standalone tracer
   * cannot follow a dynamic read like that, so it would leave the .ttf and .jpg
   * files out of the bundle and the renderer would throw the moment a route
   * imported it. These globs copy the assets in explicitly, for the two routes
   * that produce a PDF: the download and the emailed report.
   */
  outputFileTracingIncludes: {
    "/api/audit/pdf": ["./lib/audit/pdf/assets/**"],
    "/api/report/send": ["./lib/audit/pdf/assets/**"],
  },
};

export default nextConfig;
