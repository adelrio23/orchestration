# What this system is — a briefing for another assistant

Paste this whole file into another chat when you want help writing a project brief for this coordinator. It describes what the system does and, more importantly, the constraints any plan has to fit.

## What it is

A local Node.js server (`node server.mjs`, dashboard at `http://127.0.0.1:4317`) that orchestrates three coding CLIs already installed and signed in on the user's Windows PC:

- **Codex** (ChatGPT subscription login)
- **Kimi Code** (managed `kimi-code` OAuth)
- **Claude Code** (Claude subscription, run through WSL)

No API keys, no paid API fallback. It uses the subscriptions the user already pays for. Everything runs on their machine; nothing is deployed.

## How work actually happens

1. **Plan.** A lead agent proposes up to 8 small, sequential milestones. Each gets a short role label ("backend", "tests", "ui").
2. **Plan review.** A *different* agent reviews the plan and must end with `REVIEW: PASS`.
3. **Build.** One agent implements a milestone in an isolated git worktree on its own branch.
4. **Test.** The coordinator runs the project's configured test commands. They must pass.
5. **Review.** A *different* provider than the builder inspects the committed candidate and must end with `REVIEW: PASS`.
6. **Repair.** A failed review is not the end: the findings go back to the builder as the next brief, and the reviewed candidate becomes the new base. Bounded (default 2 rounds).
7. **Integrate.** Passing work merges automatically, with combined tests run on an integration branch first.
8. **Push** (optional) to a private GitHub repo, on a dedicated `coordinator/<id>/integration` branch. Never to `main`, never forced.
9. **Repeat.** With autonomous mode on, it plans the next milestones and continues with no human approval.
10. **Completion vote.** When the lead says the goal is met, every available agent is asked independently and must answer `VERDICT: COMPLETE`. Unanimous or it keeps working; a dissent's stated gaps become a project decision the next round must address.

## Constraints a plan MUST fit — this is the important part

- **Agents cannot write files or run commands.** They return *complete replacement files* as JSON. The coordinator validates every path, writes them, runs tests, and commits. Agents have read-only access to the project (Read/Glob/Grep only).
- **At most 40 files per build attempt**, and **no file deletions** are possible. Work needing mass deletion or renaming must be restructured.
- **Every milestone must be independently testable** by the configured test commands, and the tests must live inside the milestone's owned paths. A milestone with no test is a milestone that cannot pass.
- **Each milestone declares owned paths.** An agent that writes outside them has its work rejected. Milestones must have disjoint, explicit scopes.
- **One task at a time** by default. Concurrency above 1 requires explicitly independent tasks with non-overlapping paths.
- **Call budget.** Every agent invocation — planning, building, reviewing, research, chat, completion votes — spends from one shared budget (default 60, max 1000). A milestone costs at least 2 calls (build + review), more with repairs.
- **Context cap** of 40,000 characters per prompt (max 200,000).
- **Secrets and config paths are blocked**: `.env*`, `credentials*`, `auth.json`, `.git`, `.claude`, `.codex`, `.kimi` can never be written or committed.
- **Only private GitHub repos** can be push targets.

## Research

An agent can search the web (the only role given web tools). It must return every claim with a source URL and a verbatim quote. The coordinator then **re-fetches each cited page and discards any finding whose quote isn't actually there**, so fabricated sources are dropped. Surviving findings need an independent agent's approval before the lead may use them in planning.

Only public `https://` hosts are fetched; loopback, private-range and `.local`/`.internal` addresses are refused.

## What makes a GOOD brief for this system

A good project brief is:

- **Concrete about the user and the outcome** — who uses it, what they do with it, what "working" means.
- **Decomposable into small, independently testable increments**, each touching a handful of files.
- **Testable by a command** — the default is `node --test test/*.test.mjs`. Any stack works but the command must be set and must actually verify behavior.
- **Additive.** The system is very good at adding files and rewriting whole files; it is bad at deleting, mass-renaming, or sweeping refactors across many files.
- **Free of external services requiring credentials.** Agents cannot access secrets or log into anything.

## What to ask the other assistant for

> Given the constraints above, turn my app idea into: (1) a one-paragraph project goal I can paste into the "What should it build?" box, (2) a suggested test command, (3) a rough sequence of small milestones, each independently testable, each touching disjoint file paths, none requiring file deletion or external credentials, and (4) an estimate of how many CLI calls that implies at 2+ calls per milestone, so I can set the budget.

## Honest limits

- Confirming a quoted source proves the page says it, **not** that it is true or current.
- Agents do not converse with each other. It is a relay with review checkpoints, not a debate.
- The intelligence is Codex's, Kimi's and Claude's. This system is the scaffolding that makes them check each other, stay in scope, and keep going.
