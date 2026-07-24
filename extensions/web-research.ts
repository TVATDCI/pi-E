// web-research.ts — keyless composite web research for pi (Option B).
//
// Philosophy: pi's built-in `bash` already reaches the web (curl/w3m). This
// extension just gives the model two clean, TOKEN-BOUNDED tools so it can't
// accidentally dump 36K-token pages into context:
//   search(query) — fans out to free keyless sources (Wikipedia, DuckDuckGo
//                   instant-answer, npm registry, GitHub search), returns compact
//                   snippets. No API key. Coding/library/package/concept research.
//                   KNOWN GAP: general free-text web (blogs/news/forums) — DDG/Google
//                   are CAPTCHA-blocked headlessly in 2026.
//   fetch(url)    — curl + w3m -dump → clean text, HARD-truncated (~6000 chars).
//                   http/https only; private/loopback/link-local hosts blocked (SSRF).
//
// Logic functions are exported at module scope (testable without spinning up pi).
// Verified working endpoints: see test-web-research.ts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawnSync } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import { URL } from "node:url";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
export const FETCH_MAX_CHARS = 6000;
export const SEARCH_MAX_CHARS = 6000;
const MAX_FETCH = 20000;
const ERR_HOST_NOT_ALLOWED = "host not allowed";

export function clampMaxChars(req: unknown): number {
  const n = Number(req);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_FETCH) : FETCH_MAX_CHARS;
}

/** GET a URL, return body string ("" on any failure). Plain curl, no shell. */
export function httpGet(url: string, timeoutSec = 12): string {
  try {
    const r = spawnSync("curl", [
      "-sL",
      "-A", UA,
      "--max-time", String(timeoutSec),
      "-H", "Accept: application/json,text/html,*/*",
      url,
    ], { encoding: "utf8", timeout: (timeoutSec + 4) * 1000, maxBuffer: 8 * 1024 * 1024 });
    if (r.status !== 0 || r.error || !r.stdout) return "";
    return r.stdout;
  } catch {
    return "";
  }
}

/** Validate a URL for safe fetching. http/https only; block private/loopback/link-local. */
export function safeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`blocked scheme ${u.protocol} (http/https only)`);
  }
  const h = u.hostname.toLowerCase();
  const privateHost =
    h === "localhost" ||
    h === "0.0.0.0" ||
    h.endsWith(".local") ||
    h.startsWith("127.") ||
    h.startsWith("10.") ||
    h.startsWith("192.168.") ||
    h.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  if (privateHost) throw new Error(`blocked private/loopback/link-local host: ${h}`);
  return u.href;
}

/** Resolve a hostname and verify no resolved address is private/reserved. Returns the pinned IP. */
export async function assertSafeHost(host: string): Promise<string> {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dnsLookup(bare, { all: true, verbatim: true });
  } catch {
    throw new Error(ERR_HOST_NOT_ALLOWED);
  }
  if (!addrs.length) throw new Error(ERR_HOST_NOT_ALLOWED);
  let lastError: Error | undefined;
  for (const a of addrs) {
    try {
      if (isBlockedAddr(a.address)) throw new Error(ERR_HOST_NOT_ALLOWED);
      return a.address;
    } catch (e) {
      lastError = e as Error;
    }
  }
  throw lastError;
}

export function isBlockedAddr(addr: string): boolean {
  if (isIPv4(addr)) {
    const o = addr.split(".").map(Number);
    const [a, b] = o;
    if (a === 0) return true;                         // 0.0.0.0/8
    if (a === 10) return true;                         // 10.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a === 127) return true;                        // 127.0.0.0/8
    if (a === 169 && b === 254) return true;           // 169.254.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16
    if (a >= 224 && a <= 239) return true;             // 224.0.0.0/4 (multicast)
    if (a >= 240) return true;                         // 240.0.0.0/4 (reserved)
    return false;
  }
  if (isIPv6(addr)) {
    const n = addr.toLowerCase();
    if (n === "::" || n === "::1") return true;        // ::/128, ::1/128
    if (n.startsWith("::ffff:")) {
      // ::ffff:0:0/96 — block entire range; also check embedded IPv4
      const rest = n.slice(7);
      if (isIPv4(rest)) {
        if (isBlockedAddr(rest)) return true;
      } else {
        const segs = rest.split(":");
        if (segs.length >= 2) {
          const hi = parseInt(segs[segs.length - 2], 16);
          const lo = parseInt(segs[segs.length - 1], 16);
          if (Number.isFinite(hi) && Number.isFinite(lo)) {
            const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
            if (isBlockedAddr(v4)) return true;
          }
        }
      }
      return true;
    }
    // 2002::/16 (6to4): bytes 2-5 are the embedded IPv4 (groups index 1 and 2 of the 16-bit groups)
    if (n.startsWith("2002:")) {
      const g = n.split(":");                  // ["2002", "WWXX", "YYZZ", ...]
      const g2 = parseInt(g[1] ?? "", 16);
      const g3 = parseInt(g[2] ?? "", 16);
      if (Number.isFinite(g2) && Number.isFinite(g3)) {
        const v4 = `${(g2 >> 8) & 0xff}.${g2 & 0xff}.${(g3 >> 8) & 0xff}.${g3 & 0xff}`;
        if (isBlockedAddr(v4)) return true;    // recurse into IPv4 range check
      }
      return true; // unknown 6to4 form — block conservatively
    }
    // 2001:0000::/32 (Teredo tunneling) — second 16-bit group is 0; real Teredo hosts are 2001:0:....
    // (2001:4860:: etc. have a non-zero second group → allowed.)
    if (n.startsWith("2001:") && parseInt((n.split(":")[1] ?? "x"), 16) === 0) return true;
    // 64:ff9b::/96 (NAT64 well-known prefix): embedded IPv4 is the last 32 bits
    if (n.startsWith("64:ff9b:")) {
      const tail = n.split(":").filter(s => s !== "");
      const last2 = tail.slice(-2);
      const hi = parseInt(last2[0] ?? "", 16);
      const lo = parseInt(last2[1] ?? "", 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        if (isBlockedAddr(v4)) return true;
      }
      return true; // conservatively block
    }
    if (n.startsWith("fc") || n.startsWith("fd")) return true; // fc00::/7 (ULA)
    if (n.startsWith("fe")) return true;   // fe00::/8 (link-local fe80::/10 + site-local fec0::/10)
    if (n.startsWith("ff")) return true;                         // ff00::/8 (multicast)
    return false;
  }
  return false;
}

/** Fetch a URL → clean text (curl | w3m -dump), no shell (two spawnSync steps). Hard-truncate. */
export async function fetchText(rawUrl: string, maxChars = FETCH_MAX_CHARS): Promise<string> {
  const href = safeUrl(rawUrl); // defense-in-depth: scheme + string-host check even if called directly (not only via the tool)
  const u = new URL(href);
  const host = u.hostname;
  const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const ip = await assertSafeHost(bareHost);
  const actualPort = u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80);
  const ports = new Set([80, 443, actualPort]);
  const fmtHost = isIPv6(bareHost) ? `[${bareHost}]` : bareHost;
  const fmtIp = isIPv6(ip) ? `[${ip}]` : ip;
  const resolveArgs = [...ports].flatMap(p => ["--resolve", `${fmtHost}:${p}:${fmtIp}`]);
  const curl = spawnSync("curl", [
    "-s", "-A", UA, "--max-time", "12",
    ...resolveArgs,
    "--", rawUrl,
  ], {
    encoding: "utf8",
    timeout: 16000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (curl.status !== 0 || !curl.stdout) return `(fetch failed: curl status ${curl.status})`;
  const w3m = spawnSync("w3m", ["-dump", "-T", "text/html"], {
    input: curl.stdout,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 16 * 1024 * 1024,
  });
  let txt = (w3m.stdout ?? "").replace(/\n{3,}/g, "\n\n").trim();
  if (txt.length > maxChars) txt = txt.slice(0, maxChars) + `\n…[truncated ${txt.length - maxChars} chars]`;
  return txt;
}

/** Composite keyless search. Each source is independent — one failing omits its section, never kills the whole call. */
export function searchAll(query: string): string {
  const q = (query ?? "").trim();
  if (!q) return "(empty query)";
  const enc = encodeURIComponent(q);
  const parts: string[] = [];

  // 1. Wikipedia
  try {
    const d = JSON.parse(httpGet(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${enc}&format=json&srlimit=3`));
    const hits: { title?: string; snippet?: string }[] = d?.query?.search ?? [];
    if (hits.length) {
      parts.push("## Wikipedia");
      for (const h of hits) {
        const snip = (h.snippet ?? "").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();
        parts.push(`- ${h.title}: ${snip.slice(0, 200)}`);
      }
    }
  } catch { /* omit */ }

  // 2. DuckDuckGo instant answer (curated; often thin for technical queries)
  try {
    const d = JSON.parse(httpGet(`https://api.duckduckgo.com/?q=${enc}&format=json&no_html=1`));
    const abs = (d?.AbstractText ?? "").trim();
    if (abs) parts.push("## DuckDuckGo (instant answer)", abs.slice(0, 400));
    const rel: { Text?: string }[] = (d?.RelatedTopics ?? []).slice(0, 4);
    const relTxt = rel.filter((t) => t.Text).map((t) => `- ${(t.Text ?? "").slice(0, 150)}`);
    if (relTxt.length) parts.push("Related:", ...relTxt);
  } catch { /* omit */ }

  // 3. npm registry (packages)
  try {
    const d = JSON.parse(httpGet(`https://registry.npmjs.org/-/v1/search?text=${enc}&size=3`));
    const objs: { package: { name?: string; version?: string; description?: string; links?: { npm?: string } } }[] = d?.objects ?? [];
    if (objs.length) {
      parts.push("## npm");
      for (const o of objs) {
        const p = o.package;
        parts.push(`- ${p.name}@${p.version}: ${(p.description ?? "").slice(0, 140)}${p.links?.npm ? ` — ${p.links.npm}` : ""}`);
      }
    }
  } catch { /* omit */ }

  // 4. GitHub repos (unauthenticated: rate-limited ~10/min; UA header required)
  try {
    const d = JSON.parse(httpGet(`https://api.github.com/search/repositories?q=${enc}&per_page=3`));
    const items: { full_name?: string; stargazers_count?: number; description?: string; html_url?: string }[] = d?.items ?? [];
    if (items.length) {
      parts.push("## GitHub");
      for (const it of items) {
        parts.push(`- ${it.full_name} (★${it.stargazers_count ?? 0}): ${(it.description ?? "").slice(0, 140)}${it.html_url ? ` — ${it.html_url}` : ""}`);
      }
    }
  } catch { /* omit */ }

  let out = parts.length ? parts.join("\n") : `(no keyless results for: ${q} — try a different angle, or the answer may live in general web which is a known gap)`;
  if (out.length > SEARCH_MAX_CHARS) out = out.slice(0, SEARCH_MAX_CHARS) + "\n…[truncated]";
  return out;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "search",
    label: "Web search (keyless composite)",
    description:
      "Search the web using free keyless sources (Wikipedia, DuckDuckGo instant-answer, npm registry, GitHub). Returns compact text snippets. No API key. Use for coding/library/package/concept research. KNOWN GAP: general free-text web (blogs/news/forums) is not covered. Follow up promising items with the `fetch` tool.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),
    async execute(_id, params) {
      const out = searchAll(String(params?.query ?? ""));
      return { content: [{ type: "text", text: out }], details: { source: "keyless-composite" } };
    },
  });

  pi.registerTool({
    name: "fetch",
    label: "Fetch URL → text",
    description:
      "Fetch an http(s) URL and return clean extracted text (HTML→text via w3m), HARD-truncated to ~6000 chars to bound token cost. Private/loopback/link-local hosts blocked. Use to read a specific page/docs the model selected from search results — do not fetch every result.",
    parameters: Type.Object({
      url: Type.String({ description: "http(s) URL to fetch" }),
      max_chars: Type.Optional(Type.Number({ description: "Max chars to return (default 6000)" })),
    }),
    async execute(_id, params) {
      // Single typed details object so all return branches share one AgentToolResult<T>
      // (avoids the union-inference error TS introduced when AgentToolResult made `details` required).
      const details: { url?: string; bytes?: number; error?: string } = {};
      let href: string;
      try {
        href = safeUrl(String(params?.url ?? ""));
        details.url = href;
      } catch (e) {
        details.error = "url-blocked";
        return { content: [{ type: "text", text: `Blocked: ${(e as Error).message}` }], details };
      }
      const max = clampMaxChars(params?.max_chars);
      let txt: string;
      try {
        txt = await fetchText(href, max);
        details.bytes = txt.length;
      } catch (e) {
        details.error = "fetch-blocked";
        return { content: [{ type: "text", text: `Blocked: ${(e as Error).message}` }], details };
      }
      return { content: [{ type: "text", text: txt || "(empty response)" }], details };
    },
  });
}
