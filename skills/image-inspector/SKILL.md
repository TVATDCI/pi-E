---
name: image-inspector
description: |
  Give the text-only primary model instant eyes — converts an image (png/jpg/
  webp) into structured text observations by asking glm-5.3-flash (natively
  multimodal, inside the coding plan) a question about it. Use whenever the
  operator shares an image path/screenshot and prime pi needs to know what is
  in it: "look at this image", "what's in this picture", "read this
  screenshot", "does this UI look right", "what does this error dialog say".
  Triggers: "look at", "see this", "describe this image/screenshot", "what's
  shown in". Do NOT use for: OCR-heavy documents and tables (use local-ocr —
  tesseract first, zai-vision escalation), technical-diagram understanding or
  data-visualization analysis (zai-vision MCP has specialized tools), or video
  (zai-vision analyze_video).
---

# Image Inspector — prime-pi vision via glm-5.3-flash

The primary session model (glm-5.3) is text-only. This skill is its eyes:
a plain CLI that posts the image to **glm-5.3-flash** (multimodal, same plan,
flash-rate quota) and prints a text answer. Clean tool contract — file path
in, observations out. No sub-agent bootstrap, no MCP dependency.

## Usage

```bash
python3 ~/.pi/agent/skills/image-inspector/scripts/inspect_image.py \
  "<path_to_image>" "[optional question]"
```

Default question asks for high-detail text/structure/UI/code description.
Pass a focused question for targeted answers ("list the nodes and arrows",
"what does the error dialog say", "is this layout broken?").

## Notes

- **Endpoint**: `open.bigmodel.cn/api/coding/paas/v4` (the desk's proven CN
  coding endpoint — NOT `/api/paas/v4`, which is resource-plan territory).
  **Key**: loaded from `~/.pi/agent/auth.json` (`zai-coding-cn`) — never
  echoed, never on a command line.
- **Quota**: flash-rate prompts from the plan (V2: 1 prompt ≈ 15–20
  invocations). A glance is cheap; don't loop it — batch questions into one
  call.
- **Escalation ladder for images**: quick "what is this" → this skill;
  OCR/documents/tables → `local-ocr`; diagrams/charts/deep analysis →
  zai-vision MCP (`understand_technical_diagram`, `analyze_data_visualization`);
  video → zai-vision `analyze_video`.
- Requires `python3` + `requests` (both already on the desk).
- Errors go to stderr with HTTP status; stdout carries only the answer, so
  it is safe to capture in scripts/pipelines.
