# YouTube demo guide

## Video promise

**I made three coding agents plan, build, and review one project—without sharing API keys.**

The compelling story is the control system: different providers have bounded roles, candidates must pass tests and independent review, and every handoff remains inspectable.

## Suggested eight-minute walkthrough

1. **Cold open (0:00):** show a task moving from builder to independent reviewer, then the test result and integration commit.
2. **The problem (0:25):** autonomous coding demos often hide authority, cost, recovery, and review.
3. **Install check (1:10):** run `node doctor.mjs`. Blur usernames, paths, repository names, tokens, and account details.
4. **One-click start (1:40):** double-click `start.cmd` and show the local-only address.
5. **Create a disposable project (2:10):** use a small visual project with deterministic offline tests.
6. **Plan first (3:00):** choose **Show me a draft first** and explain milestones, acceptance criteria, scope, and call budget.
7. **Build and review (4:00):** show provider separation, the committed candidate, test gate, and explicit review verdict.
8. **Failure path (5:30):** use a prepared failed-review example to show bounded repair rather than an endless agent loop.
9. **Audit trail (6:30):** show History, project memory, usage reporting, and preserved checkpoints.
10. **Limits (7:20):** state clearly that this is a local single-user prototype, not an enterprise security boundary.

## Recording checklist

- Use a disposable repository with no secrets or personal files.
- Turn off notifications and hide account identifiers.
- Preflight every CLI outside the coordinator.
- Use offline tests during the recorded run.
- Do not repeatedly invoke live model checks for retakes.
- Record a backup successful run so quota or network failures do not ruin the explanation.
- Do not claim unverified Claude execution, live GitHub publication, enterprise readiness, or exact provider cost.
- Link `QUICKSTART.md` and `VERIFICATION.md` in the description.

## Thumbnail and title options

- **3 AI CODERS. 1 REVIEW GATE.**
- **I Built a Local AI Coding Team**
- **Can AI Agents Review Each Other?**

## Description copy

> Local Agent Coordinator is an experimental, local-first dashboard for coordinating installed Codex, Claude Code, and Kimi Code CLIs through bounded planning, tests, independent review, and auditable handoffs. This video uses a disposable repository and existing subscription logins. Review the documented limits before using it on important code.
