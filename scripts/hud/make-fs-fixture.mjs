// Creates a synthetic project for the Phase 7A acceptance runs. Nothing personal: every file is generated here.
//   node scripts/hud/make-fs-fixture.mjs <empty target folder>
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) { console.error("usage: make-fs-fixture.mjs <folder>"); process.exit(2); }
if (fs.existsSync(root) && fs.readdirSync(root).length) { console.error(`refusing: ${root} is not empty`); process.exit(2); }
const W = (rel, data) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };

W("README.md", "# Demo project\nA synthetic project for D-ASK's filesystem acceptance test.\n");
W("docs/architecture.md", "# Architecture\n\nThe architecture has three layers.\nNothing else here.\n");
W("docs/guide.md", "# Guide\nHow to use the demo. The architecture section explains the layers.\n");
W("docs/reports/2026-q2-report.md", "# Q2 Report\n\n## 1. Introduction\nOlder report.\n");
W("docs/reports/2026-q3-report.md", [
  "# Q3 Report", "", "## 1. Introduction", "This quarter the team rebuilt the architecture.", "It now runs fully offline.", "",
  "## 2. Results", "Latency fell by half.", "", "## 3. Conclusion", "Ship it.", "",
].join("\n"));
fs.utimesSync(path.join(root, "docs/reports/2026-q2-report.md"), new Date("2026-07-01T10:00:00Z"), new Date("2026-07-01T10:00:00Z"));
fs.utimesSync(path.join(root, "docs/reports/2026-q3-report.md"), new Date("2026-10-01T10:00:00Z"), new Date("2026-10-01T10:00:00Z"));
const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from([0, 1, 2, 255]), Buffer.from("\n%%EOF\n")]);
W("docs/manual.pdf", pdf);
W("reports/annual-2025.pdf", pdf);
W(".env", "SECRET=architecture-should-never-show\n");
W("keys/deploy.pem", "architecture\n");
for (let i = 0; i < 3000; i++) W(`logs/run-${String(i).padStart(4, "0")}.log`, `entry ${i} ok\n`.repeat(200));
console.log(`fixture written to ${root}`);
