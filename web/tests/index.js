// Node 24 ne développe pas un dossier passé à `node --test` : il exécute `web/tests` comme un module,
// qui se résout vers ce fichier. On y charge chaque *.test.mjs pour que `node --test web/tests/` marche.
const { readdirSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

(async () => {
  for (const f of readdirSync(__dirname).filter((f) => f.endsWith(".test.mjs")).sort()) {
    await import(pathToFileURL(join(__dirname, f)).href);
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
