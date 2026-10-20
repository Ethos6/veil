// Download the default filter lists and compile them into resources/engine.bin,
// which ships inside the app so Shields work from the very first page, offline.
import path from "node:path";
import { Blocker } from "../src/main/blocker.js";

const out = path.join(import.meta.dirname, "..", "resources", "engine.bin");
const blocker = new Blocker({ log: (m) => console.log(m) });
const info = await blocker.update();
if (!info) {
  console.error("No filter list could be downloaded.");
  process.exit(1);
}
const failed = info.lists.filter((l) => !l.ok);
blocker.save(out);
console.log(`${info.networkFilters} network + ${info.cosmeticFilters} cosmetic filters, scriptlets: ${info.resources} -> ${path.relative(process.cwd(), out)}`);
for (const l of info.lists) console.log(`  ${l.ok ? "ok  " : "FAIL"} ${l.id.padEnd(16)} ${l.ok ? `${l.rules} rules from ${l.source}` : l.error}`);
if (failed.length > 2) {
  console.error(`${failed.length} lists failed; refusing to ship an incomplete engine.`);
  process.exit(1);
}
