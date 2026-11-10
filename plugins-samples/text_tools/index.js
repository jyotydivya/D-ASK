"use strict";
// Sample D-ASK plugin: pure computation, no files, no network, no processes (the sandbox refuses those anyway).
exports.word_count = ({ text }) => {
  const words = (String(text).match(/\S+/g) || []).length;
  const lines = String(text).split(/\r?\n/).length;
  return { words, characters: String(text).length, lines, text: `${words} word(s), ${String(text).length} character(s), ${lines} line(s).` };
};
exports.title_case = ({ text }) => {
  const out = String(text).toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  return { result: out, text: out };
};
