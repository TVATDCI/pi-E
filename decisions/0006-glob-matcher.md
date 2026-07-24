# A — Glob Matcher Fix Spec

## What we're fixing

`mini-damage-control.ts` currently matches `zeroAccessPaths` with a **literal substring** check:

```ts
// mini-damage-control.ts:298-303
for (const zap of r.zeroAccessPaths) {
  if (event.input.path.includes(zap)) {
    // ← substring, not glob
    violation = `zero-access path: ${zap}`;
    break;
  }
}
```

This silently breaks any YAML entry that uses glob syntax. The current `mini-dc-rules.yaml` was rewritten to **suffix-form substrings** (`.pem`, `.ssh/`, `.env`) as a workaround, with an explicit note in the file header that glob support is pending.

This spec is **step 1 of the agreed sequence**: a standalone bug fix that unblocks proper `readOnlyPaths`/`noDeletePaths` glob entries in step 3.

## Current behavior vs. intended behavior

| YAML entry     | Current match (substring)                                                                 | Intended match (glob)                               |
| -------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `*.pem`        | only matches a path literally containing `*.pem`                                          | matches any file ending in `.pem`                   |
| `~/.ssh/`      | only matches if the raw path contains `~/.ssh/` (Pi usually expands `~` to `/home/user/`) | matches the expanded home directory `.ssh/` segment |
| `.env.*.local` | never matches                                                                             | matches `.env.prod.local`, `.env.test.local`, etc.  |
| `dist/`        | only matches `dist/` substring (works by accident)                                        | matches any directory or file under `dist/`         |

## Design decision: dependency vs. inline

### Verified: `minimatch` is importable

The operator confirmed `minimatch` is available at `.../pi-coding-agent/node_modules/minimatch` — the same transitive-dependency mechanism that already provides `pi-tui` and `yaml`. `micromatch` is **not** available.

### Recommendation

**Use `minimatch`.** It is correct out of the box for `*`, `?`, `**`, and `~` expansion, and the dependency risk is now verified away. The earlier hand-rolled `globToRegex` draft was buggy (e.g., `dist/` failed to match `/proj/dist/bundle.js`), which is exactly why hand-rolling is the wrong call here.

## Proposed schema update

No YAML schema change is required for the **structure** (still a list of strings). The matching semantics change from literal-substring to glob. The current suffix-form entries are **not** valid glob patterns for our intent, so the YAML must be migrated atomically with the code change. Switching the matcher without rewriting the YAML would silently drop protection.

## Proposed code change

### 1. Add a glob matcher helper

Insert near the top of `mini-damage-control.ts`, after the imports:

```ts
import { minimatch } from "minimatch";

// ── Glob matcher for path rules (zeroAccess, readOnly, noDelete)
// Supports: * / ? / ** / ~ expansion, with dotfiles enabled (so .env/.ssh match).
function expandTilde(path: string): string {
  if (path === "~" || path.startsWith("~/")) {
    return join(os.homedir(), path.slice(1));
  }
  return path;
}

function pathMatchesGlob(path: string, pattern: string): boolean {
  const expandedPattern = expandTilde(pattern);
  return minimatch(path, expandedPattern, { dot: true });
}
```

### 2. Replace the substring matcher

Change the zeroAccess path check from:

```ts
// mini-damage-control.ts:298-303 (old)
for (const zap of r.zeroAccessPaths) {
  if (event.input.path.includes(zap)) {
    violation = `zero-access path: ${zap}`;
    break;
  }
}
```

to:

```ts
// mini-damage-control.ts:298-303 (new)
for (const zap of r.zeroAccessPaths) {
  if (pathMatchesGlob(event.input.path, zap)) {
    violation = `zero-access path: ${zap}`;
    break;
  }
}
```

### 3. Update rule-loading comments

In `mini-dc-rules.yaml`, replace the current matcher-semantics note with:

```yaml
# === Matcher semantics ===
#   bashToolPatterns: matched via `new RegExp(pattern).test(command)` — full regex.
#   zeroAccessPaths:  matched via minimatch glob against the path (supports *, ?, **, ~).
#                     dot: true is enabled so .env, .ssh, etc. are matched.
```

### 4. Mandatory migration of `mini-dc-rules.yaml`

The suffix-form entries from cherry-pick #1 are a stopgap; they must be superseded by true glob forms. The new matcher does **not** make `.pem` match `id_rsa.pem` or `.ssh/` match `/home/u/.ssh/id_rsa`.

Replace the `zeroAccessPaths` section with:

```yaml
zeroAccessPaths:
  # --- env / direnv ---
  - "**/.env*"
  - "**/.envrc"

  # --- SSH / cloud creds / key dirs ---
  - "**/.ssh/**"
  - "**/.aws/**"
  - "**/.gnupg/**"
  - "**/.config/gcloud/**"
  - "**/.azure/**"
  - "**/.docker/**"
  - "**/.kube/**"
  - "**/kubeconfig"

  # --- private keys / certs ---
  - "**/*.pem"
  - "**/*.p12"
  - "**/*.pfx"
  - "**/id_rsa"
  - "**/id_ecdsa"
  - "**/id_ed25519"
  - "**/id_dsa"

  # --- credential / service-account JSON ---
  - "**/credentials.json"
  - "**/*serviceAccount*.json"
  - "**/*service-account*.json"
  - "**/firebase-adminsdk*.json"
  - "**/serviceAccountKey.json"

  # --- Terraform state ---
  - "**/*.tfstate*"
  - "**/.terraform/**"

  # --- deploy-platform local dirs ---
  - "**/.vercel/**"
  - "**/.netlify/**"
  - "**/.supabase/**"

  # --- net-auth files ---
  - "**/.netrc"
  - "**/.npmrc"
  - "**/.pypirc"
  - "**/.git-credentials"

  # --- DB dumps ---
  - "**/dump.sql"
  - "**/backup.sql"
  - "**/*.dump"
```

## Validation plan

| Pattern         | Test path                                           | Expected                                               |
| --------------- | --------------------------------------------------- | ------------------------------------------------------ |
| `**/*.pem`      | `/home/vladi/.ssh/id_rsa.pem`                       | match                                                  |
| `**/*.pem`      | `/home/vladi/.ssh/id_rsa`                           | no match                                               |
| `**/.ssh/**`    | `/home/vladi/.ssh/id_rsa`                           | match                                                  |
| `dist/`         | `/home/vladi/project/dist/bundle.js`                | no match (pattern must be `**/dist/**` or `**/dist/*`) |
| `**/dist/**`    | `/home/vladi/project/dist/bundle.js`                | match                                                  |
| `**/.env*`      | `/home/vladi/project/.env.local`                    | match                                                  |
| `**/.env*`      | `/home/vladi/project/.env`                          | match                                                  |
| `**/*.tfstate*` | `/home/vladi/project/terraform/prod.tfstate.backup` | match                                                  |

Run these against `pathMatchesGlob` with `{dot: true}`.

## Validation plan

Add a small test harness or manual check:

| Pattern        | Test path                                    | Expected |
| -------------- | -------------------------------------------- | -------- |
| `*.pem`        | `/home/vladi/.ssh/id_rsa.pem`                | match    |
| `*.pem`        | `/home/vladi/.ssh/id_rsa`                    | no match |
| `~/.ssh/*`     | `/home/vladi/.ssh/id_rsa`                    | match    |
| `dist/`        | `/home/vladi/project/dist/bundle.js`         | match    |
| `dist/`        | `/home/vladi/project/mydist/x.js`            | no match |
| `.env.*`       | `/home/vladi/project/.env.local`             | match    |
| `.env.*`       | `/home/vladi/project/.env`                   | no match |
| `**/*.tfstate` | `/home/vladi/project/terraform/prod.tfstate` | match    |

Run these against `pathMatchesGlob` in a unit test or a quick `node` script.

## Constraints preserved

- **Fail-closed default is unchanged.** No rules loaded still denies bash.
- **Deny-additive merge is unchanged.** `mergeRules` still concatenates global and project lists.
- **No new rule categories are added.** This is only the matcher fix.
- **No behavior change for current suffix-form rules.** They continue to match.

## Implementation risk

- **Low.** The change is localized to one function and the matching helper. The biggest risk is tilde expansion and path resolution; test against both absolute and relative paths.
- **Open question:** whether `event.input.path` is absolute or relative. The current code uses `.includes()`, so it worked either way. With the new regex, we resolve relative paths against `process.cwd()` or `ctx.cwd` inside the extension. This is acceptable because `mini-damage-control.ts` already runs with a `ctx.cwd` from `session_start`.

## Note on `noDeletePaths` (step 7 — design only, not implemented here)

`noDeletePaths` is the next rule category after `readOnlyPaths`. The delete-detection surface should be defined at the **tool-call interception layer**, not by monitoring the filesystem after the fact. This keeps the policy precise and avoids the fuzziness of reverse-engineering intent from side effects.

### Delete-like operations to intercept

- `bash` tool with command matching:
  - `rm`, `git rm`, `rmdir`, `trash` on a `noDeletePaths` target.
  - `mv` that overwrites an existing target path.
  - `>` or `>>` redirects that truncate or overwrite a protected file.
  - `cp` with `-f` that overwrites a protected file.
- `write` tool with `path` in `noDeletePaths` and content length `0` (truncation by empty save).
- `edit` tool whose replacement results in empty content for a path in `noDeletePaths`.

### Why this approach

- Tool calls are the agent's only mutation surface. Intercepting there is deterministic.
- Filesystem monitoring would require comparing before/after state, which is racy and incomplete (e.g., it cannot distinguish an intentional edit from an accidental truncate).
- The same `pathMatchesGlob` helper from this spec applies to `noDeletePaths` matching.

This design is intentionally deferred to step 7 because the delete-detection taxonomy is a policy problem, not just a matcher problem.

## Next step

After this lands, `readOnlyPaths` (step 3) can use the same `pathMatchesGlob` helper.
