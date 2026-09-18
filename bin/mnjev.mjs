#!/usr/bin/env node
// Node runs TypeScript directly from v22.18, so there is no build step. Older
// versions fail on the import with a confusing parser error, so check first.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(
    `mnjev needs Node 22.18 or newer, and this is ${process.versions.node}.\n` +
    `Upgrade at https://nodejs.org, or with: nvm install --lts`,
  );
  process.exit(1);
}
// lib/ is the published build; src/ is used when running from a checkout. Only a
// genuinely absent lib/ falls back, so a real failure inside it is not reported as a
// missing src/cli.ts, a file the published package does not even contain.
const entry = await import("../lib/cli.js").catch((err) => {
  if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
  return import("../src/cli.ts");
});
await entry.run();
