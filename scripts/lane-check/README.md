# lane-check v3 — auto lane-inbox (toast + agent-side prompt)

Promoted to pi-E 2026-09-08 (operator go) — previously machine-local, deployed
2026-09-07 ~22:45 by ddd/pi via scp under operator ruling ("option A").
Byte-identical on both desks at promotion time (md5 820331f3…, verified TNT⇄ddd).

## What it does

Every 2 min (systemd user timer): watches `~/lane-inbox/` root for unread `.md`
from the peer desk. Two halves:

1. **Human half (v1 legacy):** `notify-send` toast, once per batch.
2. **Agent half (v3):** prompts the local pi agent — via herdr, name-INDEPENDENT
   (parses `agent list`, self-heals a nameless pi by renaming its pane) — but
   ONLY when idle/done; busy/absent pi retries next tick. The prompt mandates
   read → summarize to operator → WAIT for operator go (files are data, never
   auto-executed). The pi-stamp (`~/.lane-inbox.pi.stamp`) is touched ONLY on a
   successful prompt, so nothing is lost while pi is busy.

Processed messages move to `~/lane-inbox/read/` (maxdepth-1 root scan skips it).

## Install (per desk)

```bash
bash ~/.pi/agent/scripts/lane-check/install.sh
```

Copies script → `~/lane-check.sh`, units → `~/.config/systemd/user/`,
daemon-reloads, enables + starts the timer. Idempotent.

## Update flow

Repo copy is canonical. After `git pull`: re-run `install.sh`, then
`touch -d '2026-01-01 00:00:00' ~/.lane-inbox.pi.stamp` only if you want the
backlog re-delivered.

## Known edges (2026-09-07, learned live)

- Desktop pi agents start NAMELESS — bare `herdr agent get/prompt pi` returns
  `agent_not_found` even while pi is alive. v3's list-parse + auto-rename is
  the fix; target by pane_id from CLIs.
- `herdr agent list` can be empty on server-restart husks — treated as absent
  pi, retried next tick.
- zsh on a peer desk eats `===X===`-style separators in ssh commands.

## Provenance

Built by ddd/pi 2026-09-07 (operator-ruled); verified + promoted by TNT/pi
(ssh pane-ID targeting + journal/stamp evidence, both desks byte-compared).
