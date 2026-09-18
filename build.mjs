#!/usr/bin/env node
// Node will not strip types from files under node_modules, so a published package must
// ship plain JavaScript. Node strips its own types, so this needs no dependencies.
import { stripTypeScriptTypes } from "node:module";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

mkdirSync("lib", { recursive: true });
for (const file of readdirSync("src").filter((f) => f.endsWith(".ts"))) {
  const js = stripTypeScriptTypes(readFileSync(join("src", file), "utf8"), { mode: "strip" });
  writeFileSync(join("lib", file.replace(/\.ts$/, ".js")), js.replaceAll(/(from\s+"\.\/[^"]+)\.ts"/g, '$1.js"'));
}
console.log(`built lib/ from src/`);
