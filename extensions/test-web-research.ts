// test-web-research.ts — exercises the exported logic of web-research.ts.
// Run: node --experimental-strip-types extensions/test-web-research.ts
//
// IMPORTANT: this file lives inside pi's auto-loaded extensions/ dir, so pi
// imports it at startup. The main-guard below ensures the test body only runs
// when invoked directly, and the no-op default export keeps pi's loader happy.
// WITHOUT these, the process.exit() at the bottom kills pi on every launch.
import { pathToFileURL } from "node:url";
import { searchAll, fetchText, safeUrl, assertSafeHost, isBlockedAddr, clampMaxChars, FETCH_MAX_CHARS } from "./web-research.ts";

// No-op default export: this is a test runner, not a pi extension.
// Required because pi auto-loads every top-level *.ts in extensions/.
export default function () {};

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (!isMain) {
  // Imported by pi's extension loader — do nothing.
} else {
  (async () => {
    let pass = 0, fail = 0;
    const NETWORK = process.env.PI_NETWORK_TESTS === "1";
    const ok = (name: string, cond: boolean, extra = "") => {
      if (cond) { pass++; console.log(`✅ ${name}`); }
      else { fail++; console.log(`❌ ${name} ${extra}`); }
    };

    if (NETWORK) {
      console.log("=== searchAll: composite keyless search ===");
      const s = searchAll("typescript type guards");
      console.log(s.slice(0, 400) + (s.length > 400 ? "\n…" : ""));
      ok("search returns non-empty", s.length > 0 && !s.startsWith("(no keyless"));
      ok("search bounded to SEARCH_MAX_CHARS", s.length <= 6000);
      ok("search hit at least one source section", /Wikipedia|DuckDuckGo|npm|GitHub/.test(s));
    } else {
      console.log("⊘ 3 searchAll tests skipped (set PI_NETWORK_TESTS=1 for live-network tests)");
    }

    if (NETWORK) {
      console.log("\n=== fetchText: page → clean text, truncated ===");
      try {
        const f = await fetchText("https://raw.githubusercontent.com/earendil-works/pi/main/README.md");
        console.log(`bytes: ${f.length}, head: ${f.slice(0, 80).replace(/\n/g, " ")}`);
        ok("fetch returns extracted text", f.length > 50);
        ok("fetch respects small max_chars", (await fetchText("https://raw.githubusercontent.com/earendil-works/pi/main/README.md", 500)).length <= 700);
      } catch (e) {
        const msg = (e as Error).message ?? "";
        ok("fetch returns extracted text", false, `(network error: ${msg})`);
        ok("fetch respects small max_chars", false, `(network error: ${msg})`);
        if (/ECONNREFUSED|ENETUNREACH|NXDOMAIN|unresolvable|getaddrinfo|ETIMEDOUT|fetch failed/.test(msg)) {
          console.log("⚠️  Network tests skipped — no internet connectivity in this environment (expected)");
        } else {
          console.error("❌ Unexpected fetch error:", msg);
        }
      }
    } else {
      console.log("⊘ 2 fetchText network tests skipped (set PI_NETWORK_TESTS=1; requires w3m)");
    }

    console.log("\n=== safeUrl: SSRF guard (string checks) ===");
    ok("blocks file:// scheme", (() => { try { safeUrl("file:///etc/passwd"); return false; } catch { return true; } })());
    ok("blocks cloud metadata 169.254.x", (() => { try { safeUrl("http://169.254.169.254/latest/meta-data/"); return false; } catch { return true; } })());
    ok("blocks localhost", (() => { try { safeUrl("http://localhost/admin"); return false; } catch { return true; } })());
    ok("blocks private 10.x", (() => { try { safeUrl("http://10.0.0.1/"); return false; } catch { return true; } })());
    ok("allows https example", safeUrl("https://example.com/foo") === "https://example.com/foo");

    console.log("\n=== fetchText: defense-in-depth (safeUrl inside) ===");
    ok("fetchText rejects private host directly", await (async () => { try { await fetchText("http://10.0.0.1/"); return false; } catch { return true; } })());
    ok("fetchText rejects file:// directly", await (async () => { try { await fetchText("file:///etc/passwd"); return false; } catch { return true; } })());

    console.log("\n=== assertSafeHost: resolve → range-check (no network needed) ===");
    const blocked = async (url: string): Promise<boolean> => {
      try { await assertSafeHost(new URL(url).hostname); return false; } catch { return true; }
    };
    ok("blocks 127.0.0.1", await blocked("http://127.0.0.1/"));
    ok("blocks 169.254.169.254", await blocked("http://169.254.169.254/"));
    ok("blocks 10.0.0.1", await blocked("http://10.0.0.1/"));
    ok("blocks 192.168.1.1", await blocked("http://192.168.1.1/"));
    ok("blocks 172.16.0.1", await blocked("http://172.16.0.1/"));
    ok("blocks [::1]", await blocked("http://[::1]/"));
    ok("blocks [fc00::1]", await blocked("http://[fc00::1]/"));
    ok("blocks [fe80::1]", await blocked("http://[fe80::1]/"));
    ok("blocks [::ffff:127.0.0.1]", await blocked("http://[::ffff:127.0.0.1]/"));
    ok("blocks [2002:ac10:0001::] (6to4->172.16.0.1)", await blocked("http://[2002:ac10:0001::]/"));
    ok("blocks [2002:7f00:1::] (6to4->127.0.0.1)", await blocked("http://[2002:7f00:0001::]/"));
    ok("blocks [64:ff9b::7f00:1] (NAT64->127.0.0.1)", await blocked("http://[64:ff9b::7f00:1]/"));

    const allowed = async (url: string): Promise<boolean> => {
      try { await assertSafeHost(new URL(url).hostname); return true; } catch { return false; }
    };
    ok("allows 8.8.8.8 (public IP)", await allowed("http://8.8.8.8/"));

    console.log("\n=== isBlockedAddr: direct range-check unit tests ===");
    ok("blocks fec0::dead (site-local fe00::/8)", isBlockedAddr("fec0::dead"));
    ok("blocks fe80::1 (link-local still blocked after widening)", isBlockedAddr("fe80::1"));
    ok("blocks 0.1.2.3 (0.0.0.0/8)", isBlockedAddr("0.1.2.3"));
    ok("blocks 100.64.0.1 (CGNAT)", isBlockedAddr("100.64.0.1"));
    ok("blocks 100.127.255.255 (CGNAT upper bound)", isBlockedAddr("100.127.255.255"));
    ok("allows 100.63.255.255 (just below CGNAT)", !isBlockedAddr("100.63.255.255"));
    ok("blocks 224.0.0.1 (multicast 224.0.0.0/4)", isBlockedAddr("224.0.0.1"));
    ok("blocks 240.0.0.1 (reserved 240.0.0.0/4)", isBlockedAddr("240.0.0.1"));
    ok("allows 8.8.4.4 (public)", !isBlockedAddr("8.8.4.4"));
    ok("blocks :: (unspecified)", isBlockedAddr("::"));
    ok("blocks ff02::1 (IPv6 multicast)", isBlockedAddr("ff02::1"));
    ok("allows 2001:4860:4860::8888 (public IPv6)", !isBlockedAddr("2001:4860:4860::8888"));
    ok("blocks 2001:0:1:2:3:4:5:6 (Teredo 2001::/32)", isBlockedAddr("2001:0:1:2:3:4:5:6"));

    console.log("\n=== clampMaxChars: bounds enforcement ===");
    ok("clampMaxChars caps at 20000", clampMaxChars(999999) === 20000);
    ok("clampMaxChars defaults for 0", clampMaxChars(0) === FETCH_MAX_CHARS);
    ok("clampMaxChars defaults for negative", clampMaxChars(-5) === FETCH_MAX_CHARS);
    ok("clampMaxChars passes through 500", clampMaxChars(500) === 500);

    console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  })();
}
