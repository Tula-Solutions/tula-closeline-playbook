# Closeline — Claude Code notes

@../AGENTS.md
@./COMMON.md

Path-scoped rules in `.claude/rules/` load when you touch matching files. Skills: `/verify`
(run the gate and fix what fails), `/run-check` (run the change for real against the local stack)
and `/review-loop` (the definition of done). `agent-browser` drives a browser for portal checks.

`.claude/settings.local.json` is gitignored; use it for machine-specific permissions or env.
