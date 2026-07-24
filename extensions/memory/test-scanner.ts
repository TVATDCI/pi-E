// Tier 1 test for scanner.ts. Run: node --experimental-strip-types test-scanner.ts
import { scanSecrets } from "./scanner.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}`); }
}

// --- concrete patterns: should DETECT ---
check("AWS Access Key ID", scanSecrets("the key is AKIAIOSFODNN7EXAMPLE right").detected);
check("GitHub Token", scanSecrets("ghp_012345678901234567890123456789012345").detected);
check("OpenAI API Key", scanSecrets("export OPENAI_KEY=sk-0123456789abcdefghijklmnopqrstuvwxyz").detected);
check("Private Key Block (RSA)", scanSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIE...").detected);
check("Private Key Block (OpenSSH)", scanSecrets("-----BEGIN OPENSSH PRIVATE KEY-----").detected);
check("api_key assignment", scanSecrets("api_key=AKIAEXAMPLE1234567").detected);
check("api-key hyphenated", scanSecrets("api-key: somevalue0123456789").detected);
check("password assignment", scanSecrets("password=supersecret123").detected);
check("secret assignment", scanSecrets('secret: "mysecretvalue"').detected);

// --- entropy layer: should DETECT (high-entropy base62 run, no known prefix) ---
check("high-entropy base62 run", scanSecrets("token aB3dE6fH9jK2mN5pQ8sT1vW4yZ7 passed").detected);

// --- benign: should NOT detect ---
check("benign: normal sentence", !scanSecrets("auth uses jwt per src/auth/").detected);
check("benign: decision sentence", !scanSecrets("we chose postgres over redis").detected);
check("benign: UUID allowlisted", !scanSecrets("id 550e8400-e29b-41d4-a716-446655440000 assigned").detected);
// 40-hex git SHA: hex alphabet entropy caps ~4.0, under the 4.5 threshold -> not flagged.
check("benign: 40-hex SHA under threshold", !scanSecrets("commit a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4").detected);
check("benign: short alphanumeric", !scanSecrets("node version 22").detected);
check("benign: empty string", !scanSecrets("").detected);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
