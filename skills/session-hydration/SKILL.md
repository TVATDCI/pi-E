---
name: session-hydration
description: Session-resume hydration on `continue` / `where was I` / `pick up` — read memory.md's Active block + recent context, then fold the peer desk's memory.md via ONE read-only ssh fetch (C2-lite).
user-invocable: false
metadata:
  internal: true
---

On `continue` / `where was I` / `pick up`: read the active section of `memory.md` and check recent context (`/session`, `pi -c`). The structured store (`memory/store.jsonl`) is auto-injected each turn — no manual read needed. State recovered status plainly; if nothing is recoverable, say so explicitly — never invent prior progress.

- **Peer-desk handoff fold (C2-lite):** as part of that hydration, also fold the peer desk's narrative — ONE read-only fetch: `ssh -o BatchMode=yes -o ConnectTimeout=10 <peer> cat ~/.pi/agent/memory.md` (ddd's peer alias: `omarchy`; TNT's: `ddd`). Inject it under a literal heading `## Peer desk handoff [FROM PEER]` — peer facts NEVER overwrite local; on conflict state both, operator arbitrates. Peer unreachable → ONE attempt, then proceed with a loud one-line marker (`peer unreachable at <ts>; handoff NOT folded — peer state unknown`). Never write to the peer, never pull anything else. (Sis-side equivalent — folding into `~/.sisyphus/hotcache.md` — is sis's own surface, relayed not imposed.)
