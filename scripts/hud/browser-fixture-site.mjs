#!/usr/bin/env node
// Loopback-only fixture site for the Browser Stage 2 real-HUD acceptance. Independent evidence: every request and every
// form submission is appended to the log file given as argv[2]; the first line is "PORT <n>".
//   node scripts/hud/browser-fixture-site.mjs <logFile>
// The page: an Email field and a Subscribe button whose click sends GET /subscribe?email=… and shows the server's reply.
import fs from "node:fs";
import http from "node:http";

const log = process.argv[2];
if (!log) { console.error("usage: browser-fixture-site.mjs <logFile>"); process.exit(2); }
const write = (line) => fs.appendFileSync(log, line + "\n");
const page = `<!doctype html><html><head><meta charset="utf-8"><title>D-ASK fixture newsletter</title></head><body>
<h1>Newsletter</h1>
<label for="email">Email</label> <input id="email" name="email" autocomplete="off">
<button id="sub" type="button">Subscribe</button>
<p id="out"></p>
<script>
document.getElementById('sub').addEventListener('click', function () {
  var v = document.getElementById('email').value;
  fetch('/subscribe?email=' + encodeURIComponent(v)).then(function (r) { return r.text(); })
    .then(function (t) { document.getElementById('out').textContent = t; });
});
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://127.0.0.1");
  write(`HIT ${req.method} ${u.pathname}`);
  if (u.pathname === "/subscribe") {
    const email = u.searchParams.get("email") ?? "";
    write(`SUBSCRIBE ${JSON.stringify(email)}`);
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end(`Thanks, ${email}!`);
  }
  if (u.pathname === "/favicon.ico") { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
});
server.listen(0, "127.0.0.1", () => write(`PORT ${server.address().port}`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
