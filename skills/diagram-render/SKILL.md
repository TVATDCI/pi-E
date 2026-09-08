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
