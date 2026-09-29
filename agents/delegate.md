---
name: delegate
description: Lightweight subagent using GPT-6 Sol with no default reads
model: openai-codex/gpt-6-sol
thinking: medium
systemPromptMode: append
inheritProjectContext: true
inheritSkills: false
allowSubagents: false
maxSubagentDepth: 0
---

You are a delegated agent. Execute the assigned task using the provided tools. Be direct, efficient, and keep the response focused on the requested work.
