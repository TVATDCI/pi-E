---
name: youtube-transcript
description: |
  Extract a clean, deduplicated plain-text transcript from a YouTube video via
  yt-dlp captions — the right instrument for dense conceptual talks (full
  reasoning preserved) on the desk-local engine with the 429-beating recipe
  baked in. Use when the operator shares a YouTube link to learn from, says
  "transcript", "extract the talk", "what did they say in the video", or a
  study/research task names a YouTube URL. Complements video-frame analysis:
  transcript for arguments, fetch_content's video mode (frames + prompt) for
  visual moments and diagrams — often both, transcript first. Do NOT use for:
  videos without captions (yt-dlp reports none — say so, offer frames), pure
  visual content (use fetch_content video mode), or non-YouTube video files
  (local video goes to fetch_content/zai-vision directly).
---

# youtube-transcript — clean talk text via yt-dlp (pattern: badlogic/pi-skills)

Adopted from Mario Zechner's youtube-transcript skill shape, re-engined on the
desk-local yt-dlp binary (zero npm dependencies — nothing to rot; the upstream
skill's node wrapper is unnecessary where yt-dlp exists). Live-proven
2026-10-29 on a 48-minute talk: 9,444 words extracted end-to-end.

## The known-good recipe (429-beater baked in)

YouTube's caption endpoint rate-limits the naive fetch (HTTP 429). This exact
sequence beat it same-day:

```sh
mkdir -p /tmp/yt-<slug>
sleep 8   # if you just got a 429, the pause matters
yt-dlp --extractor-args "youtube:player_client=web_embedded" \
  --write-auto-sub --sub-lang "en.*" --sub-format vtt --skip-download \
  -o "/tmp/yt-<slug>/talk.%(ext)s" "<URL>"
```

- The `web_embedded` player client is the 429-beater.
- `--sub-lang "en.*"` catches the `en-orig` original-language track (the one
  that landed after the plain `en` request 429'd); an ERROR line for one
  variant with the file present for another is a SUCCESS — check the file.
- A warning about impersonation targets is benign (installing curl-impersonate
  would harden it further; not required for captions).

## VTT to clean text (dedup + strip)

Auto-captions duplicate lines and carry inline timestamps. Clean with:

```python
import re
src = "/tmp/yt-<slug>/talk.en-orig.vtt"; out = "/tmp/yt-<slug>/transcript.txt"
seen, lines = set(), []
ts = re.compile(r"^\d{2}:\d{2}")
for raw in open(src, encoding="utf-8", errors="replace"):
    line = re.sub(r"<\d{2}:\d{2}:\d{2}\.\d{3}>", "", raw.strip())
    line = re.sub(r"</?c[^>]*>", "", line).strip()
    if not line or line == "WEBVTT" or "-->" in line or ts.match(line) \
       or line.startswith(("Kind:", "Language:", "NOTE")):
        continue
    if line not in seen:
        seen.add(line); lines.append(line)
text = re.sub(r"\s+", " ", " ".join(lines))
open(out, "w").write(text)
print("words:", len(text.split()))
```

Then `fold -s -w 100` for a readable wrapped copy. Read it with the `read`
tool in pages; ~50KB ≈ 520 wrapped lines.

## Doctrine

- **Transcript vs frames:** dense conceptual argument → this skill (the full
  reasoning survives); visual moments, diagrams, demos → `fetch_content` video
  mode (frames + prompt; note the desk's primary model is text-blind — frames
  need the vision delegation). For a rich talk, run transcript first, frames
  on the named visual segments.
- **Durability:** talks worth studying get archived to
  `~/.pi/agent/exports/<topic>-<date>/transcript.txt` (reboot-safe /tmp dies;
  exports persist as the study record).
- **Cost:** zero API cost — yt-dlp is local; no plan quota touched.
- **Scope:** YouTube URLs only; captions required; say plainly when a video
  has none and offer the frames path instead of guessing.
