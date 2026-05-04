---
name: "llm-wiki"
title: "LLM Wiki"
description: "Use a separately deployed LLM Wiki service as a durable, human-readable project knowledge base."
capabilities:
  - durable knowledge
  - wiki query
  - knowledge ingestion
  - project documentation
tool_hints:
  - llm_wiki
aliases:
  - wiki
  - knowledge-base
  - llm_wiki
triggers:
  - wiki
  - knowledge base
  - durable knowledge
  - 知识库
  - 文档沉淀
  - 长期知识
anti_triggers:
  - do not persist
  - no wiki
  - 不要写入知识库
---

Apply this skill when useful work should be read from or promoted into the external LLM Wiki service.

- Keep AgentOS memory for task context and reusable experience; use LLM Wiki for stable, human-readable knowledge pages.
- Query the wiki before re-explaining project decisions, architecture, or prior research.
- Ingest only durable source material, approved run summaries, project docs, or high-value experience.
- Do not send secrets, raw private chat logs, credentials, or unapproved user data to the wiki.
- Use `llm_wiki` with `network_read` approval for `query`, `health`, `status`, and `concepts`.
- Use `llm_wiki` with `network_write` approval for `import_url`, `upload`, and `analyze_page`.
- Prefer `import_url` for public docs and `upload` for local approved files.
