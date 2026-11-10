// TEST-ONLY: runs the HUD page's own approval parser (hooks/approvalLifecycle.ts) on a daemon ActionApprovalRequest
// payload saved to a file, and prints what the page would display (or why it would refuse to offer a decision).
//   node tests/hud-agent/fixtures/parse-approval.ts <payload.json>   (no npx: nothing is fetched)
import { readFileSync } from "node:fs";
// @ts-ignore: an explicit .ts extension lets plain `node` (built-in type stripping) run this without npx or a download.
import { parseApprovalRequest } from "../../../hooks/approvalLifecycle.ts";

const payload = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
process.stdout.write(JSON.stringify(parseApprovalRequest(payload)));
