// Builds the published CLI into .pkg/: one ESM file with the internal contract package inlined, plus
// README, LICENSE and a package.json holding only what users need. Publish from .pkg/.
import { build } from "esbuild";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const pkg = JSON.parse(readFileSync(here("../package.json"), "utf8"));
rmSync(here("../.pkg"), { recursive: true, force: true });
mkdirSync(here("../.pkg/bin"), { recursive: true });
await build({
  entryPoints: [here("../src/main.ts")],
  outfile: here("../.pkg/bin/coagents.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: Object.keys(pkg.dependencies),
  legalComments: "none",
  logLevel: "warning",
});
chmodSync(here("../.pkg/bin/coagents.js"), 0o755);
for (const f of ["README.md", "LICENSE"]) copyFileSync(here(`../${f}`), here(`../.pkg/${f}`));
const { scripts: _s, devDependencies: _d, private: _p, ...published } = pkg;
writeFileSync(here("../.pkg/package.json"), `${JSON.stringify({ ...published, files: ["bin/coagents.js", "README.md", "LICENSE"] }, null, 2)}\n`);
console.log(`bundled coagents ${pkg.version} -> .pkg/`);
