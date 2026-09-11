# Continue on the new PC

Open the coordinator folder as a LOCAL project in Codex on the new PC. Start a new conversation there and ask it to read this file and CONVERSATION.md in the parent folder. The original native conversation remains on the old PC; this package does not recreate its sidebar identity.

The user wants a practical autonomous multi-CLI coding coordinator: explicit models, bounded planning/build/review, shared handoffs, usage caps and recovery, existing/new repositories, and authorized private GitHub pushes. Avoid repeated plan/review loops and unsupported claims about enterprise readiness.

Implemented: Node >=22 local server at port 4317; read-only CLI agents return validated file proposals; independent plan/code review; tests and Git worktree integration; dashboard project picker; Codex model/usage discovery; bounded Kimi/Claude recovery; per-role model controls; synthetic compatibility checks. The last live Kimi check passed. Codex and Claude were quota-blocked on September 8; that evidence is historical and must be refreshed. Tests: 46 full tests passed, then 3 focused checks including the added Pause case. See VERIFICATION.md.

RESOLVED (2026-09-11): cited research is implemented in lib/research.mjs — bounded retrieval of public https sources with verbatim excerpts, URLs and fetch times, an independent evidence review gate, and citation rules in the planning prompt. It retrieves and cites; it does not verify truth or completeness, and it has no search engine: sources are supplied by the user. Automatic repeated project planning to completion is also not implemented; plans are limited to 1–3 milestones.

The dashboard state has no selected user repository and zero tasks. Its saved two calls are compatibility checks. No actual YouTube source project is included. This package contains the coordinator project and this conversation only. If the user also needs yt-autonomous-growth, transfer that separately using its Git/worktree structure.

Do not copy credentials from the old PC. Install/log in to Codex and Kimi on the new PC; Claude uses WSL. The included prepare-new-pc.mjs refreshes adapter executable paths and retains saved model choices. Git history is in coordinator-history.bundle. The source snapshot includes all tracked files as of packaging.
