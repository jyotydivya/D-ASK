// D-ASK memory controls (the user's, not the agent's). Local only.
//   npx tsx agent/runtime/memory/memoryCli.ts list [n]
//   npx tsx agent/runtime/memory/memoryCli.ts search <words>
//   npx tsx agent/runtime/memory/memoryCli.ts export <file.json>
//   npx tsx agent/runtime/memory/memoryCli.ts forget <id>
//   npx tsx agent/runtime/memory/memoryCli.ts clear --yes
import fs from "node:fs";
import { MemoryStore } from "./memoryStore";

const [cmd, arg] = process.argv.slice(2);
const store = new MemoryStore();
try {
  if (cmd === "list") for (const e of store.list({ limit: Number(arg) || 50 })) console.log(`${e.id}  [${e.kind}${e.pinned ? ", pinned" : ""}]  ${e.content}`);
  else if (cmd === "search") for (const h of store.recall(arg ?? "", { limit: 20, touch: false })) console.log(`${h.score.toFixed(3)}  ${h.id}  ${h.content}`);
  else if (cmd === "export" && arg) { fs.writeFileSync(arg, JSON.stringify(store.exportAll(), null, 2)); console.log(`Exported ${store.count()} memories to ${arg}`); }
  else if (cmd === "forget" && arg) console.log(store.forget(arg) ? "Deleted." : "No such memory.");
  else if (cmd === "clear") {
    if (arg !== "--yes") { console.log(`This erases all ${store.count()} saved memories. Run again with --yes to confirm.`); process.exitCode = 2; }
    else console.log(`Erased ${store.forgetAll()} memories.`);
  } else { console.log(`Memory file: ${store.file} (${store.count()} memories)\nUsage: list [n] | search <words> | export <file> | forget <id> | clear --yes`); }
} finally { store.close(); }
