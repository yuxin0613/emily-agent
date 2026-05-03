---
name: "recovery"
title: "Recovery"
description: "Inspect incomplete tasks and recommend a safe recovery path."
capabilities:
  - recovery
  - task inspection
tool_hints:
  - read_file
  - inspect_task
aliases:
  - inspect
  - inspection
---

Apply this skill when a task needs recovery after failure, timeout, or stale state.

- Read persisted task state before drawing conclusions.
- Do not redo the original task during inspection.
- Return whether the result is usable and what should happen next.
