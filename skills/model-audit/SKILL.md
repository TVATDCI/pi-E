---
name: model-audit
description: |
  Audit the Z.ai GLM Coding Plan against live endpoints and pi's model config —
  which model ids exist, which are REAL models vs call-time aliases, whether pi's
  config matches reality, and what the current plan tier includes. Use when the
  operator upgrades or changes their Z.ai plan, suspects a model was renamed or
  retired, wants model smoke tests, or asks which models the plan exposes.
  Triggers: "model audit", "audit zai models", "plan changed", "smoke test
  models", "which glm models do I have", "models endpoint", "check plan quota".
  Do NOT use for general web research, opencode-side model config (that is sis's
  domain), or editing tier-map.ts — the audit PROPOSES diffs, the operator
  approves edits separately.
---

# Model Audit (Z.ai GLM Coding Plan)

Re-verify the plan ↔ config ↔ live-endpoint triangle. Model churn at Z.ai is
high and docs describe the NEW plan system while the account may be grandfathered
on Legacy V2 — only the operator's dashboard and live endpoints are ground truth.
Last full audit: ~/models-audit.md (2026-09-08, Legacy V2 Max-Quarterly).

## Hard rules

- The API key lives at `~/.pi/agent/auth.json` → `.["zai-coding-cn"].key`. Load
  it into a shell var inside the SAME command that uses it. **Never print,
  echo, or write it anywhere.**
- **Propose-only.** Config diffs (tier-map.ts, models-store, skills) go in the
  report. Never apply them as part of the audit.
- Keep network tool calls **short and single-purpose** (operator input arriving
  mid-batch aborts running calls; long clones/fetches die first). Prefer the
  GitHub tree API + tarball over `git clone`; one endpoint per curl.
- OCR/ASR/image/video ids are NEVER smoke-tested via chat completions — they are
  separate resource-plan APIs the coding-plan key cannot call.

## Workflow

1. **Config inventory (local, fast).** `~/.pi/agent/settings.json` (default
   provider/model/thinking) · `~/.pi/agent/models-store.json` →
   `.["zai-coding-cn"].models[]` (id/api/baseUrl/compat) ·
   `~/.pi/agent/extensions/orchestration-engine/tier-map.ts` (which ids the
   dispatch tiers + fallback chains reference).
2. **Live list.** `GET https://api.z.ai/api/paas/v4/models` with the bearer key.
   Record every id. (Provider's actual base is `open.bigmodel.cn/api/coding/paas/v4`
   — same key works on both; verify aliases on BOTH when in doubt.)
3. **Smoke + alias detection.** For each CHAT id, POST
   `https://api.z.ai/api/anthropic/v1/messages` (and/or the CN coding endpoint)
   with `{model, max_tokens:16, messages:[{role:"user",content:"ping"}]}`.
   Record HTTP status, latency, and the response's `model` field — **that field
   is the alias map** (requested vs answered_by).
4. **Cross-check.** Table: id | live | in pi store | tier-map usage | verdict.
   Flag: configured-but-dead ids, live-but-unconfigured (usually harmless
   aliases), renames.
5. **Plan docs.** Fetch (zai web-reader MCP or fetch_content):
   `docs.z.ai/devpack/overview`, `/devpack/notice/usage-revision`,
   `/devpack/faq`, `/release-notes/new-released`. Extract quotas, MCP billing,
   releases/renames. **Ask the operator for their dashboard readout** (plan tier,
   consumption lines, MCP quota meter) — docs alone cannot distinguish Legacy V2
   from credits accounts.
6. **Report.** Refresh `~/models-audit.md`: tables + a proposed diff section
   (not applied) + open operator calls. State clearly which facts are
   endpoint-verified vs doc-derived vs operator-reported.

## Known state (volatile — re-verify, do not trust stale)

- Only real models on the plan (2026-09-08): **glm-5.3, glm-5.3-flash**. All
  other ids are aliases — glm-5/5.1/5.2 → glm-5.3; glm-4.5/4.5-air/4.6/4.7/
  5-turbo → glm-5.3-flash. Dashboard still BOOKS by requested id.
- Account = Legacy Plan V2 Max-Quarterly: ~1,600 prompts/5h · ~8,000/week,
  dedicated monthly MCP quota (meter resets monthly), dedicated peak resources,
  grandfathered until the quarterly cycle ends; new-plan numbers (credits,
  off-peak 50%, MCP 1.2-credits/call) apply only after conversion.
- pi needs NO model changes while tiers target glm-5.3/glm-5.3-flash.
- Dead picker ids (cosmetic): glm-4.6v, glm-5v-turbo, glm-5.2/5.3-highspeed.
