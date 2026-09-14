import fs from "fs";

export interface ReplacementChunk {
  startLine: number;
  endLine: number;
  targetContent: string;
  replacementContent: string;
  allowMultiple?: boolean;
}

export async function multiReplace(
  targetFile: string,
  chunks: ReplacementChunk[]
): Promise<{ success: boolean; message: string }> {
  if (!fs.existsSync(targetFile)) {
    return { success: false, message: `File not found: ${targetFile}` };
  }

  let fileContent = await fs.promises.readFile(targetFile, "utf-8");
  const lines = fileContent.split(/\r?\n/);
  
  // Sort chunks in reverse order by startLine so replacing later lines doesn't offset earlier lines
  const sortedChunks = [...chunks].sort((a, b) => b.startLine - a.startLine);

  for (let i = 0; i < sortedChunks.length; i++) {
    const chunk = sortedChunks[i];
    
    // Convert 1-based line numbers to 0-based array indices
    const startIdx = chunk.startLine - 1;
    const endIdx = chunk.endLine; // endLine is inclusive, but slice end is exclusive, so slice(startIdx, endIdx) works if we want to include endLine. Wait, slice(startIdx, endIdx) includes elements from startIdx to endIdx - 1, which corresponds to line numbers startLine to endLine.
    
    if (startIdx < 0 || endIdx > lines.length || startIdx >= endIdx) {
      return { success: false, message: `Invalid line range [${chunk.startLine}, ${chunk.endLine}] in chunk ${i}` };
    }

    const targetLines = lines.slice(startIdx, endIdx);
    const targetSection = targetLines.join("\n");

    // We simply replace the exact targetContent with replacementContent inside the targetSection.
    // If it's not found, we throw/fail.
    let occurrences = 0;
    let newSection = targetSection;
    
    // Simple string replace. To count occurrences we can split and join.
    const parts = targetSection.split(chunk.targetContent);
    occurrences = parts.length - 1;

    if (occurrences === 0) {
      return { success: false, message: `Target content not found in line range [${chunk.startLine}, ${chunk.endLine}] for chunk ${i}.` };
    }
    
    if (occurrences > 1 && !chunk.allowMultiple) {
      return { success: false, message: `Target content found multiple times in range, but allowMultiple is false for chunk ${i}.` };
    }

    newSection = parts.join(chunk.replacementContent);

    // Replace the lines in the original array
    const newSectionLines = newSection.split(/\r?\n/);
    lines.splice(startIdx, endIdx - startIdx, ...newSectionLines);
  }

  await fs.promises.writeFile(targetFile, lines.join("\n"), "utf-8");
  return { success: true, message: `Successfully applied ${chunks.length} replacement chunks.` };
}
