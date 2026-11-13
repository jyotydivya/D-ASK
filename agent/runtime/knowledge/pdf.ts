// ─────────────────────────────────────────────────────────────────────────────
// Self-contained PDF text extraction (no native tools, no npm module; node:zlib only).
//
// Supports what research papers and ordinary documents use: indirect objects and compressed object streams, FlateDecode
// content streams, the page tree (inherited Resources), simple fonts (bytes as WinAnsi/Latin-1) and Type0/CID fonts or any font
// with a ToUnicode CMap (bfchar / bfrange). Text operators: Tj, TJ, ', ", with line breaks from Td/TD/T*/Tm/BT.
// Not supported (reported, never guessed): encrypted PDFs, scanned pages without a text layer, LZW/ASCII85 streams.
// Every page's text is returned separately so citations can name the page.
// ─────────────────────────────────────────────────────────────────────────────

import zlib from "node:zlib";

const MAX_STREAM_OUT = 32 * 1024 * 1024;

type PdfVal = number | string | boolean | null | PdfName | PdfRef | PdfStr | PdfVal[] | PdfDict;
class PdfName { constructor(readonly name: string) {} }
class PdfRef { constructor(readonly num: number, readonly gen: number) {} }
class PdfStr { constructor(readonly bytes: Buffer) {} }
type PdfDict = { [k: string]: PdfVal } & { __dict?: true };

interface PdfObj { dict: PdfDict | null; value: PdfVal; stream: Buffer | null }

export interface PdfText { pages: string[]; title: string | null; encrypted: boolean }

// ── Lexer / parser for PDF objects ───────────────────────────────────────────

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

class Parser {
  pos: number;
  constructor(readonly buf: Buffer, start = 0) { this.pos = start; }

  skipWs(): void {
    const b = this.buf;
    while (this.pos < b.length) {
      const c = b[this.pos]!;
      if (WS.has(c)) this.pos++;
      else if (c === 0x25) { while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++; }
      else break;
    }
  }

  regular(): string {
    const b = this.buf; const s = this.pos;
    while (this.pos < b.length && !WS.has(b[this.pos]!) && !DELIM.has(b[this.pos]!)) this.pos++;
    return b.toString("latin1", s, this.pos);
  }

  literalString(): Buffer {
    const b = this.buf; const out: number[] = [];
    this.pos++; // (
    let depth = 1;
    while (this.pos < b.length) {
      const c = b[this.pos++]!;
      if (c === 0x5c) {
        const n = b[this.pos++]!;
        switch (n) {
          case 0x6e: out.push(0x0a); break; case 0x72: out.push(0x0d); break; case 0x74: out.push(0x09); break;
          case 0x62: out.push(0x08); break; case 0x66: out.push(0x0c); break;
          case 0x0d: if (b[this.pos] === 0x0a) this.pos++; break;
          case 0x0a: break;
          default:
            if (n >= 0x30 && n <= 0x37) {
              let v = n - 0x30;
              for (let k = 0; k < 2 && b[this.pos]! >= 0x30 && b[this.pos]! <= 0x37; k++) v = v * 8 + (b[this.pos++]! - 0x30);
              out.push(v & 0xff);
            } else out.push(n);
        }
      } else if (c === 0x28) { depth++; out.push(c); }
      else if (c === 0x29) { if (--depth === 0) break; out.push(c); }
      else out.push(c);
    }
    return Buffer.from(out);
  }

  hexString(): Buffer {
    const b = this.buf; this.pos++; // <
    let hex = "";
    while (this.pos < b.length && b[this.pos] !== 0x3e) { const c = b[this.pos++]!; if (!WS.has(c)) hex += String.fromCharCode(c); }
    this.pos++;
    if (hex.length % 2) hex += "0";
    return Buffer.from(hex, "hex");
  }

  /** One value; numbers followed by "G R" become references. */
  value(depth = 0): PdfVal {
    if (depth > 64) throw new Error("pdf nesting too deep");
    this.skipWs();
    const b = this.buf; const c = b[this.pos];
    if (c === undefined) return null;
    if (c === 0x2f) { this.pos++; return new PdfName(decodeName(this.regular())); }
    if (c === 0x28) return new PdfStr(this.literalString());
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) {
        this.pos += 2;
        const d: PdfDict = {};
        for (;;) {
          this.skipWs();
          if (this.pos >= b.length) break;
          if (b[this.pos] === 0x3e && b[this.pos + 1] === 0x3e) { this.pos += 2; break; }
          const k = this.value(depth + 1);
          if (!(k instanceof PdfName)) { this.pos++; continue; }
          d[k.name] = this.value(depth + 1);
        }
        return d;
      }
      return new PdfStr(this.hexString());
    }
    if (c === 0x5b) {
      this.pos++;
      const arr: PdfVal[] = [];
      for (;;) {
        this.skipWs();
        if (this.pos >= b.length) break;
        if (b[this.pos] === 0x5d) { this.pos++; break; }
        arr.push(this.value(depth + 1));
      }
      return arr;
    }
    if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) { this.pos++; return null; }
    const tok = this.regular();
    if (tok === "") { this.pos++; return null; }
    if (tok === "true") return true;
    if (tok === "false") return false;
    if (tok === "null") return null;
    const n = Number(tok);
    if (!Number.isNaN(n)) {
      // Lookahead for "gen R".
      const save = this.pos;
      this.skipWs();
      const g = this.regular();
      if (/^\d+$/.test(g)) {
        this.skipWs();
        if (this.buf[this.pos] === 0x52 && (this.pos + 1 >= b.length || WS.has(b[this.pos + 1]!) || DELIM.has(b[this.pos + 1]!))) { this.pos++; return new PdfRef(n, Number(g)); }
      }
      this.pos = save;
      return n;
    }
    return new PdfName(tok); // an operator-like bare word; callers ignore it
  }
}

function decodeName(s: string): string { return s.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))); }
const isDict = (v: PdfVal | undefined): v is PdfDict => !!v && typeof v === "object" && !(v instanceof PdfName) && !(v instanceof PdfRef) && !(v instanceof PdfStr) && !Array.isArray(v);
const nameOf = (v: PdfVal | undefined) => (v instanceof PdfName ? v.name : null);

// ── Document ────────────────────────────────────────────────────────────────

class PdfDoc {
  readonly objs = new Map<number, PdfObj>();
  readonly trailer: PdfDict = {};
  constructor(readonly buf: Buffer) { this.scan(); }

  private scan(): void {
    const s = this.buf.toString("latin1");
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const num = Number(m[1]);
      const p = new Parser(this.buf, m.index + m[0].length);
      let value: PdfVal;
      try { value = p.value(); } catch { continue; }
      let stream: Buffer | null = null;
      p.skipWs();
      if (s.startsWith("stream", p.pos)) {
        let start = p.pos + 6;
        if (s[start] === "\r") start++;
        if (s[start] === "\n") start++;
        const lenVal = isDict(value) ? value.Length : undefined;
        let end = typeof lenVal === "number" && start + lenVal <= this.buf.length && s.startsWith("endstream", skipWsIndex(s, start + lenVal)) ? start + lenVal : -1;
        if (end < 0) { const e = s.indexOf("endstream", start); end = e < 0 ? this.buf.length : e; }
        stream = this.buf.subarray(start, end);
        re.lastIndex = end;
      }
      // Later definitions (incremental updates) replace earlier ones.
      this.objs.set(num, { dict: isDict(value) ? value : null, value, stream });
      if (isDict(value) && nameOf(value.Type) === "XRef") Object.assign(this.trailer, value);
    }
    const tIdx = s.lastIndexOf("trailer");
    if (tIdx >= 0) { try { const t = new Parser(this.buf, tIdx + 7).value(); if (isDict(t)) Object.assign(this.trailer, t); } catch { /* ignore */ } }
    // Object streams.
    for (const [, o] of [...this.objs]) {
      if (!o.dict || nameOf(o.dict.Type) !== "ObjStm" || !o.stream) continue;
      let data: Buffer;
      try { data = this.decodeStream(o); } catch { continue; }
      const n = typeof o.dict.N === "number" ? o.dict.N : 0;
      const first = typeof o.dict.First === "number" ? o.dict.First : 0;
      const hp = new Parser(data);
      const pairs: [number, number][] = [];
      for (let i = 0; i < n; i++) { const a = hp.value(); const b = hp.value(); if (typeof a === "number" && typeof b === "number") pairs.push([a, b]); }
      for (const [num, off] of pairs) {
        if (this.objs.has(num) && this.objs.get(num)!.stream === null && this.objs.get(num)!.dict !== null) continue;
        try { const v = new Parser(data, first + off).value(); this.objs.set(num, { dict: isDict(v) ? v : null, value: v, stream: null }); } catch { /* skip */ }
      }
    }
  }

  get(v: PdfVal | undefined, depth = 0): PdfVal | undefined {
    if (v instanceof PdfRef) return depth > 16 ? undefined : this.get(this.objs.get(v.num)?.value, depth + 1);
    return v;
  }
  obj(v: PdfVal | undefined): PdfObj | undefined { return v instanceof PdfRef ? this.objs.get(v.num) : undefined; }

  decodeStream(o: PdfObj): Buffer {
    if (!o.stream) return Buffer.alloc(0);
    const f = this.get(o.dict?.Filter);
    const filters = (Array.isArray(f) ? f : f ? [f] : []).map((x) => nameOf(this.get(x) as PdfVal));
    let data: Buffer = o.stream;
    for (const name of filters) {
      if (name === "FlateDecode" || name === "Fl") {
        try { data = zlib.inflateSync(data, { maxOutputLength: MAX_STREAM_OUT }); }
        catch { data = zlib.inflateSync(data, { maxOutputLength: MAX_STREAM_OUT, finishFlush: zlib.constants.Z_SYNC_FLUSH }); }
        const parms = this.get(o.dict?.DecodeParms);
        if (isDict(parms) && typeof parms.Predictor === "number" && parms.Predictor >= 10) data = unpredict(data, typeof parms.Columns === "number" ? parms.Columns : 1);
      } else throw new Error(`unsupported stream filter ${name}`);
    }
    return data;
  }

  pages(): PdfDict[] {
    const out: PdfDict[] = [];
    const root = this.get(this.trailer.Root);
    const seen = new Set<PdfDict>();
    const walk = (node: PdfVal | undefined, inherited: PdfDict | null, depth: number) => {
      const d = this.get(node);
      if (!isDict(d) || seen.has(d) || depth > 64) return;
      seen.add(d);
      const res = isDict(this.get(d.Resources)) ? (this.get(d.Resources) as PdfDict) : inherited;
      const type = nameOf(d.Type);
      if (type === "Pages" || Array.isArray(this.get(d.Kids))) {
        for (const k of (this.get(d.Kids) as PdfVal[]) ?? []) walk(k, res, depth + 1);
      } else out.push(res && !d.Resources ? { ...d, Resources: res } : d);
    };
    if (isDict(root)) walk(root.Pages, null, 0);
    if (out.length === 0) {
      // No usable page tree: fall back to every /Type /Page object, in object order.
      for (const [, o] of [...this.objs].sort((a, b) => a[0] - b[0])) if (o.dict && nameOf(o.dict.Type) === "Page") out.push(o.dict);
    }
    return out;
  }
}

function skipWsIndex(s: string, i: number): number { while (i < s.length && /\s/.test(s[i]!)) i++; return i; }

function unpredict(data: Buffer, columns: number): Buffer {
  const rowLen = columns + 1; const rows = Math.floor(data.length / rowLen);
  const out = Buffer.alloc(rows * columns); const prev = Buffer.alloc(columns);
  for (let r = 0; r < rows; r++) {
    const type = data[r * rowLen]!; const row = data.subarray(r * rowLen + 1, (r + 1) * rowLen);
    for (let i = 0; i < columns; i++) {
      const left = i > 0 ? out[r * columns + i - 1]! : 0; const up = prev[i]!; const ul = i > 0 ? (r > 0 ? out[(r - 1) * columns + i - 1]! : 0) : 0;
      let v = row[i]!;
      if (type === 1) v += left; else if (type === 2) v += up; else if (type === 3) v += (left + up) >> 1;
      else if (type === 4) { const p = left + up - ul; const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul); v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul; }
      out[r * columns + i] = v & 0xff;
    }
    out.copy(prev, 0, r * columns, (r + 1) * columns);
  }
  return out;
}

// ── Fonts ───────────────────────────────────────────────────────────────────

interface Font { codeBytes: 1 | 2; map: Map<number, string> | null }

function parseCMap(text: string): { map: Map<number, string>; codeBytes: 1 | 2 } {
  const map = new Map<number, string>();
  let codeBytes: 1 | 2 = 1;
  const csr = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(text);
  if (csr && csr[1]!.length >= 4) codeBytes = 2;
  const hexToStr = (h: string) => { let s = ""; for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); if (h.length === 2) s = String.fromCharCode(parseInt(h, 16)); return s; };
  for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) { map.set(parseInt(m[1]!, 16), hexToStr(m[2]!)); if (m[1]!.length >= 4) codeBytes = 2; }
  }
  for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]*)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1]!, 16), hi = parseInt(m[2]!, 16);
      if (m[1]!.length >= 4) codeBytes = 2;
      if (hi - lo > 65_535) continue;
      if (m[4] !== undefined) {
        const base = m[4]!;
        const lastCode = parseInt(base.slice(-4) || "0", 16);
        const prefix = hexToStr(base.slice(0, -4));
        for (let c = lo; c <= hi; c++) map.set(c, prefix + String.fromCharCode(lastCode + (c - lo)));
      } else {
        const items = [...m[5]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => hexToStr(x[1]!));
        for (let c = lo; c <= hi && c - lo < items.length; c++) map.set(c, items[c - lo]!);
      }
    }
  }
  return { map, codeBytes };
}

// WinAnsi bytes 0x80-0x9F that differ from Latin-1 (quotes, dashes, bullet, ligature-free).
const WINANSI: Record<number, string> = { 0x80: "€", 0x82: "‚", 0x84: "„", 0x85: "…", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x99: "™" };
const LIGATURES: Record<string, string> = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl" };

const GLYPHS: Record<string, string> = {
  fi: "fi", fl: "fl", ff: "ff", ffi: "ffi", ffl: "ffl", quoteright: "’", quoteleft: "‘", quotedblleft: "“", quotedblright: "”", quotesingle: "'", quotedbl: "\"",
  endash: "–", emdash: "—", hyphen: "-", minus: "−", bullet: "•", periodcentered: "·", ellipsis: "…", space: " ", dotlessi: "ı", germandbls: "ß",
  period: ".", comma: ",", colon: ":", semicolon: ";", exclam: "!", question: "?", parenleft: "(", parenright: ")", bracketleft: "[", bracketright: "]",
  braceleft: "{", braceright: "}", slash: "/", backslash: "\\", ampersand: "&", percent: "%", dollar: "$", numbersign: "#", at: "@", asterisk: "*", plus: "+",
  equal: "=", less: "<", greater: ">", underscore: "_", bar: "|", asciitilde: "~", asciicircum: "^", grave: "`", acute: "´", dieresis: "¨", circumflex: "ˆ", tilde: "˜",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", multiply: "×", divide: "÷", degree: "°", section: "§", paragraph: "¶", dagger: "†", daggerdbl: "‡",
};
function glyphToUnicode(name: string): string | null {
  if (name.length === 1) return name;
  if (GLYPHS[name] !== undefined) return GLYPHS[name]!;
  const uni = /^uni([0-9A-Fa-f]{4})/.exec(name) ?? /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (uni) return String.fromCodePoint(parseInt(uni[1]!, 16));
  const accented = /^([A-Za-z])(acute|grave|dieresis|circumflex|tilde|ring|cedilla|caron)$/.exec(name);
  const MARK: Record<string, string> = { acute: "́", grave: "̀", dieresis: "̈", circumflex: "̂", tilde: "̃", ring: "̊", cedilla: "̧", caron: "̌" };
  if (accented) return (accented[1]! + MARK[accented[2]!]!).normalize("NFC");
  return null;
}

function decodeWith(font: Font | undefined, bytes: Buffer): string {
  let s = "";
  if (font?.map && font.map.size > 0) {
    const step = font.codeBytes;
    for (let i = 0; i + step <= bytes.length; i += step) {
      const code = step === 2 ? bytes.readUInt16BE(i) : bytes[i]!;
      const u = font.map.get(code);
      s += u ?? (step === 1 ? String.fromCharCode(code) : "");
    }
  } else if (font?.codeBytes === 2) {
    return ""; // CID font without ToUnicode: cannot be decoded honestly
  } else {
    for (const b of bytes) s += WINANSI[b] ?? String.fromCharCode(b);
  }
  return s.replace(/[ﬀ-ﬄ]/g, (c) => LIGATURES[c] ?? c);
}

// ── Content streams ─────────────────────────────────────────────────────────

function pageText(doc: PdfDoc, page: PdfDict, fontCache: Map<PdfVal, Font>): string {
  const res = doc.get(page.Resources);
  const fontsDict = isDict(res) ? doc.get(res.Font) : undefined;
  const fonts = new Map<string, Font>();
  if (isDict(fontsDict)) {
    for (const [name, ref] of Object.entries(fontsDict)) {
      let f = fontCache.get(ref);
      if (!f) {
        const fd = doc.get(ref);
        f = { codeBytes: 1, map: null };
        if (isDict(fd)) {
          if (nameOf(fd.Subtype) === "Type0") f.codeBytes = 2;
          // Simple fonts: /Encoding << /Differences [code /glyph ...] >> (ligatures, quotes, dashes in TeX output).
          const enc = doc.get(fd.Encoding);
          const diffs = isDict(enc) ? doc.get(enc.Differences) : undefined;
          if (Array.isArray(diffs) && f.codeBytes === 1) {
            const m = new Map<number, string>();
            let code = 0;
            for (const it of diffs) {
              if (typeof it === "number") code = it;
              else if (it instanceof PdfName) { const u = glyphToUnicode(it.name); if (u !== null) m.set(code, u); code++; }
            }
            if (m.size) { f.map = new Map<number, string>(); for (let c = 0; c < 256; c++) f.map.set(c, m.get(c) ?? (WINANSI[c] ?? String.fromCharCode(c))); }
          }
          const tu = doc.obj(fd.ToUnicode);
          if (tu) { try { const cm = parseCMap(doc.decodeStream(tu).toString("latin1")); if (cm.map.size) { f.map = f.map ? new Map([...f.map, ...cm.map]) : cm.map; f.codeBytes = nameOf(fd.Subtype) === "Type0" ? 2 : cm.codeBytes; } } catch { /* keep default */ } }
        }
        fontCache.set(ref, f);
      }
      fonts.set(name, f);
    }
  }
  const contents = doc.get(page.Contents);
  const refs = Array.isArray(contents) ? contents : page.Contents ? [page.Contents] : [];
  const parts: Buffer[] = [];
  for (const r of refs) { const o = doc.obj(r as PdfVal); if (o) { try { parts.push(doc.decodeStream(o)); } catch { /* unreadable stream */ } } }
  return runContent(Buffer.concat(parts.map((p) => Buffer.concat([p, Buffer.from("\n")]))), fonts);
}

function runContent(data: Buffer, fonts: Map<string, Font>): string {
  const p = new Parser(data);
  const stack: PdfVal[] = [];
  let font: Font | undefined;
  let out = "";
  let lastY: number | null = null;
  const newline = () => { if (out && !out.endsWith("\n")) out += "\n"; };
  const show = (s: string) => { out += s; };
  while (p.pos < data.length) {
    p.skipWs();
    if (p.pos >= data.length) break;
    const c = data[p.pos]!;
    // Inline image: skip its binary data.
    if (c === 0x42 && data[p.pos + 1] === 0x49 && WS.has(data[p.pos + 2] ?? 0x20)) {
      const end = data.indexOf("EI", p.pos + 2, "latin1");
      p.pos = end < 0 ? data.length : end + 2; stack.length = 0; continue;
    }
    const isOperand = c === 0x2f || c === 0x28 || c === 0x3c || c === 0x5b || c === 0x2d || c === 0x2b || c === 0x2e || (c >= 0x30 && c <= 0x39);
    if (isOperand) { try { stack.push(p.value()); } catch { p.pos++; } if (stack.length > 64) stack.splice(0, stack.length - 64); continue; }
    const op = p.regular();
    if (op === "") { p.pos++; continue; }
    switch (op) {
      case "Tf": { const n = stack[stack.length - 2]; if (n instanceof PdfName) font = fonts.get(n.name); break; }
      case "Tj": { const s = stack[stack.length - 1]; if (s instanceof PdfStr) show(decodeWith(font, s.bytes)); break; }
      case "'": case "\"": { newline(); const s = stack[stack.length - 1]; if (s instanceof PdfStr) show(decodeWith(font, s.bytes)); break; }
      case "TJ": {
        const arr = stack[stack.length - 1];
        if (Array.isArray(arr)) for (const it of arr) {
          if (it instanceof PdfStr) show(decodeWith(font, it.bytes));
          else if (typeof it === "number" && it < -180 && !out.endsWith(" ")) show(" ");
        }
        break;
      }
      case "Td": case "TD": { const ty = stack[stack.length - 1]; if (typeof ty === "number" && Math.abs(ty) > 0.5) newline(); else if (!out.endsWith(" ")) show(" "); break; }
      case "T*": newline(); break;
      case "Tm": { const y = stack[stack.length - 1]; if (typeof y === "number") { if (lastY !== null && Math.abs(y - lastY) > 0.5) newline(); else if (!out.endsWith(" ")) show(" "); lastY = y; } break; }
      case "BT": lastY = null; break;
      case "ET": newline(); break;
      default: break;
    }
    stack.length = 0;
  }
  return out;
}

function pdfStringText(v: PdfVal | undefined): string | null {
  if (!(v instanceof PdfStr)) return null;
  const b = v.bytes;
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) { let s = ""; for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i)); return s.trim() || null; }
  return b.toString("latin1").trim() || null;
}

/** Extracts text per page. Throws only for input that is not a PDF at all. */
export function extractPdfText(buf: Buffer): PdfText {
  if (buf.subarray(0, 1024).toString("latin1").indexOf("%PDF-") < 0) throw new Error("not a PDF file");
  const doc = new PdfDoc(buf);
  if (doc.trailer.Encrypt) return { pages: [], title: null, encrypted: true };
  const info = doc.get(doc.trailer.Info);
  const title = isDict(info) ? pdfStringText(doc.get(info.Title)) : null;
  const fontCache = new Map<PdfVal, Font>();
  const pages = doc.pages().map((pg) => { try { return tidy(pageText(doc, pg, fontCache)); } catch { return ""; } });
  return { pages, title, encrypted: false };
}

function tidy(s: string): string {
  return s
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/(\w)-\n(\w)/g, "$1$2") // hyphenated line breaks
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
