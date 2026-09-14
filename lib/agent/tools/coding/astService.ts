import ts from "typescript";
import fs from "fs";

export interface OutlineItem {
  type: "class" | "interface" | "function" | "method";
  name: string;
  signature: string;
  line: number;
}

export async function getFileOutline(filePath: string): Promise<OutlineItem[]> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const sourceCode = await fs.promises.readFile(filePath, "utf-8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceCode,
    ts.ScriptTarget.Latest,
    true
  );

  const outline: OutlineItem[] = [];

  function getLine(node: ts.Node): number {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  }

  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node) && node.name) {
      outline.push({
        type: "class",
        name: node.name.text,
        signature: `class ${node.name.text}`,
        line: getLine(node),
      });
    } else if (ts.isInterfaceDeclaration(node)) {
      outline.push({
        type: "interface",
        name: node.name.text,
        signature: `interface ${node.name.text}`,
        line: getLine(node),
      });
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      // Basic signature extraction by slicing source code
      const start = node.getStart();
      const bodyStart = node.body ? node.body.getStart() : node.end;
      const signature = sourceCode.substring(start, bodyStart).trim();
      
      outline.push({
        type: "function",
        name: node.name.text,
        signature: signature.replace(/\s+/g, ' '),
        line: getLine(node),
      });
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      const start = node.getStart();
      const bodyStart = node.body ? node.body.getStart() : node.end;
      const signature = sourceCode.substring(start, bodyStart).trim();
      
      outline.push({
        type: "method",
        name: node.name.text,
        signature: signature.replace(/\s+/g, ' '),
        line: getLine(node),
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return outline;
}
