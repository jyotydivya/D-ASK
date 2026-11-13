// Independent, READ-ONLY view of a knowledge.db for acceptance runs (does not use the product's KnowledgeStore code).
//   node scripts/hud/knowledge-db-check.mjs <knowledge.db>   -> JSON on stdout
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const Database = createRequire(path.join(root, "package.json"))("better-sqlite3");
const file = process.argv[2];
if (!file || !fs.existsSync(file)) { process.stdout.write(JSON.stringify({ exists: false })); process.exit(0); }
const db = new Database(file, { readonly: true, fileMustExist: true });
const collections = db.prepare("SELECT name, kind, roots FROM collections ORDER BY name").all().map((c) => ({
  ...c,
  documents: db.prepare("SELECT path, status, chunk_count AS chunks FROM documents WHERE collection=? ORDER BY path").all(c.name).map((d) => ({ ...d, file: path.basename(d.path) })),
  chunks: db.prepare("SELECT COUNT(*) n FROM chunks WHERE collection=?").get(c.name).n,
  embedded: db.prepare("SELECT COUNT(*) n FROM chunks WHERE collection=? AND embedding IS NOT NULL").get(c.name).n,
}));
const runs = db.prepare("SELECT collection, status, seen, indexed, unchanged, failed, removed FROM index_runs ORDER BY id").all();
const model = db.prepare("SELECT v FROM meta WHERE k='embed_model'").get()?.v ?? null;
process.stdout.write(JSON.stringify({ exists: true, model, collections, runs }));
db.close();
