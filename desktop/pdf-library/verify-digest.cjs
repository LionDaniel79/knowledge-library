// Compare a synthetic Python fixture against the Stage 4 TypeScript implementation.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const Module = require("node:module");
const source = path.resolve(__dirname, "../../src/lib/desktop-catalog-contract.ts");
const js = ts.transpileModule(fs.readFileSync(source, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = new Module(source, module);
mod.paths = module.paths;
mod._compile(js, source);
const fixture = JSON.parse(fs.readFileSync(0, "utf8"));
fixture.rows.forEach(row => mod.exports.desktopItem.parse(row));
if (mod.exports.desktopItemsDigest(fixture.rows) !== fixture.digest) process.exit(1);
console.log("Python and Stage 4 TypeScript digest match");
