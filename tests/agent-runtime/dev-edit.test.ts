/** dev.edit_file grammar (2026-11-14). Run with: npx tsx tests/agent-runtime/dev-edit.test.ts. Real files: DevEditTests.cs. */
import { devEditRequest } from "../../agent/runtime/tools/devEdit";

let passed = 0, failed = 0;
const check = (c: boolean, l: string, d?: unknown) => { if (c) { passed++; console.log("  PASS: " + l); } else { failed++; console.error("  FAIL: " + l + (d !== undefined ? ` | ${JSON.stringify(d)}` : "")); } };
const t0 = Date.now();
const a = devEditRequest('In D:\\proj\\calc.js, replace "return a + b" with "return a - b" and run the tests in D:\\proj');
check(JSON.stringify(a) === JSON.stringify({ file: "D:\\proj\\calc.js", find: "return a + b", replace: "return a - b", testFolder: "D:\\proj" }), "edit + tests", a);
const b = devEditRequest('Replace "foo" with "bar" in D:\\p\\x.ts');
check(JSON.stringify(b) === JSON.stringify({ file: "D:\\p\\x.ts", find: "foo", replace: "bar", testFolder: null }), "replace … in file", b);
check(devEditRequest("Replace foo with bar in my code") === null, "unquoted text is not an edit request");
check(devEditRequest('In D:\\' + "x".repeat(300) + ', replace "a" with "b"') === null && Date.now() - t0 < 2000, "long input is rejected quickly (no catastrophic backtracking)");
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
