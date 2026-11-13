// Plugin sandbox preload (runs before any plugin code, inside a `node --permission` process that may read only the
// plugin's own sealed folder and this runner). The permission model already blocks file writes, reads elsewhere, child
// processes, workers, native addons, process.binding and eval. It does NOT block network in Node 24, so every network
// entry point is closed here: the Socket connect chokepoint (used by net, tls, http, https and fetch), listening, dgram,
// dns, and the global fetch / WebSocket / EventSource. Each replaced entry is non-writable and non-configurable, so plugin
// code can neither restore nor delete it. (Whole modules are not frozen: stdio pipes are sockets and must keep working.)
"use strict";
const deny = (what) => function denied() { const e = new Error(`Network access is not permitted for plugins (${what}).`); e.code = "ERR_PLUGIN_NETWORK_DENIED"; throw e; };
const lock = (obj, key, what) => Object.defineProperty(obj, key, { value: deny(what), writable: false, configurable: false, enumerable: false });
const net = require("node:net");
lock(net.Socket.prototype, "connect", "socket connect");
lock(net, "connect", "net.connect"); lock(net, "createConnection", "net.createConnection");
lock(net.Server.prototype, "listen", "listen"); lock(net, "createServer", "net.createServer");
const tls = require("node:tls"); lock(tls, "connect", "tls.connect"); lock(tls, "createServer", "tls.createServer");
const dgram = require("node:dgram"); lock(dgram, "createSocket", "dgram"); lock(dgram.Socket.prototype, "bind", "dgram bind"); lock(dgram.Socket.prototype, "send", "dgram send");
const dns = require("node:dns");
for (const k of Object.keys(dns)) if (typeof dns[k] === "function" && k !== "getServers" && k !== "Resolver") lock(dns, k, `dns.${k}`);
for (const k of Object.keys(dns.promises)) if (typeof dns.promises[k] === "function" && k !== "Resolver") lock(dns.promises, k, `dns.promises.${k}`);
lock(dns.Resolver.prototype, "resolve", "dns.Resolver");
for (const m of ["node:http", "node:https", "node:http2"]) { const mod = require(m); for (const k of ["request", "get", "connect", "createServer", "createSecureServer"]) if (typeof mod[k] === "function") lock(mod, k, `${m}.${k}`); }
for (const g of ["fetch", "WebSocket", "EventSource"]) Object.defineProperty(globalThis, g, { value: deny(g), writable: false, configurable: false });