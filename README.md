# Local Agent Coordinator — first version

A local dashboard coordinating installed Codex, Claude Code and Kimi Code CLIs. It uses existing subscription logins, not paid API fallback. No npm packages are required.

## Start

Requirements: Node.js 22+, Git, the relevant logged-in agent CLIs. On this Windows installation Claude and GitHub CLI run through WSL. Keep these installations and logins working outside the coordinator first.

Double-click `start.cmd`, or run `node server.mjs` from this folder. Open **http://127.0.0.1:4317/**. It starts paused. `Ctrl+C` pauses dispatch, drains active bounded calls and shuts down. Do not run two servers against the same data directory.

For another project, use another data directory and port, e.g. in PowerShell:

```powershell
$env:COORDINATOR_DATA = 'C:/Projects/coordinator-state/my-other-project'
$env:PORT = '4318'
node server.mjs
```

Each dashboard controls one repository. The default state directory is `data/` beside this README. A second project gets a separate state directory. Do not delete state/worktrees to clear a failed task: inspect the preserved checkpoint first.

## Use the dashboard

1. **Project:** choose **New project** to create and configure a local Git repository in one step, or **Existing repository** to use a clean repository with an initial commit. Enter the goal. The default test command expects Node tests in `test/*.test.mjs`; change it for your stack. Only use trusted test commands. The YouTube checkout is explicitly excluded.
2. **Work:** use **Plan and build** to describe the next feature (or leave the message blank to use the project goal). The lead drafts 1–3 small milestones, then a different available agent reviews the plan once. If it passes validation, has enough remaining budget, and still matches the project state, the coordinator queues the milestones sequentially and starts work automatically. It stops for essential clarification, a rejected plan, or a failed check; it does not loop until the reviewer agrees. You can choose **Show me a draft first**, or add tasks manually with acceptance criteria and owned paths. Project-wide decisions are available in subsequent handoffs; they do not interrupt an active CLI prompt.

   Planning includes a bounded tracked-file list and up to six source/test excerpts (6,000 content characters total). Common secret/configuration paths and untracked files are excluded, and known secret patterns are redacted. Excerpts are supplied to the chosen model providers as project context. After integration, the next plan sees the integration worktree rather than the untouched original checkout. This is a partial view, not a complete code audit.
3. **Chat:** while paused and drained, choose an available agent and send a message. Replies arrive when the bounded call finishes. Conversations are read-only and saved; recent exchanges, requirements and relevant task handoffs provide context. Use a decision/task to turn a discussion into instructions for future execution. There is no concurrent group-chat broadcast.
4. **Team activity / History:** Work shows actual handoffs, test outcomes, review findings, integration commits and your decisions in a readable timeline. History retains detailed attempts, measured CLI usage when reported, explicitly labeled estimates and checkpoints. Kimi's observed stream did not provide usage, so it is unavailable, never reported as zero.
5. **GitHub (optional):** authorize the exact private `owner/repository` target. Choose creation or connection. You may authorize automatic pushing once at setup. Creation is attempted once. Each approved candidate may integrate once and push once, without force, to a dedicated coordinator branch. The default branch and source checkout are not advanced.

Use Pause to stop new dispatch, not to suspend a process mid-write. An active call finishes or reaches its timeout before ownership is released. Resume continues eligible queued work. Checkpoints contain task ownership, requirements, acceptance criteria, decisions, commits, tests and concise handoffs.

## Execution contract

- Default: one builder then a **different provider** reviews the committed candidate in a separate detached worktree. Review requires an explicit `REVIEW: PASS` line, configured tests must pass, and content must remain unchanged during tests. A review rejection stops for inspection; no automatic debate loop.
- Successful review integrates automatically by default. Combined tests run on a dedicated integration branch before a merge commit. Integration failure/conflict preserves the worktree and stops that attempt. No reset, clean, force push, merge abort, checkout overwrite, or public deployment is implemented.
- The source checkout must be clean at setup. Only Git worktree/branch metadata is added there; builds and integration occur in separate directories.
- All builders propose complete replacement files. The coordinator validates every destination and scope before writing, testing and committing. Agents do not need permission to directly edit files. This version supports at most 10 proposed files per task attempt, no proposed file deletions, and bounded response size. Break larger changes into milestones.
- Codex uses its read-only sandbox. User configuration is ignored for model/provider selection, while subscription authentication remains in the CLI. Claude uses subscription login, plan mode and only Read/Glob/Grep tools. It has no shell or delegation tools in this adapter.
- **Kimi prompt mode automatically handles permissions**, so the coordinator supplies a read-only tool profile with only Read/Glob/Grep. No direct Kimi shell, edit or delegation tool is exposed. This is not an OS security boundary for malicious repository content; use trusted projects and local accounts.
- Authentication/provider checks run before each invocation. Exposed API credential environment variables are removed; there is no purchase, API-key setup or paid fallback path. No credentials are copied into state. Common secret patterns in CLI output are redacted; do not put credentials in task text or project memory.
- Quota/auth failures mark the provider unavailable. Eligible tasks can move to another provider with the existing worktree and a short checkpoint, within attempt limits. When no independent provider remains, work waits. Recovery requires explicit re-enabling after checking availability; there is no quota polling or scheduled retry.
- Interrupted/uncertain agent, chat or test termination gates all new work. Verify old processes stopped and inspect the checkpoint before confirming recovery. A stale server lock after a crash must likewise be inspected before manual removal. WSL model calls also have a Linux-side timeout; uncertain termination is not treated as a safe handoff.

## Limits

Defaults: **12 total coordinator CLI attempts**, **2 attempts per task stage**, **1 concurrent task**, **20 tasks**, **5 minutes per agent call**, **1 minute per test command**, **2 MB captured output**, **18,000 characters of coordinator context**. Chat shares the call budget. CLI preflight failures consume an attempt conservatively. Limits can be adjusted only while paused and drained, within validated maximums.

These are coordinator-invocation limits, not a promise to meter or cap every model/tool request inside a third-party CLI. Exact provider quota balances/reset times are not universally available. Token estimates use characters/4 and exclude CLI system context and tool calls. Routing uses recorded role-specific completion/failure outcomes only; it is not model training or a quality ranking.

Concurrency above one requires every active task to be explicitly independent with disjoint owned paths. Dependencies must already be integrated. Lead-generated plans are sequential. Each planning request covers the next 1–3 milestones, not a complete enterprise program: there is no recursive replanning or automatic budget expansion. Automatic planning requires enough budget for the independent plan review plus an initial build and review for every milestone; repairs may require additional remaining attempts. Pressing Pause during planning prevents automatic start after review.

## Validation and acceptance

Run `node --test test/*.test.mjs` (or `npm test`). Test fixtures are disposable Git repositories under `data/test-fixtures/`; tests never call paid models or GitHub. `node doctor.mjs` performs version/auth checks without model calls. `node smoke.mjs codex` and `node smoke.mjs kimi` are optional **live subscription calls**; do not run repeatedly. The smoke utility deliberately excludes Claude.

See `VERIFICATION.md` for the actual live/simulated verification boundary.

`node planning-smoke.mjs` is an optional live two-call check of lead planning and independent plan review. It uses a disposable repository and verifies that one milestone is queued and the scheduler is enabled, then pauses before any builders are dispatched.

The first version is accepted when:

- A new repo can be created and configured, or a clean existing repo configured.
- Start/Pause/Resume preserve ownership and cannot overlap integration/chat; crash recovery starts paused.
- A scoped build passes real commands, receives independent review and integrates without changing source HEAD.
- Test mutations, candidate tampering, failed review and out-of-scope edits cannot pass integration gates.
- Quota/auth failures checkpoint and reassign or wait, with no retry storm; simulated Claude recovery resumes only after explicit enable.
- Call, attempt and concurrency caps hold across restart; uncertain termination requires recovery acknowledgment.
- GitHub creation/push require an authorized private target and each candidate is attempted at most once.
- Chat is serialized, durable and shares the usage budget; browser actions require a local session token and matching origin.

## Layout

```text
server.mjs              Local HTTP server, session token, origin checks, single-writer lock
lib/core.mjs            Durable scheduler, worktrees, tests, review, integration and chat
lib/adapters.mjs        Verified CLI argv, login checks and result/usage parsing
lib/process.mjs         Bounded process handling, environment hygiene and redaction
lib/repositories.mjs    New local repos and one-attempt private GitHub operations
profiles/              Kimi read-only tool profile
public/index.html      Project / Work / Chat / History dashboard
test/                  Offline regression and integration tests
data/state.json        Atomic durable checkpoint (not source-controlled)
data/projects/         Repositories created from the dashboard
data/worktrees/        Builder, reviewer and integration worktrees
```

Export portable project memory from Work. Full CLI transcripts are not repeatedly broadcast. Keep the state directory outside repositories agents may edit. This is a local single-user prototype, not a multi-user enterprise control plane.
