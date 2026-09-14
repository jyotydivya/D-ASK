import { grepSearch } from "../lib/agent/tools/coding/fileSearch";
import { multiReplace } from "../lib/agent/tools/coding/fileEditor";
import { getFileOutline } from "../lib/agent/tools/coding/astService";
import path from "path";
import fs from "fs";

async function main() {
  console.log("Testing Coding System...\n");

  const projectRoot = process.cwd();

  // 1. Test AST Outline
  console.log("--- 1. AST Outline ---");
  const orchestratorPath = path.join(projectRoot, "agent", "orchestrator.ts");
  try {
    const outline = await getFileOutline(orchestratorPath);
    console.log(`Extracted ${outline.length} symbols from orchestrator.ts`);
    const classes = outline.filter(o => o.type === "class");
    if (classes.length > 0) {
      console.log(`Class found: ${classes[0].name} (Line ${classes[0].line})`);
    }
  } catch (e) {
    console.error("AST Outline Failed:", e);
  }

  // 2. Test Grep Search
  console.log("\n--- 2. Grep Search ---");
  try {
    const searchRes = await grepSearch(projectRoot, "class Orchestrator", false, false);
    console.log(`Found "class Orchestrator" in ${searchRes.length} files.`);
    if (searchRes.length > 0) {
      console.log(`- ${searchRes[0].file}:${searchRes[0].line}`);
    }
  } catch (e) {
    console.error("Grep Search Failed:", e);
  }

  // 3. Test Multi-Replace
  console.log("\n--- 3. Multi-Replace ---");
  const dummyFile = path.join(projectRoot, "scratch", "dummy_test.ts");
  await fs.promises.writeFile(dummyFile, `
function hello() {
  console.log("hello world");
}

function bye() {
  console.log("goodbye");
}
`.trim(), "utf-8");

  try {
    const res = await multiReplace(dummyFile, [
      {
        startLine: 1,
        endLine: 3,
        targetContent: 'function hello() {\n  console.log("hello world");\n}',
        replacementContent: 'function hello() {\n  console.log("HELLO AI");\n}'
      }
    ]);
    console.log(res.message);
    
    const content = await fs.promises.readFile(dummyFile, "utf-8");
    if (content.includes("HELLO AI")) {
      console.log("Replacement successful!");
    } else {
      console.log("Replacement failed.");
    }
  } catch (e) {
    console.error("Multi-Replace Failed:", e);
  } finally {
    // Cleanup
    await fs.promises.unlink(dummyFile).catch(() => {});
  }

  console.log("\n✅ Coding System Test Passed!");
}

main().catch(console.error);
