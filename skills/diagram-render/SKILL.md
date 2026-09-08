---
name: diagram-render
description: |
  Render technical diagrams at zero API cost — GLM-5.3 (inside the coding plan)
  writes graphviz/dot or mermaid code, local tools turn it into SVG/PNG. Use for
  flowcharts, architecture/system diagrams, state machines, sequence diagrams,
  org charts, gantt, decision trees, and any "draw me / visualize this system"
  request where STRUCTURE matters (not photoreal art). Triggers: "diagram",
  "flowchart", "architecture diagram", "draw me", "visualize this system",
  "mermaid", "graphviz", "state diagram", "sequence diagram". Do NOT use for
  photorealistic image generation (no local GPU, glm-image API permanently out
  by constraint), OCR or screenshot reading (local-ocr / zai-vision), or
  analyzing EXISTING charts (zai-vision analyze_data_visualization).
---

# Diagram Render — plan-model codegen + local render

The model writes CODE that draws; deterministic local renderers produce the
image. Free, offline, diffable, vault-friendly. glm-image API is permanently
off this desk (no resource key, ever); this path covers the real diagram needs.

## Hard rules

- Prefer **SVG** output (crisp, small); PNG only when a raster is required.
- graphviz/dot is the DEFAULT (instant, no browser). Reach for mermaid only
  when its richer syntax pays (sequence, gantt, xychart, styled flowcharts).
- Never propose GPU image-gen or glm-image API — constraint `zai_no_extra_payment`.

## The ladder

1. **Generate code** — ask the session model (glm-5.3/flash) for the diagram as
   dot or mermaid source, saved to a file. One iteration loop: render → read
   the syntax error → fix → re-render (local, so retries are free).
2. **Render graphviz** (installed via `pacman -S graphviz`):
   ```bash
   dot -Tsvg input.dot -o diagram.svg
   dot -Tpng -Gdpi=144 input.dot -o diagram.png
   ```
3. **Render mermaid** (npx on-demand, system chromium — no bundled download):
   ```bash
   PUPPETEER_SKIP_DOWNLOAD=1 npx -y @mermaid-js/mermaid-cli \
     -i input.mmd -o diagram.svg \
     --puppeteerConfigFile ~/.pi/agent/skills/diagram-render/scripts/puppeteer.json
   ```
   First run fetches the npm package (~30–60 s); after that it is cached.

## Choosing the syntax

| need | use |
|---|---|
| architecture, dependency/system graphs, trees, state machines | graphviz `dot` |
| flowcharts with styling, sequence, gantt, class, er, xychart | mermaid |
| trivial boxes/arrows in markdown/docs | inline ASCII or hand-written SVG |

## Notes

- CJK labels: verify a CJK font exists (`fc-list :lang=zh`) before promising
  Chinese text in diagrams.
- `scripts/puppeteer.json` points mermaid-cli at `/usr/bin/chromium`
  (`--no-sandbox`) — edit if the chromium path moves.
- For iterative editing, keep the source file as the artifact (git-friendly);
  re-render on change.

## Autonomic visual feedback loop (verify without a human)

Prime pi is text-only but can still VERIFY its own renders — close the loop
with `image-inspector` (glm-5.3-flash eyes, one plan prompt per glance):

```
write dot/mermaid -> render to /tmp/diagram-preview.png
-> inspect_image.py "/tmp/diagram-preview.png" "Quality-check this diagram:
   (a) list node names and edge labels EXACTLY, flag misspellings;
   (b) flag layout flaws: overlapping labels, truncated text, broken
       arrows, awkward wraps. End with verdict PASS or FAIL."
-> if FAIL: fix the SOURCE (never the PNG) -> re-render -> re-inspect
-> PASS: present the final SVG/PNG path to the operator
```

Proven 2026-09-08: planted defects ("Operaotr", "promt") were caught with
corrections on iteration 1; repair + re-render returned PASS on iteration 2.

**Remediation cheatsheet (fix layout flaws in the SOURCE):** overlaps /
crowding -> `nodesep=0.8 ranksep=0.8` (dot) or more `----` link length
(mermaid); long labels -> `"<br/>"` wrapping; arrow chaos -> `splines=ortho`;
truncated text -> larger `-Gdpi`/explicit `width`.

Budget: prefer 2 verification passes, hard cap 3 — each is a flash prompt;
after that surface the source + PNG to the operator instead of looping.
