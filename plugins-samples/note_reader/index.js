// Sample plugin that uses the sandbox's `dask` capability requests. The sandbox itself has no file or memory access; `dask.readFile` and
// `dask.searchMemory` only ASK the D-ASK host, which checks the user's current grants on every request and refuses what is not granted.
"use strict";

exports.file_head = async function file_head(input) {
  const n = Math.min(Math.max(Number(input && input.lines) || 5, 1), 20);
  const text = await dask.readFile(String(input && input.path));
  const head = String(text).split(/\r?\n/).slice(0, n).join("\n");
  return { text: head, lines: n };
};

exports.my_notes = async function my_notes(input) {
  const notes = await dask.searchMemory(String(input && input.query));
  return { text: notes.length ? notes.map((x) => "- " + x).join("\n") : "No saved notes matched.", count: notes.length };
};
