#!/usr/bin/env python3
"""inspect_image.py — give the text-only primary model eyes.

Calls glm-5.3-flash (natively multimodal, inside the coding plan) on the CN
coding endpoint with a base64 image + question; prints the text answer.

Usage:
  python3 inspect_image.py <image_path> [question]

Key comes from ~/.pi/agent/auth.json (zai-coding-cn) — NEVER from env echoes
or command lines. Stdout = the model's answer only; errors go to stderr.
"""
import base64
import json
import mimetypes
import os
import sys

import requests

AUTH_PATH = os.path.expanduser("~/.pi/agent/auth.json")
ENDPOINT = "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"
MODEL = "glm-5.3-flash"
TIMEOUT_S = 60
MAX_BYTES = 15 * 1024 * 1024  # soft guard


def die(msg: str, code: int = 1) -> None:
    print(f"Error: {msg}", file=sys.stderr)
    sys.exit(code)


def load_key() -> str:
    try:
        with open(AUTH_PATH, encoding="utf-8") as f:
            key = json.load(f)["zai-coding-cn"]["key"]
        if not key:
            raise KeyError("empty key")
        return key
    except Exception as e:  # noqa: BLE001 - single exit path
        die(f"cannot read plan key from {AUTH_PATH} ({e})")


def main() -> None:
    if len(sys.argv) < 2:
        die("usage: inspect_image.py <image_path> [question]")
    image_path = sys.argv[1]
    question = (
        sys.argv[2]
        if len(sys.argv) > 2
        else "Describe what you see in this image in high detail, focusing on "
        "text, structure, UI elements, or code."
    )

    if not os.path.isfile(image_path):
        die(f"file not found: {image_path}")
    size = os.path.getsize(image_path)
    if size > MAX_BYTES:
        die(f"image is {size} bytes (> {MAX_BYTES}); downscale first")

    mime = mimetypes.guess_type(image_path)[0]
    if not mime or not mime.startswith("image/"):
        # fall back to PNG (mimetype sniff fails on some .webp setups)
        mime = "image/png"
    if mime == "image/jpg":
        mime = "image/jpeg"

    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")

    payload = {
        "model": MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": question},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{mime};base64,{b64}"},
                    },
                ],
            }
        ],
        "max_tokens": 1024,
    }

    try:
        r = requests.post(
            ENDPOINT,
            json=payload,
            headers={"Authorization": f"Bearer {load_key()}"},
            timeout=TIMEOUT_S,
        )
    except requests.RequestException as e:
        die(f"request failed: {e}")

    if r.status_code != 200:
        die(f"HTTP {r.status_code}: {r.text[:300]}")

    try:
        content = r.json()["choices"][0]["message"]["content"]
    except (KeyError, IndexError, ValueError) as e:
        die(f"unexpected response shape ({e}): {r.text[:300]}")

    # content may be a list of parts (some zai responses) — flatten
    if isinstance(content, list):
        content = "".join(
            p.get("text", "") if isinstance(p, dict) else str(p) for p in content
        )
    print(content)


if __name__ == "__main__":
    main()
