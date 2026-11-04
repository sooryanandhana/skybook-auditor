/**
 * The dashboard never reads a crawl count or a finding's scope figures
 * directly. It takes them through the shared views, which hide them when the
 * crawl's counts do not add up.
 *
 * WHY A TYPE-CHECKED TEST, NOT A TEXT SEARCH. A property is forbidden because
 * of WHERE IT IS DECLARED -- on the crawl summary, on robots.txt's report, or
 * on a finding -- not because of its name. So `progress.evaluated`, a live
 * progress count declared on its own type, is allowed, while
 * `const { evaluated } = siteResult.crawl` is caught however it is written.
 * Comments, strings and look-alike names are never matched, because the test
 * reads the program the way the compiler does.
 *
 * WHAT IT CANNOT SEE: a value deliberately cast to `any` or `unknown` and then
 * read, or reflection such as `Object.values(crawl)`. Strict mode stops the
 * first from happening by accident; code review covers both on purpose.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const APP = path.join(ROOT, "app");

/** Where each forbidden property is declared: file, interface, property names. */
const FORBIDDEN: ReadonlyArray<{ file: string; owner: string; names: readonly string[] }> = [
  {
    file: "lib/collector/crawlFrontier.ts",
    owner: "CrawlSummary",
    names: ["discovered", "queuedAtStop", "evaluated", "unavailable", "skippedNonHtml", "sources"],
  },
  // The two fields of the inline `sources` type inside CrawlSummary.
  { file: "lib/collector/crawlFrontier.ts", owner: "CrawlSummary.sources", names: ["html", "sitemap"] },
  { file: "lib/collector/crawlSite.ts", owner: "RobotsReport", names: ["excluded"] },
  { file: "lib/types.ts", owner: "Finding", names: ["evaluatedPages", "affectedCount"] },
];

/** The one shared view the dashboard may no longer call directly. */
const RAW_AFFECTED_VIEW = { file: "lib/report/siteFindingsView.ts", name: "affectedView" };

const normalise = (file: string) => path.resolve(file).toLowerCase();
const inRepo = (relative: string) => normalise(path.join(ROOT, relative));

/** The interface a property signature belongs to, as "Name" or "Name.prop" for an inline type. */
function ownerOf(declaration: ts.Node): string | null {
  const parent = declaration.parent;
  if (parent && ts.isInterfaceDeclaration(parent)) return parent.name.text;
  if (parent && ts.isTypeLiteralNode(parent) && parent.parent && ts.isPropertySignature(parent.parent)) {
    const outer = ownerOf(parent.parent);
    return outer === null ? null : `${outer}.${parent.parent.name.getText()}`;
  }
  return null;
}

function isForbiddenDeclaration(declaration: ts.Declaration): boolean {
  if (!ts.isPropertySignature(declaration)) return false;
  const owner = ownerOf(declaration);
  const file = normalise(declaration.getSourceFile().fileName);
  const name = declaration.name.getText();
  return FORBIDDEN.some((rule) => rule.owner === owner && inRepo(rule.file) === file && rule.names.includes(name));
}

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly text: string;
}

/**
 * Every forbidden access in the given files. `extra` adds in-memory files,
 * placed in `app/` so they resolve imports exactly as the dashboard does.
 */
function violationsIn(files: readonly string[], extra: Readonly<Record<string, string>> = {}): Violation[] {
  const configPath = path.join(ROOT, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, incremental: false };

  const virtual = new Map(Object.entries(extra).map(([name, source]) => [normalise(path.join(APP, name)), source]));
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  const getSource = host.getSourceFile.bind(host);
  host.readFile = (file) => virtual.get(normalise(file)) ?? read(file);
  host.fileExists = (file) => virtual.has(normalise(file)) || exists(file);
  host.getSourceFile = (file, language, onError, create) => {
    const source = virtual.get(normalise(file));
    return source !== undefined
      ? ts.createSourceFile(file, source, language, true, ts.ScriptKind.TSX)
      : getSource(file, language, onError, create);
  };

  const roots = [...files, ...Object.keys(extra).map((name) => path.join(APP, name))];
  const program = ts.createProgram(roots, options, host);
  const checker = program.getTypeChecker();

  const forbiddenSymbol = (symbol: ts.Symbol | undefined): boolean =>
    symbol !== undefined &&
    checker.getRootSymbols(symbol).some((root) => (root.declarations ?? []).some(isForbiddenDeclaration));

  const forbiddenProperty = (type: ts.Type, name: string): boolean =>
    forbiddenSymbol(checker.getPropertyOfType(checker.getApparentType(type), name));

  /** A crawl summary, robots report or finding -- or a union containing one. */
  const carriesForbidden = (type: ts.Type): boolean => {
    const parts = type.isUnion() ? type.types : [type];
    return parts.some((part) => checker.getApparentType(part).getProperties().some((p) => forbiddenSymbol(p)));
  };

  const isRawAffectedView = (symbol: ts.Symbol | undefined): boolean => {
    if (symbol === undefined) return false;
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    return (target.declarations ?? []).some(
      (declaration) =>
        ts.isFunctionDeclaration(declaration) &&
        declaration.name?.text === RAW_AFFECTED_VIEW.name &&
        normalise(declaration.getSourceFile().fileName) === inRepo(RAW_AFFECTED_VIEW.file),
    );
  };

  const out: Violation[] = [];
  for (const root of roots) {
    const source = program.getSourceFile(root);
    if (source === undefined) throw new Error(`not in the program: ${root}`);
    const report = (node: ts.Node, kind: string) =>
      out.push({
        file: path.relative(ROOT, source.fileName),
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        kind,
        text: node.getText().slice(0, 80),
      });

    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && forbiddenSymbol(checker.getSymbolAtLocation(node.name))) {
        report(node, node.questionDotToken ? "optional property access" : "property access");
      } else if (ts.isElementAccessExpression(node)) {
        const key = node.argumentExpression;
        const objectType = checker.getTypeAtLocation(node.expression);
        if (ts.isStringLiteralLike(key)) {
          if (forbiddenProperty(objectType, key.text)) report(node, "element access");
        } else if (carriesForbidden(objectType)) {
          report(node, "computed access");
        }
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const patternType = checker.getTypeAtLocation(node.parent);
        if (node.dotDotDotToken) {
          if (carriesForbidden(patternType)) report(node, "rest");
        } else {
          const key = node.propertyName ?? node.name;
          if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && forbiddenProperty(patternType, key.text)) {
            report(node, "destructuring");
          }
        }
      } else if (
        (ts.isSpreadAssignment(node) || ts.isSpreadElement(node) || ts.isJsxSpreadAttribute(node)) &&
        carriesForbidden(checker.getTypeAtLocation(node.expression))
      ) {
        report(node, "spread");
      } else if (ts.isIdentifier(node) && isRawAffectedView(checker.getSymbolAtLocation(node))) {
        report(node, "affectedView reference");
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

/** The dashboard's own components: every .tsx under app/, not the server routes. */
function dashboardFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (full !== path.join(APP, "api")) walk(full);
      } else if (entry.name.endsWith(".tsx")) {
        found.push(full);
      }
    }
  };
  walk(APP);
  return found;
}

const IMPORTS = [
  'import type { SiteCrawlSummary } from "@/lib/collector/crawlSite";',
  'import type { Finding, JobProgressView, SiteAuditResult } from "@/lib/types";',
].join("\n");

/** One snippet per access pattern the guard must catch. */
const CAUGHT: Readonly<Record<string, { source: string; kind: string }>> = {
  property: { source: "export const f = (r: SiteAuditResult) => r.crawl.evaluated;", kind: "property access" },
  optional: { source: "export const f = (r: SiteAuditResult | null) => r?.crawl?.discovered;", kind: "optional property access" },
  element: { source: 'export const f = (c: SiteCrawlSummary) => c["evaluated"];', kind: "element access" },
  computed: { source: "export const f = (c: SiteCrawlSummary, k: keyof SiteCrawlSummary) => c[k];", kind: "computed access" },
  destructuring: { source: "export function f(c: SiteCrawlSummary) { const { evaluated } = c; return evaluated; }", kind: "destructuring" },
  nested: {
    source: "export function f(r: SiteAuditResult) { const { crawl: { evaluated: n } } = r; return n; }",
    kind: "destructuring",
  },
  parameter: { source: "export function f({ discovered }: SiteCrawlSummary) { return discovered; }", kind: "destructuring" },
  alias: { source: "export function f(r: SiteAuditResult) { const c = r.crawl; return c.skippedNonHtml; }", kind: "property access" },
  sources: { source: "export const f = (c: SiteCrawlSummary) => c.sources.html;", kind: "property access" },
  robots: { source: "export const f = (c: SiteCrawlSummary) => c.robots.excluded;", kind: "property access" },
  rest: { source: "export function f(c: SiteCrawlSummary) { const { limits, ...rest } = c; return [limits, rest]; }", kind: "rest" },
  spread: { source: "export const f = (c: SiteCrawlSummary) => ({ ...c });", kind: "spread" },
  jsxSpread: { source: "export const F = (p: { finding: Finding }) => <div {...p.finding} />;", kind: "spread" },
  findingFigures: { source: "export const f = (x: Finding) => [x.evaluatedPages, x.affectedCount];", kind: "property access" },
  affectedView: {
    source: 'import { affectedView } from "@/lib/report/siteFindingsView";\nexport const f = (x: Finding) => affectedView(x).reach;',
    kind: "affectedView reference",
  },
  renamedImport: {
    source: 'import { affectedView as av } from "@/lib/report/siteFindingsView";\nexport const f = (x: Finding) => av(x);',
    kind: "affectedView reference",
  },
  asValue: {
    source: 'import { affectedView } from "@/lib/report/siteFindingsView";\nexport const f = (xs: Finding[]) => xs.map(affectedView);',
    kind: "affectedView reference",
  },
};

/** Snippets that look alike but are allowed. */
const ALLOWED: Readonly<Record<string, string>> = {
  commentsAndStrings: [
    "// crawl.evaluated, finding.affectedCount and affectedView(finding) in a comment",
    'export const s = "siteResult.crawl.evaluated evaluatedPages affectedView(f)";',
  ].join("\n"),
  unrelatedType: "interface Other { evaluated: number; discovered: number }\nexport const f = (o: Other) => o.evaluated + o.discovered;",
  liveProgress: "export const f = (p: JobProgressView) => `${p.evaluated} of ${p.discovered} · ${p.unavailable} · ${p.robotsExcluded}`;",
  sharedViews: [
    'import { affectedViewFor, coverageCheck, crawlView } from "@/lib/report/siteFindingsView";',
    "export const f = (r: SiteAuditResult, x: Finding) => [crawlView(r.crawl), affectedViewFor(x, coverageCheck(r.crawl))];",
  ].join("\n"),
  limits: "export const f = (r: SiteAuditResult) => r.crawl.limits.maxPages;",
};

const snippetName = (key: string) => `__dashboardBoundary_${key}.tsx`;

const snippetViolations = violationsIn(
  [],
  Object.fromEntries([
    ...Object.entries(CAUGHT).map(([key, { source }]) => [snippetName(key), `${IMPORTS}\n${source}\n`]),
    ...Object.entries(ALLOWED).map(([key, source]) => [snippetName(key), `${IMPORTS}\n${source}\n`]),
  ]),
);
const inSnippet = (key: string) =>
  snippetViolations.filter((violation) => path.basename(violation.file) === snippetName(key));

for (const [key, { kind }] of Object.entries(CAUGHT)) {
  test(`the guard catches ${key} access (${kind})`, () => {
    const found = inSnippet(key);
    assert.ok(found.some((violation) => violation.kind === kind), `expected a ${kind}, got ${JSON.stringify(found)}`);
  });
}

for (const key of Object.keys(ALLOWED)) {
  test(`the guard allows ${key}`, () => {
    assert.deepEqual(inSnippet(key), []);
  });
}

test("the dashboard reads no crawl count and no finding figure directly", () => {
  const files = dashboardFiles();
  assert.ok(files.some((file) => file.endsWith("AuditPage.tsx")), "the dashboard page is checked");
  assert.deepEqual(violationsIn(files), []);
});
