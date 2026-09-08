---
name: local-ocr
description: |
  Extract text from images and PDFs with LOCAL tools at zero API cost —
  tesseract (eng + chi_sim), pdftotext/pdfimages for digital PDFs, ocrmypdf for
  scanned PDFs — escalating to the plan-covered zai-vision MCP only for the hard
  cases (tables to Markdown, formulas, handwriting, messy scans, UI screenshots).
  Use when the operator wants OCR, text extraction from images/scans/PDFs, a
  table converted to Markdown, or a PDF that has no text layer. Triggers: "OCR",
  "extract text", "read this image", "scanned pdf", "table to markdown",
  "recognize text", "识别文字", "document parsing". Do NOT use for audio or video
  transcription (no local skill yet — whisper.cpp on concrete need), image
  GENERATION, or calling the glm-ocr API (hard constraint: no zai resource key
  exists and none will be created — never propose one).
---

# Local OCR — zero-cost extraction ladder

Local tools first (free, offline, deterministic); the zai-vision MCP is the
escalation rung, not the default — its calls draw plan quota (flash rates), fine
but never spend it on something tesseract already answers. The glm-ocr API is
permanently off the table on this desk (operator constraint 2026-09-08).

## Hard rules

- **Never** call glm-ocr / any zai resource-plan endpoint. No key exists; none
  will be created.
- **Never OCR a digital PDF.** Always `pdftotext` first; OCR only pages with no
  text layer (garbage/empty output = the signal to move up a rung).
- Language: `eng` + `chi_sim` are installed — include both unless the doc is
  known single-language.

## The ladder (run in order, stop at first success)

1. **Digital PDF** → `pdftotext -layout in.pdf -` — real text back = DONE.
2. **Scanned PDF** → `ocrmypdf -l eng+chi_sim --deskew in.pdf out.pdf` then
   `pdftotext -layout out.pdf -` (or `--sidecar out.txt` for the raw text file).
3. **Image / PDF page images** → `tesseract in.png stdout -l eng+chi_sim`.
   Page-splits first: `pdfimages -png in.pdf pg` then tesseract each.
   PSM hints: default 3 (auto); `--psm 6` single text block; `--psm 11` sparse
   text; `--psm 4` column layouts.
4. **Escalate to zai-vision MCP** (plan-covered) when the case is: table →
   Markdown, math formulas, handwriting, screenshots/UI, low-quality scans, or
   tesseract output came back garbled (<80% sensible alnum, wrong-language
   gibberish). Tool: `zai-vision_extract_text_from_screenshot` (verified
   2026-09-08 — code/terminal/docs/tables; pass the LOCAL file path + a goal in
   the prompt, e.g. "extract as a Markdown table"); `analyze_image` for general
   cases; `understand_technical_diagram` for diagrams; `analyze_data_visualization`
   for charts. One call per doc.

## Quality heuristics

- **Fixture gotcha (verified):** `img2pdf` refuses >8-bit PNGs — generate test
  fixtures with `magick -alpha off -depth 8 …`. Real-world scans/photos are
  8-bit already; this only bites synthetic images.
- tesseract confuses chi_sim text rendered without a CJK font in synthetic
  tests — for real-world Chinese scans chi_sim works; verify font presence with
  `fc-list :lang=zh` when generating test fixtures.
- Deskew + `--clean` (unpaper) help phone-photo scans.
- If rung 4 also struggles, say so — do not burn more calls; surface to the
  operator with what was attempted.

## Cost map

tesseract / ocrmypdf / poppler = free, local, unlimited. zai-vision = plan
quota only (inside the Max subscription, zero extra payment). There is no third
cost tier on this desk.
