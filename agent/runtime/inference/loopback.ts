// Loopback-only endpoint validation for the local model server.
//
// Accepted: http:// with a literal IPv4 loopback (127.0.0.0/8) or [::1] host,
// an explicit port, and no path, query, fragment or credentials.
// Rejected: "localhost" (resolution depends on the hosts file and DNS), any
// other host, https (no certificates on loopback), and anything ambiguous.

export class NonLoopbackEndpointError extends Error {
  constructor(reason: string) {
    super(`Local model endpoint rejected: ${reason}`);
    this.name = "NonLoopbackEndpointError";
  }
}

export function isLoopbackHost(hostname: string): boolean {
  if (hostname === "[::1]") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  return m !== null && m.slice(1).every((o) => Number(o) <= 255);
}

/** Returns the normalised base URL ("http://127.0.0.1:PORT") or throws. */
export function assertLoopbackBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NonLoopbackEndpointError("not a valid URL");
  }
  if (url.protocol !== "http:") throw new NonLoopbackEndpointError(`protocol ${url.protocol} is not allowed`);
  if (url.username || url.password) throw new NonLoopbackEndpointError("credentials in the URL are not allowed");
  // WHATWG URL normalises numeric IPv4 forms (e.g. 2130706433 → 127.0.0.1) before this check.
  if (!isLoopbackHost(url.hostname)) throw new NonLoopbackEndpointError(`host "${url.hostname}" is not a loopback address`);
  if (!url.port) throw new NonLoopbackEndpointError("an explicit port is required");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new NonLoopbackEndpointError("the base URL must not contain a path, query or fragment");
  }
  return `${url.protocol}//${url.host}`;
}
