/**
 * Local knowledge (RAG) + Research Mode. Run with: npx tsx tests/agent-runtime/knowledge.test.ts
 *   G. request grammar (what is claimed, what is left to the planner)
 *   X. ingestion: PDF (built here), DOCX (built here), Markdown, code, redaction, unreadable files
 *   C. chunking   S. store + incremental indexer   R. hybrid retrieval   V. citation validation
 *   E. end to end through KnowledgeService (scripted model, deterministic test embedder)
 * The test embedder is a hashed bag-of-words: it exercises the vector path deterministically; it is NOT the product embedder.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { chunkDocument } from "../../agent/runtime/knowledge/chunk";
import { normalize, type Embedder } from "../../agent/runtime/knowledge/embedder";
import { headingOf, parseDocument, UnreadableError } from "../../agent/runtime/knowledge/extract";
import { extractive, validate } from "../../agent/runtime/knowledge/ground";
import { indexCollection, resolveIndexFolder } from "../../agent/runtime/knowledge/indexer";
import { listProjects } from "../../agent/runtime/knowledge/research";
import { retrieve, type Passage } from "../../agent/runtime/knowledge/retrieve";
import { KnowledgeService, parseKnowledgeRequest, topicOf } from "../../agent/runtime/knowledge/service";
import { KnowledgeStore } from "../../agent/runtime/knowledge/store";
import { resolveRoots } from "../../agent/runtime/tools/fileAccess";
import type { LanguageModel, RuntimeEvent, StructuredRequest } from "../../agent/runtime/types";
import { REQ, parseCollections, parseResearch } from "../../lib/manage";

let passed = 0, failed = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); } else { failed++; console.log(`  FAIL: ${name}${detail !== undefined ? ` | ${JSON.stringify(detail)?.slice(0, 700)}` : ""}`); }
}

class TestEmbedder implements Embedder {
  readonly modelId: string; readonly dim = 384; calls = 0; fail = false;
  constructor(id = "test-bow") { this.modelId = id; }
  async embed(texts: string[], _k: "document" | "query", signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("Cancelled");
    if (this.fail) throw new Error("embedder down");
    this.calls++;
    return texts.map((t) => {
      const v = new Float32Array(this.dim);
      for (const w of t.toLowerCase().match(/[a-z]{3,}/g) ?? []) { let h = 0; for (const c of w.slice(0, 6)) h = (h * 31 + c.charCodeAt(0)) >>> 0; v[h % this.dim]! += 1; }
      return normalize(v);
    });
  }
  status() { return { state: "ready" as const, lastError: null, pid: null }; }
  async stop() {}
}

class Scripted implements LanguageModel {
  readonly name = "scripted"; calls: StructuredRequest[] = [];
  constructor(private readonly reply: (req: StructuredRequest) => unknown) {}
  async generateJson(req: StructuredRequest) { this.calls.push(req); const r = this.reply(req); if (r instanceof Error) throw r; return r; }
}

// ── Builders for real binary formats ──
function buildPdf(pages: string[]): Buffer {
  const objs: string[] = [];
  const bin: (Buffer | null)[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} /Resources << /Font << /F1 99 0 R >> >> >>`;
  pages.forEach((content, i) => {
    const z = zlib.deflateSync(Buffer.from(content, "latin1"));
    objs[3 + i * 2] = "<< /Type /Page /Parent 2 0 R /Contents " + (4 + i * 2) + " 0 R >>";
    objs[4 + i * 2] = `<< /Length ${z.length} /Filter /FlateDecode >>`;
    bin[4 + i * 2] = z;
  });
  objs[99] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Differences [ 2 /fi ] >> >>";
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  for (let n = 1; n < objs.length; n++) {
    if (!objs[n]) continue;
    parts.push(Buffer.from(`${n} 0 obj\n${objs[n]}\n`, "latin1"));
    if (bin[n]) parts.push(Buffer.from("stream\n"), bin[n]!, Buffer.from("\nendstream\n"));
    parts.push(Buffer.from("endobj\n"));
  }
  parts.push(Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF\n"));
  return Buffer.concat(parts);
}
function buildZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = zlib.deflateRawSync(Buffer.from(text, "utf8")); const nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(Buffer.byteLength(text), 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(Buffer.byteLength(text), 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nm, data); central.push(ch, nm); offset += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central); const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(central.length / 2, 8); eocd.writeUInt16LE(central.length / 2, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const para = (style: string | null, text: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dask-knowledge-"));

  console.log("\n[G] Request grammar");
  const p = parseKnowledgeRequest;
  const ix = p("index D:\\My Papers as research");
  check(ix?.op === "index" && ix.folder === "D:\\My Papers" && ix.collection === "research" && ix.kind === "research", "index a folder with spaces into a named collection", ix);
  check(p('index "C:\\Users\\me\\Documents\\Notes"')?.op === "index", "index a quoted folder");
  check(p("index the codebase")?.op === "index" && (p("index the codebase") as { kind: string }).kind === "code", "index the codebase");
  check(p("list my knowledge collections")?.op === "list" && p("knowledge status")?.op === "list", "list / status");
  check(p("remove the collection research")?.op === "drop" && p("delete the research collection")?.op === "drop", "drop a collection (both phrasings)");
  check(p("remove D:\\Papers\\old.pdf from my knowledge")?.op === "remove-path", "remove a file from the index");
  check(p("refresh research", ["research"])?.op === "reindex" && p("refresh research") === null && (p("reindex everything") as { collection: string })?.collection === "*", "re-index");
  const s1 = p("search my papers for graph attention");
  check(s1?.op === "search" && s1.query === "graph attention" && s1.scope.kind === "type", "search my papers for X", s1);
  check(p("find inductive learning in my documents")?.op === "search", "find X in my documents");
  check(p("find report.pdf in my documents") === null, "a file name is left to the file tools");
  const a1 = p("According to my documents, what is the release date?");
  check(a1?.op === "ask" && a1.question.startsWith("what is the release"), "according to my documents, Q", a1);
  const a2 = p("How does GraphSAGE aggregate neighbours according to my research papers?");
  check(a2?.op === "ask" && a2.scope.kind === "type" && (a2.scope as { type: string }).type === "research", "Q according to my research papers", a2);
  check(p("ask the collection notes: when is the deadline")?.op === "ask", "ask the collection X");
  const acode = p("How does the approval registry work in this codebase?");
  check(acode?.op === "ask" && acode.scope.kind === "type", "codebase question", acode);
  const r1 = p("Find the latest research papers in my research folder about graph neural networks, compare their methodologies, identify the research gaps, and prepare a literature review.");
  check(r1?.op === "research" && r1.type === "literature-review" && r1.latest && r1.topic === "graph neural networks" && r1.scope.kind === "type", "the directive's literature-review example", r1);
  check(p("research federated learning privacy")?.op === "research", "research <topic>");
  check(topicOf("write a gap analysis on retrieval augmented generation") === "retrieval augmented generation" && topicOf("Prepare a literature review about graph neural networks from my research papers") === "graph neural networks", "topic extraction drops the source phrase");
  check(p("list research projects")?.op === "research-list" && p("resume research on graph neural networks")?.op === "research-resume", "list / resume research");
  for (const no of ["Open Notepad and type HELLO", "find all PDFs in my documents", "What is 7 times 8?", "remember that my sister is Asha", "search my documents for budget and email it to Bob", "update the nightly workflow", "What is the capital of France?", "list my workflows", "summarize notes.txt",
    'Create a note titled Review containing "Literature review on graph neural networks: 3 sources. Research report saved."', "Remember that the literature review on GNNs found 3 sources"])
    check(p(no) === null, `not claimed: "${no}"`, p(no));

  console.log("\n[X] Ingestion");
  const pdf = buildPdf([
    "BT /F1 12 Tf 72 720 Td (Graph Attention Study) Tj 0 -20 Td (1 Introduction) Tj 0 -14 Td (Graph attention networks use masked self-attention over neighbourhoods.) Tj 0 -14 Td [(We ) -250 (propose a model that is ef\\002cient.)] TJ ET",
    "BT /F1 12 Tf 72 720 Td (2 Method) Tj 0 -14 Td (Each node attends over its neighbours with learned coefficients.) Tj ET 2",
  ]);
  const dp = parseDocument("study.pdf", pdf);
  check(dp.format === "pdf" && dp.pages === 2, "PDF: two pages from an inherited-resources page tree", dp.pages);
  check(dp.title === "Graph Attention Study", "PDF: title from the first line", dp.title);
  check(dp.blocks.some((b) => b.heading === "1 Introduction" && b.page === 1 && /masked self-attention/.test(b.text)), "PDF: heading + page kept", dp.blocks);
  check(dp.blocks.some((b) => b.heading === "2 Method" && b.page === 2), "PDF: page 2 section");
  check(dp.blocks.some((b) => /We propose a model that is efficient\./.test(b.text)), "PDF: TJ spacing and /Differences ligature decoded", dp.blocks.map((b) => b.text));
  check(headingOf("3.2 S TATE - OF - THE - ART METHODS") === "3.2 STATE-OF-THE-ART METHODS" && headingOf("2 N ( v ) g ) ; (3)") === null, "small-caps headings joined; maths lines are not headings");
  const docx = buildZip({
    "word/document.xml": `<w:document><w:body>${para("Title", "Project Atlas")}${para("Heading1", "Budget")}${para(null, "The budget is &amp; remains 40,000 euros.")}${para("Heading2", "Risks")}${para(null, "Supplier delays are the main risk.")}</w:body></w:document>`,
    "docProps/core.xml": "<cp:coreProperties></cp:coreProperties>",
  });
  const dd = parseDocument("atlas.docx", docx);
  check(dd.title === "Project Atlas" && dd.blocks.some((b) => b.heading === "Budget > Risks" && /Supplier/.test(b.text)) && dd.blocks.some((b) => /budget is & remains/.test(b.text)), "DOCX: title, heading path, entities", dd);
  const md = parseDocument("n.md", Buffer.from("# Guide\n\nIntro text.\n\n## Install\n\nRun the installer.\n\n```\n# not a heading\n```\n"));
  check(md.blocks.some((b) => b.heading === "Guide > Install" && b.lineStart === 7) && !md.blocks.some((b) => b.heading.includes("not a heading")), "Markdown: heading path, line numbers, fenced code ignored", md.blocks);
  const code = parseDocument("x.ts", Buffer.from("import a from 'a';\n\n/** Adds. */\nexport function add(a: number, b: number) {\n  return a + b;\n}\n\nexport class Store {\n  get() { return 1; }\n}\n"));
  check(code.blocks.some((b) => b.symbol === "add" && b.lineStart === 3 && b.lineEnd === 6) && code.blocks.some((b) => b.symbol === "Store"), "Code: one block per declaration with its doc comment and line range", code.blocks);
  const red = parseDocument("s.txt", Buffer.from("Config\n\napi_key = sk-abcdefghijklmnopqrstuvwxyz123456\n"));
  check(red.redactions > 0 && !red.blocks.some((b) => b.text.includes("sk-abcdefghijklmnop")), "credentials are redacted before indexing");
  let threw = false; try { parseDocument("bad.pdf", Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n")); } catch (e) { threw = e instanceof UnreadableError; }
  check(threw, "a PDF without text is reported unreadable, not guessed");
  threw = false; try { parseDocument("bad.docx", Buffer.from("not a zip")); } catch (e) { threw = e instanceof UnreadableError; }
  check(threw, "a corrupt .docx is reported unreadable");

  console.log("\n[C] Chunking");
  const long = { title: "T", format: "markdown" as const, pages: null, redactions: 0, blocks: [
    ...Array.from({ length: 8 }, (_, i) => ({ text: `Sentence ${i} about alpha systems is here. `.repeat(6), heading: "A", page: null, lineStart: i + 1, lineEnd: i + 1, symbol: null })),
    { text: "Beta section text only.", heading: "B", page: null, lineStart: 20, lineEnd: 20, symbol: null },
  ] };
  const ch = chunkDocument("doc1", long);
  check(ch.every((c) => c.text.length <= 1300 + 200), "chunks bounded by max size (+ overlap)", ch.map((c) => c.text.length));
  check(ch.filter((c) => c.heading === "B").length === 1 && !ch.find((c) => c.heading === "B")!.text.includes("alpha"), "no chunk crosses a heading; no overlap across sections");
  check(ch.filter((c) => c.heading === "A").slice(1).every((c) => /alpha systems is here\.\n\n/.test(c.text)), "consecutive chunks of a section overlap");
  check(JSON.stringify(chunkDocument("doc1", long).map((c) => c.id)) === JSON.stringify(ch.map((c) => c.id)), "chunk ids are stable");

  console.log("\n[S] Store + incremental indexer");
  const lib = path.join(tmp, "library");
  fs.mkdirSync(path.join(lib, "papers"), { recursive: true });
  fs.mkdirSync(path.join(lib, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(lib, "papers", "gat.pdf"), pdf);
  fs.writeFileSync(path.join(lib, "atlas.docx"), docx);
  fs.writeFileSync(path.join(lib, "notes.md"), "# Notes\n\nThe D-ASK release is planned for Friday 20 November.\n\n## Deadline\n\nThe thesis deadline is 16 November 2026.\n");
  fs.writeFileSync(path.join(lib, "secrets.txt"), "password: hunter2");
  fs.writeFileSync(path.join(lib, "node_modules", "x", "readme.md"), "# dependency\n\nignore me");
  fs.writeFileSync(path.join(lib, "broken.pdf"), "%PDF-1.4 nothing");
  fs.writeFileSync(path.join(lib, "photo.png"), Buffer.alloc(100));
  const dbFile = path.join(tmp, "knowledge.db");
  let store = new KnowledgeStore(dbFile);
  const emb = new TestEmbedder();
  const roots = (await resolveRoots(tmp, [])).roots;
  const folder = await resolveIndexFolder(roots, lib);
  check(folder.ok, "folder inside an allowed root resolves", folder);
  const outside = await resolveIndexFolder(roots, os.homedir());
  check(!outside.ok && /outside the folders/.test((outside as { reason: string }).reason), "a folder outside the allowed roots is refused", outside);
  check(!(await resolveIndexFolder(roots, "relative\\path")).ok, "a relative path is refused");
  store.upsertCollection("lib", "personal", [lib]);
  let r = await indexCollection({ store, embedder: emb }, "lib", "personal", [lib], new AbortController().signal);
  check(r.status === "completed" && r.indexed === 3 && r.failed === 1 && r.seen === 4, "first run: 3 indexed, broken.pdf unreadable; secret, dependency and image files never read", r);
  check(store.documents("lib").every((d) => !/secrets|node_modules|photo/.test(d.path)), "skipped files are not in the index");
  check(store.documents("lib").find((d) => d.path.endsWith("broken.pdf"))?.status === "unreadable", "unreadable file recorded with its reason");
  check(store.collection("lib")!.embedded === store.collection("lib")!.chunks && store.collection("lib")!.chunks > 0, "every passage has a vector");
  const callsBefore = emb.calls;
  r = await indexCollection({ store, embedder: emb }, "lib", "personal", [lib], new AbortController().signal);
  check(r.indexed === 0 && r.unchanged === 4 && emb.calls === callsBefore, "second run: nothing re-processed", r);
  fs.writeFileSync(path.join(lib, "notes.md"), "# Notes\n\nThe D-ASK release moved to Monday 23 November.\n");
  fs.rmSync(path.join(lib, "atlas.docx"));
  r = await indexCollection({ store, embedder: emb }, "lib", "personal", [lib], new AbortController().signal);
  check(r.indexed === 1 && r.removed === 1, "changed file re-indexed, deleted file removed", r);
  const notesChunks = store.db.prepare("SELECT text FROM chunks c JOIN documents d ON d.id=c.doc_id WHERE d.path LIKE '%notes.md'").all() as { text: string }[];
  check(notesChunks.length >= 1 && notesChunks.every((c) => !/Friday/.test(c.text)), "old passages of a changed file are gone (FTS too)", notesChunks);
  check((store.db.prepare("SELECT COUNT(*) n FROM chunks_fts WHERE chunks_fts MATCH 'Friday'").get() as { n: number }).n === 0, "keyword index has no stale rows");
  // Cancellation: aborted before the first file -> cancelled, nothing changed.
  const ac = new AbortController(); ac.abort();
  r = await indexCollection({ store, embedder: emb }, "lib", "personal", [lib], ac.signal);
  check(r.status === "cancelled" && r.removed === 0, "a cancelled run removes nothing", r);
  // Embedding failure mid-run: the run continues keyword-only and says so; the next run with a working embedder fills the vectors.
  fs.writeFileSync(path.join(lib, "extra.txt"), "Extra knowledge about message passing.\n");
  emb.fail = true;
  r = await indexCollection({ store, embedder: emb }, "lib", "personal", [lib], new AbortController().signal);
  check(r.keywordOnly === 1 && /keyword only/.test(r.embeddingNote ?? ""), "embedder failure: keyword-only, reported", r);
  emb.fail = false;
  r = await indexCollection({ store, embedder: emb }, "lib", "personal", [lib], new AbortController().signal);
  check(r.indexed === 1 && store.documents("lib").every((d) => d.status !== "keyword-only"), "next run adds the missing vectors", r);
  // Interrupted run recovery + model change.
  store.db.prepare("INSERT INTO index_runs(collection, started_at, status) VALUES ('lib', 'x', 'running')").run();
  store.close();
  store = new KnowledgeStore(dbFile);
  check(store.interruptedRuns === 1 && store.lastRun("lib")?.status === "interrupted", "a run left running by a crash is marked interrupted on restart");
  check(store.collection("lib")!.documents === 4 && store.collection("lib")!.unreadable === 1, "index persists across restart");
  store.bindEmbeddingModel("another-model");
  check(store.collection("lib")!.embedded === 0, "a different embedding model drops old vectors (never compared across models)");
  store.bindEmbeddingModel(emb.modelId);
  await indexCollection({ store, embedder: emb }, "lib", "personal", [lib], new AbortController().signal);
  check(store.collection("lib")!.embedded === store.collection("lib")!.chunks, "re-index restores vectors");

  console.log("\n[R] Retrieval");
  store.upsertCollection("other", "folder", [tmp]);
  const hit = await retrieve(store, emb, "masked self-attention neighbourhoods", ["lib"], {});
  check(hit.mode === "hybrid" && hit.passages[0]?.doc.path.endsWith("gat.pdf") && hit.passages[0]?.chunk.page === 1, "hybrid retrieval finds the PDF passage with its page", hit.passages.map((x) => [x.doc.path, x.chunk.page]));
  check((await retrieve(store, emb, "masked self-attention", ["other"], {})).passages.length === 0, "collection filter holds");
  const kwOnly = await retrieve(store, null, "release Monday", ["lib"], {});
  check(kwOnly.mode === "keyword" && /keyword search only/.test(kwOnly.note ?? "") && kwOnly.passages[0]?.doc.path.endsWith("notes.md"), "no embedder: keyword-only, stated", kwOnly);
  const cap = await retrieve(store, emb, "graph attention neighbours node", ["lib"], { perDocument: 1, k: 10 });
  check(new Set(cap.passages.map((x) => x.doc.id)).size === cap.passages.length, "per-document cap");

  console.log("\n[V] Citation validation");
  const ps = hit.passages.slice(0, 2);
  const v1 = validate("Graph attention networks use masked self-attention over neighbourhoods [1]. They were invented in 1850 by a committee [7].", false, ps);
  check(v1.cited.join() === "1" && !/\[7\]/.test(v1.text) && /model inference/.test(v1.text), "a fabricated citation number is removed and its sentence marked", v1);
  const v2 = validate("Bananas are a source of potassium for athletes [1].", false, ps);
  check(v2.status === "insufficient" && /not found in the retrieved passages/.test(v2.text), "a cited sentence the passage does not support is not presented as sourced", v2);
  check(validate("The passages do not say.", true, ps).status === "insufficient", "model-reported insufficiency is kept");
  const ex = extractive("masked self-attention", ps, "test");
  check(ex.status === "extractive" && ex.cited[0] === 1 && /masked self-attention/.test(ex.text), "extractive fallback quotes the passages", ex);

  console.log("\n[E] End to end through KnowledgeService");
  const ws = path.join(tmp, "ws"); fs.mkdirSync(path.join(ws, "src"), { recursive: true }); fs.mkdirSync(path.join(ws, "dist"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "approvals.ts"), "/** The approval registry consumes an approval exactly once. */\nexport class ApprovalRegistry {\n  consume(id: string) { return id; }\n}\n");
  fs.writeFileSync(path.join(ws, "dist", "approvals.js"), "compiled output approval registry");
  const papers = path.join(ws, "papers"); fs.mkdirSync(papers);
  fs.writeFileSync(path.join(papers, "gat-2018.md"), "# Graph Attention Networks 2018\n\n## Method\n\nWe propose graph attention layers where each node attends over its neighbours using masked self-attention.\n\n## Results\n\nGAT achieves state-of-the-art accuracy on Cora and Citeseer benchmarks.\n\n## Limitations\n\nA limitation is memory use on large graphs; future work will address scalability.\n");
  fs.writeFileSync(path.join(papers, "sage-2017.md"), "# Inductive GraphSAGE 2017\n\n## Method\n\nWe propose GraphSAGE, which samples and aggregates features from a node's neighbours with mean or LSTM aggregators.\n\n## Results\n\nGraphSAGE outperforms baselines on Reddit and PPI datasets for inductive node classification.\n");
  const answers = new Scripted((req) => {
    if (/Compare|Summarise/.test(req.user)) return { answer: "Both sources propose neighbour aggregation for graph neural networks [1][2]. One uses masked self-attention over neighbours [1].", insufficient: false };
    if (/registry/.test(req.user)) return { answer: "The approval registry consumes an approval exactly once [1].", insufficient: false };
    return { answer: "The thesis deadline is not stated; the release moved to Monday 23 November [1].", insufficient: false };
  });
  const researchDir = path.join(tmp, "research");
  const svcStore = new KnowledgeStore(path.join(tmp, "svc.db"));
  const svc = new KnowledgeService({ store: svcStore, embedder: emb, model: answers, workspaceRoot: ws, extraRoots: [lib], researchDir });
  const events: RuntimeEvent[] = [];
  const run = (objective: string, signal?: AbortSignal) => svc.run({ taskId: `t${Math.random()}`, objective, signal, emit: (e) => events.push(e) });
  let rep = await run("according to my documents, when is the release?");
  check(rep?.outcome === "refused" && /Nothing is indexed yet/.test(rep.response), "asking before anything is indexed is refused with guidance", rep?.response);
  rep = await run(`index ${lib} as personal`);
  check(rep?.outcome === "completed" && rep.verification?.independentlyVerified === true && /3 indexed/.test(rep.response), "index via natural language: completed + verified", rep?.response);
  check(events.some((e) => e.type === "plan") && events.some((e) => e.type === "step.finished" && e.tool === "knowledge.index"), "progress events use the runtime's protocol");
  rep = await run("index the codebase");
  check(rep?.outcome === "completed" && svcStore.documents("codebase").every((d) => !d.path.includes(`${path.sep}dist${path.sep}`)), "codebase indexed without build output", svcStore.documents("codebase").map((d) => d.path));
  rep = await run(`index ${papers} as research`);
  check(rep?.outcome === "completed", "research collection indexed");
  rep = await run(`index ${os.homedir()} as everything`);
  check(rep?.outcome === "refused", "indexing outside the allowed roots is refused");
  rep = await run("list my knowledge collections");
  check(rep?.outcome === "completed" && /codebase \[code\]/.test(rep.response) && /personal \[personal\]/.test(rep.response) && /research \[research\]/.test(rep.response), "collections listed with kind and counts", rep?.response);
  rep = await run("According to my documents, when is the release?");
  check(rep?.outcome === "answered" && /Monday 23 November \[1\]/.test(rep.response) && /Sources:\n\[1\] .*notes\.md/.test(rep.response), "grounded answer with a validated citation and its source", rep?.response);
  check(rep?.steps.map((s) => s.step.id).join() === "kb-retrieve,kb-answer", "answer steps are marked as knowledge steps (kb-*) for the HUD");
  check(!answers.calls.at(-1)!.user.includes("Graph attention") || answers.calls.at(-1)!.user.includes("notes.md"), "the model only sees retrieved passages");
  rep = await run("How does the approval registry work in this codebase?");
  check(rep?.outcome === "answered" && /approvals\.ts:1-4 \(ApprovalRegistry\)/.test(rep.response), "codebase answer cites file and line range", rep?.response);
  rep = await run("search my documents for masked self-attention");
  check(rep?.outcome === "completed" && /gat\.pdf/.test(rep.response) && /p\. 1/.test(rep.response), "search returns passages with page citations", rep?.response);
  rep = await run("According to the collection nonexistent, what is X?");
  check(rep?.outcome === "refused" && /no collection called/.test(rep.response), "unknown collection is refused, collections listed");
  const failing = new KnowledgeService({ store: svcStore, embedder: emb, model: new Scripted(() => new Error("model down")), workspaceRoot: ws, extraRoots: [lib], researchDir });
  const rep2 = await failing.run({ taskId: "f1", objective: "According to my documents, when is the release?" });
  check(rep2?.outcome === "answered" && /Most relevant passages/.test(rep2.response) && /Monday/.test(rep2.response), "model failure: verbatim passages, labelled", rep2?.response);

  rep = await run("Find the latest research papers in my research folder about graph neural networks, compare their methodologies, identify the research gaps, and prepare a literature review.");
  check(rep?.outcome === "completed" && /Report: .*report\.md/.test(rep.response) && /\[D1\]/.test(rep.response), "literature review produced and saved", rep?.response);
  const proj = listProjects(researchDir)[0]!;
  const reportFile = path.join(researchDir, proj.id, "report.md");
  const report = fs.readFileSync(reportFile, "utf8");
  check(/^# Literature review: graph neural networks/m.test(report) && /## Methodologies/.test(report) && /## Evidence table/.test(report) && /No online sources were consulted/.test(report), "report has plan, sections, evidence table and scope statement", report.slice(0, 400));
  check(/\[D1\] Graph Attention Networks 2018/.test(report) || /\[D2\] Graph Attention Networks 2018/.test(report), "sources listed with labels");
  check(/^- \[D\d\] ".+" — .+\.md/m.test(report), "evidence extracts are verbatim with their source reference");
  check(report.indexOf("[D1] Graph Attention Networks 2018") >= 0, "\"latest\" ranks the 2018 paper first", report.match(/\[D1\][^\n]*/)?.[0]);
  check(!/Bananas|1850/.test(report), "no invented content");
  rep = await run("list research projects");
  check(rep?.outcome === "completed" && rep.response.includes(proj.id), "research projects listed");
  // A crafted project.json (user-writable) cannot redirect a resumed run outside the research folder.
  const evil = path.join(researchDir, "evil"); fs.mkdirSync(evil);
  fs.writeFileSync(path.join(evil, "project.json"), JSON.stringify({ ...proj, id: "..\\..\\escaped", topic: "escape test", versions: [] }));
  check(!listProjects(researchDir).some((p) => p.topic === "escape test"), "a project whose id is not its own folder name is ignored");
  const esc = await run("resume research escape test");
  check(esc?.outcome === "refused" && !fs.existsSync(path.join(tmp, "escaped")), "resume of a crafted project is refused; nothing written outside", esc?.outcome);
  fs.rmSync(evil, { recursive: true });

  // HUD MANAGE panel: its parsers read these exact replies, and every request it builds is claimed by this grammar.
  const pr = parseResearch(rep!.response);
  check(pr?.length === 1 && pr[0]!.id === proj.id && pr[0]!.sources >= 2 && pr[0]!.type === "Literature review", "panel parses the research list reply", pr);
  const cl = parseCollections((await run(REQ.listCollections()))!.response);
  check(cl !== null && cl.some((c) => c.name === "research" && c.kind === "research" && c.documents === 2 && c.embedded === "all" && c.folders.length === 1), "panel parses the collection list reply", cl);
  const known = svcStore.collections().map((c) => c.name);
  const panelReqs = [REQ.listCollections(), REQ.indexFolder("D:\\My Papers", "papers"), REQ.indexCodebase(), REQ.refreshCollection("research"), REQ.removeCollection("research"),
    REQ.listResearch(), REQ.resumeResearch(proj.id), REQ.showResearch(proj.id), REQ.startResearch("literature review", "graph neural networks", "my research papers"),
    REQ.startResearch("methodology comparison", "graph attention", "all my documents"), REQ.startResearch("gap analysis", "message passing", "my research papers"), REQ.startResearch("technical summary", "the approval registry", "the codebase")];
  const ops = panelReqs.map((q) => parseKnowledgeRequest(q, known)?.op ?? null);
  check(JSON.stringify(ops) === JSON.stringify(["list", "index", "index", "reindex", "drop", "research-list", "research-resume", "research-show", "research", "research", "research", "research"]), "every panel request is understood", ops);
  const st = parseKnowledgeRequest(REQ.startResearch("technical summary", "the approval registry", "the codebase"), known);
  check(st?.op === "research" && st.type === "technical-summary" && st.topic === "the approval registry" && st.scope.kind === "type", "panel research request keeps type, topic and scope", st);
  rep = await run(REQ.showResearch(proj.id));
  check(rep?.outcome === "completed" && /report\.md/.test(rep.response), "show research report", rep?.response);
  rep = await run("resume research on graph neural networks");
  check(rep?.outcome === "completed" && fs.existsSync(path.join(researchDir, proj.id, "report-v2.md")) && listProjects(researchDir)[0]!.versions.length === 2, "resume adds version 2 and keeps version 1", rep?.response);
  rep = await run("research quantum chromodynamics in my research papers");
  check(rep?.outcome === "partial" && /nothing was invented/.test(rep.response), "no matching sources: says so, saves an empty-evidence report", rep?.response);

  // Time budgets stay inside the daemon's 330 s task limit: the run reports PARTIAL ("refresh to continue"), never cancelled from outside.
  const slowEmb = new TestEmbedder(emb.modelId);
  const realEmbed = slowEmb.embed.bind(slowEmb);
  slowEmb.embed = async (t, k, s) => { await new Promise((r) => setTimeout(r, 120)); return realEmbed(t, k, s); };
  const budgetDir = path.join(ws, "budget"); fs.mkdirSync(budgetDir);
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(budgetDir, `n${i}.md`), `# Note ${i}\n\nBudget test note number ${i}.\n`);
  const budgeted = new KnowledgeService({ store: svcStore, embedder: slowEmb, model: answers, workspaceRoot: ws, extraRoots: [lib], researchDir, indexBudgetMs: 200 });
  const rb = await budgeted.run({ taskId: "b1", objective: `index ${budgetDir} as budget` });
  check(rb?.outcome === "partial" && /time budget/.test(rb.response) && /refresh/.test(rb.response) && svcStore.documents("budget").length >= 1 && svcStore.documents("budget").length < 6, "indexing budget: partial with what finished kept", { outcome: rb?.outcome, docs: svcStore.documents("budget").length });
  const rb2 = await new KnowledgeService({ store: svcStore, embedder: emb, model: answers, workspaceRoot: ws, extraRoots: [lib], researchDir }).run({ taskId: "b2", objective: "refresh budget" });
  check(rb2?.outcome === "completed" && svcStore.documents("budget").length === 6, "the next refresh finishes the rest", rb2?.response);
  const { runResearch } = await import("../../agent/runtime/knowledge/research");
  const rr0 = await runResearch({ store: svcStore, embedder: emb, model: answers, dir: path.join(tmp, "research-budget"), synthesisBudgetMs: 0 }, { topic: "graph attention", question: "Compare the methodologies of graph attention networks", type: "comparison", collections: ["research"], latest: false }, new AbortController().signal);
  const rr0Text = fs.readFileSync(rr0.reportPath, "utf8");
  check(rr0.modelSections === 0 && rr0.aspectsWithEvidence > 0 && /time budget for this run was used up/.test(rr0Text), "research budget: remaining aspects are evidence-only and the report says why", { sections: rr0.modelSections, evidence: rr0.aspectsWithEvidence, sources: rr0.sources.length });

  const ac2 = new AbortController(); ac2.abort();
  rep = await run("According to my documents, when is the release?", ac2.signal);
  check(rep?.outcome === "cancelled", "a cancelled task reports cancelled", rep?.outcome);
  rep = await run("remove the collection personal");
  check(rep?.outcome === "completed" && svcStore.collection("personal") === null && fs.existsSync(path.join(lib, "notes.md")), "collection removed from the index; files untouched");
  rep = await run(`remove ${path.join(papers, "sage-2017.md")} from my knowledge`);
  check(rep?.outcome === "completed" && svcStore.documents("research").length === 1, "a single document removed from the index", rep?.response);
  check(await svc.run({ taskId: "n", objective: "Open Notepad and type HELLO" }) === null, "non-knowledge requests fall through to the planner");

  console.log("\n[W] Optional online research (scripted page reader; no network)");
  const pagesServed: string[] = [];
  const fetchPage = async (url: string) => {
    pagesServed.push(url);
    if (url.includes("offline.test")) throw new Error("net::ERR_INTERNET_DISCONNECTED");
    return { finalUrl: url, title: "Graph Attention Blog", status: 200, truncated: false,
      text: "Graph attention explained\n\nGAT assigns learned attention coefficients to each neighbour, so important neighbours contribute more.\n\nMulti-head attention stabilises training of graph attention layers." };
  };
  const webModel = new Scripted((req) => /neighbour/.test(req.user) && !/Compare|Summarise/.test(req.user) ? { answer: "GAT assigns learned attention coefficients to each neighbour [1].", insufficient: false } : answers["reply"](req));
  const web = new KnowledgeService({ store: svcStore, embedder: emb, model: webModel, workspaceRoot: ws, extraRoots: [lib], researchDir, fetchPage });
  check(p("index the page https://blog.example.org/gat into web")?.op === "index-page" && p("Add the web pages https://a.example/x and https://b.example/y to my knowledge")?.op === "index-page", "web index grammar (one or several named pages)");
  const rw = p("Research graph attention using https://blog.example.org/gat and my research papers");
  check(rw?.op === "research" && (rw as { urls?: string[] }).urls?.[0] === "https://blog.example.org/gat" && rw.topic === "graph attention", "research with a named page keeps the topic and the URL", rw);
  check(p("What is 2+2? see https://x.example") === null, "a URL alone does not make a knowledge request");
  let rr = await svc.run({ taskId: "w0", objective: "index the page https://blog.example.org/gat into web" });
  check(rr?.outcome === "refused" && /not enabled/.test(rr.response), "without a page reader (online off) web indexing is refused; nothing else depends on it", rr?.response);
  rr = await web.run({ taskId: "w1", objective: "index the page https://blog.example.org/gat into web" });
  check(rr?.outcome === "completed" && rr.verification?.independentlyVerified === true && svcStore.collection("web")?.kind === "web" && svcStore.documents("web")[0]?.path === "https://blog.example.org/gat", "a named page is read and indexed into the web collection, keyed by its URL", rr?.response);
  check(rr?.artifact?.provenance.online === true && rr.artifact.sources[0]?.ref === "https://blog.example.org/gat", "the result's artifact is marked online with the URL as source");
  rr = await web.run({ taskId: "w2", objective: "According to my web collection, what does GAT assign to each neighbour?" });
  check(rr?.outcome === "answered" && /https:\/\/blog\.example\.org\/gat; web page\)/.test(rr.response), "answers from a web page cite its address", rr?.response);
  check(rr?.artifact?.kind === "answer" && rr.artifact.sources.some((s) => s.ref === "https://blog.example.org/gat") && rr.artifact.provenance.online === true, "the answer artifact carries the cited URL", rr?.artifact);
  rr = await web.run({ taskId: "w3", objective: "index the page https://offline.test/x into web" });
  check(rr?.outcome === "failed" && /are you online\?/.test(rr.response) && svcStore.documents("web").length === 1, "an unreadable page (offline) fails cleanly and changes nothing else", rr?.response);
  rr = await web.run({ taskId: "w4", objective: "Research graph attention using https://blog.example.org/gat and my research papers" });
  const wp = listProjects(researchDir).find((x) => x.topic === "graph attention" && x.collections.includes("web"));
  const wrep = wp ? fs.readFileSync(path.join(researchDir, wp.id, wp.versions.at(-1)!.report), "utf8") : "";
  check(rr?.outcome === "completed" && !!wp && wp.collections.includes("research") && /web page\(s\) the user named, read from the internet/.test(wrep) && /https:\/\/blog\.example\.org\/gat/.test(wrep), "research combines the named page with local papers; the report says which sources were online", { out: rr?.outcome, cols: wp?.collections });
  check(rr?.artifact?.kind === "report" && !!rr.artifact.file?.endsWith(".md") && rr.artifact.provenance.online === true, "the research artifact points at the saved report");
  // Found in the real HUD: two pages with identical text; research named the second, and only the first was cited.
  rr = await web.run({ taskId: "w4b", objective: "Research graph attention using https://mirror.example.net/gat" });
  const mp = listProjects(researchDir).find((x) => x.question.includes("Research graph attention") && x.versions.at(-1)!.sources >= 1 && x.collections.join() === "web");
  const mrep = mp ? fs.readFileSync(path.join(researchDir, mp.id, mp.versions.at(-1)!.report), "utf8") : "";
  check(rr?.outcome === "completed" && /\[D1\][^\n]*https:\/\/mirror\.example\.net\/gat/.test(mrep), "a page the request names is always a cited source, even when its text duplicates another page", { out: rr?.outcome, sources: mrep.match(/## Sources[\s\S]{0,300}/)?.[0] });
  const before = pagesServed.length;
  rr = await web.run({ taskId: "w5", objective: "refresh web" });
  check(rr?.outcome === "completed" && pagesServed.length === before + svcStore.documents("web").length, "refreshing a web collection re-reads its pages by address", rr?.response);

  svcStore.close(); store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
