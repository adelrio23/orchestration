# Local Agent Coordinator — first version

A local dashboard coordinating installed Codex, Claude Code and Kimi Code CLIs. It uses existing subscription logins, not paid API fallback. No npm packages are required.

## Start

Requirements: Node.js 22+, Git, the relevant logged-in agent CLIs. On this Windows installation Claude and GitHub CLI run through WSL. Keep these installations and logins working outside the coordinator first.

Double-click `start.cmd`, or run `node server.mjs` from this folder. It opens **http://127.0.0.1:4317/** in your browser by itself; set `COORDINATOR_NO_OPEN=1` if you would rather it did not, and the address is printed either way. It starts paused. `Ctrl+C` pauses dispatch, drains active bounded calls and shuts down. Do not run two servers against the same data directory.

For another project, use another data directory and port, e.g. in PowerShell:

```powershell
$env:COORDINATOR_DATA = 'C:/Projects/coordinator-state/my-other-project'
$env:PORT = '4318'
node server.mjs
```

Each dashboard controls one repository. The default state directory is `data/` beside this README. A second project gets a separate state directory. Do not delete state/worktrees to clear a failed task: inspect the preserved checkpoint first.

## Use the dashboard

1. **Project:** choose **New project** to create and configure a local Git repository in one step, or **Existing repository** to use a clean repository with an initial commit. Enter the goal. The default test command expects Node tests in `test/*.test.mjs`; change it for your stack. Only use trusted test commands. The picker includes local repositories and linked Git worktrees, including projects outside common folders. Selecting a folder does not start agents.
2. **Work:** use **Plan and build** to describe the next feature (or leave the message blank to use the project goal). The lead drafts 1–3 small milestones, then a different available agent reviews the plan once. If it passes validation, has enough remaining budget, and still matches the project state, the coordinator queues the milestones sequentially and starts work automatically. It stops for essential clarification, a rejected plan, or a failed check; it does not loop until the reviewer agrees. You can choose **Show me a draft first**, or add tasks manually with acceptance criteria and owned paths. Project-wide decisions are available in subsequent handoffs; they do not interrupt an active CLI prompt.

   Planning includes a bounded tracked-file list and up to six source/test excerpts (6,000 content characters total). Common secret/configuration paths and untracked files are excluded, and known secret patterns are redacted. Excerpts are supplied to the chosen model providers as project context. After integration, the next plan sees the integration worktree rather than the untouched original checkout. This is a partial view, not a complete code audit.
3. **Market research (cited):** ask an agent to **search the web** — this is the one role given web tools (`--search` for Codex, `WebSearch,WebFetch` for Claude, a researcher profile for Kimi), and it has no file access while doing it. It must return every claim with a source URL and a verbatim quote. The coordinator then **re-fetches each cited page itself and discards any finding whose quote is not actually there**, so a fabricated URL or an invented quote is dropped rather than believed. Confirming a quote proves the page says it, not that it is true or current. You can also list up to 8 `https://` sources. The coordinator fetches each one, strips scripts and markup, and stores the verbatim excerpt with its URL and fetch time. Agent search costs one call; reading sources you list yourself costs none. An independent agent then reviews the evidence in one bounded call and must end with `REVIEW: PASS` or `REVIEW: FAIL`. Only passed evidence reaches the lead when planning, supplied as CITED EVIDENCE with an instruction to cite a URL or state that the sources do not support the claim. Only public `https://` hosts are fetched: loopback, link-local, private-range and `.local`/`.internal` addresses are refused before any request, redirects are not followed, and URL credentials are rejected. This retrieves and cites sources; it does not verify that they are true or complete.
4. **Chat:** while paused and drained, choose an available agent and send a message. Replies arrive when the bounded call finishes. Conversations are read-only and saved; recent exchanges, requirements and relevant task handoffs provide context. Use a decision/task to turn a discussion into instructions for future execution. There is no concurrent group-chat broadcast.
5. **Team activity / History:** Work shows actual handoffs, test outcomes, review findings, integration commits and your decisions in a readable timeline. History retains detailed attempts, measured CLI usage when reported, explicitly labeled estimates and checkpoints. Kimi's observed stream did not provide usage, so it is unavailable, never reported as zero.
6. **GitHub (optional):** authorize the exact private `owner/repository` target. Choose creation or connection. You may authorize automatic pushing once at setup. Creation is attempted once. Each approved candidate may integrate once and push once, without force, to a dedicated coordinator branch. The default branch and source checkout are not advanced.

Use Pause to stop new dispatch, not to suspend a process mid-write. An active call finishes or reaches its timeout before ownership is released. Resume continues eligible queued work. Checkpoints contain task ownership, requirements, acceptance criteria, decisions, commits, tests and concise handoffs.

## Execution contract

- Default: one builder then a **different provider** reviews the committed candidate in a separate detached worktree. Review requires an explicit `REVIEW: PASS` line, configured tests must pass, and content must remain unchanged during tests.
- The lead assigns each milestone a short **role** ("backend", "tests", "ui"); the builder is told it holds that role for the milestone.
- A **rejected review starts a bounded repair round** rather than stopping: the reviewer's findings are handed back to the builder as the next brief, and the reviewed candidate becomes the new base, so each round builds on the last. Rounds are capped by `maxRepairRounds` (default 2) and are refused when the remaining call budget cannot fund another build and review. Exhausting the rounds stops the task for inspection. This is a bounded repair loop, not an open debate.
- Builders receive the **recent handoff chain** (up to six entries), the failed review's findings, the current repair round, and their remaining call and file budget, so they can scope work to what is actually left.
- Successful review integrates automatically by default. Combined tests run on a dedicated integration branch before a merge commit. Integration failure/conflict preserves the worktree and stops that attempt. No reset, clean, force push, merge abort, checkout overwrite, or public deployment is implemented.
- The source checkout must be clean at setup. Only Git worktree/branch metadata is added there; builds and integration occur in separate directories.
- All builders propose complete replacement files. The coordinator validates every destination and scope before writing, testing and committing. Agents do not need permission to directly edit files. Proposed files per attempt are capped by `maxFiles` (default 40, maximum 60); file deletions are never proposed and response size stays bounded. Break larger changes into milestones.
- Codex uses its read-only sandbox. User configuration is ignored for model/provider selection, while subscription authentication remains in the CLI. Claude uses subscription login, plan mode and only Read/Glob/Grep tools. It has no shell or delegation tools in this adapter.
- **Kimi prompt mode automatically handles permissions**, so the coordinator supplies a read-only tool profile with only Read/Glob/Grep. No direct Kimi shell, edit or delegation tool is exposed. This is not an OS security boundary for malicious repository content; use trusted projects and local accounts.
- Authentication/provider checks run before each invocation. Exposed API credential environment variables are removed; there is no purchase, API-key setup or paid fallback path. No credentials are copied into state. Common secret patterns in CLI output are redacted; do not put credentials in task text or project memory.
- Quota/auth failures mark the provider unavailable. Eligible tasks can move to another provider with the existing worktree and a short checkpoint, within attempt limits. When no independent provider remains, work waits. Codex subscription limits are read every five minutes through its app-server without model turns. Measured exhaustion blocks dispatch; measured recovery requeues waiting work without overriding Pause or enabling disabled providers. Kimi/Claude quota recovery uses at most three small calls with 30/60/120-minute backoff while enabled and work is pending/running; calls count toward the shared budget. Their remaining percentages are unavailable. Authentication failures require manual attention. The dashboard server must remain open.
- Interrupted/uncertain agent, chat or test termination gates all new work. Verify old processes stopped and inspect the checkpoint before confirming recovery. A stale server lock after a crash must likewise be inspected before manual removal. WSL model calls also have a Linux-side timeout; uncertain termination is not treated as a safe handoff.

## Running unattended

Set **Keep going without me** in the automatic action policy. The lead plans, an independent agent reviews the plan, milestones build, are reviewed and integrate, and then it plans again — with no approval from you at any step. Every safety property still holds: agents stay read-only and propose files the coordinator validates, a different provider reviews each candidate, your test commands must pass, and a rejected review starts a bounded repair round.

It stops by itself, pausing and stating why, when the call budget cannot fund another round, when the planning round cap is reached (`maxPlanningRounds`, default 6), when the lead needs an answer from you, when the plan review rejects a plan, or when the lead reports no further milestones. If a provider is quota-blocked it waits rather than stopping, and resumes when the provider returns.

Autonomy is opt-in and off by default.

**Quota and availability.** Codex's rate limits are read every five minutes with no model turns, and the reported reset time is stored, so a blocked provider shows when it is expected back and queued work resumes automatically. Kimi and Claude report no percentage, so their return is probed with backoff; once a known reset time passes, the attempt allowance is restored rather than the provider being abandoned.

**Running the tests yourself.** The Project panel runs your configured test commands on this machine against the project checkout, with no model call and no call budget, so you can confirm the commands work before agents depend on them.

## Limits

Defaults: **60 total coordinator CLI attempts**, **6 planning rounds**, **2 attempts per task stage**, **2 repair rounds per task**, **1 concurrent task**, **100 tasks**, **40 proposed files per attempt**, **8 milestones per plan**, **5 minutes per agent call**, **1 minute per test command**, **2 MB captured output**, **40,000 characters of coordinator context**. Chat shares the call budget. CLI preflight failures consume an attempt conservatively. Limits can be adjusted only while paused and drained, within validated maximums.

These are coordinator-invocation limits, not a promise to meter or cap every model/tool request inside a third-party CLI. Exact provider quota balances/reset times are not universally available. Token estimates use characters/4 and exclude CLI system context and tool calls. Routing uses recorded role-specific completion/failure outcomes only; it is not model training or a quality ranking.

Concurrency above one requires every active task to be explicitly independent with disjoint owned paths. Dependencies must already be integrated. Lead-generated plans are sequential. Each planning request covers the next `maxMilestones` milestones or fewer (default 8, maximum 12), not a complete enterprise program: there is no recursive replanning or automatic budget expansion. Automatic planning requires enough budget for the independent plan review plus an initial build and review for every milestone; repairs may require additional remaining attempts. Pressing Pause during planning prevents automatic start after review.

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

## Model controls

Work → Models & availability configures explicit coding and planning/chat/review model IDs for each provider. Codex choices come from its installed app-server model catalog; custom IDs may be entered. Defaults are GPT-6 Astra, Kimi Code, and the Claude sonnet alias. History distinguishes requested model from provider-reported model IDs; missing reported IDs remain unavailable. Model availability may differ by subscription. Model settings change only while paused and drained.
## Routine access and model checks

Project reads are non-interactive within the adapter's existing restrictions. Codex keeps its read-only sandbox and uses a never-prompt approval policy: actions requiring broader permission fail instead of hanging. Claude allows its project Read rule and Glob/Grep tools; shell, file modification and delegation tools remain unavailable. The coordinator applies validated proposals and runs configured tests itself. No login, OS access, or sandbox override is automatically granted.

Work → Test selected provider’s saved models performs at most two live subscription calls in a synthetic Git repository. It checks a file proposal against executable tests and requires the review model to reject defective code. Results are keyed by provider and saved model choices. A passing result is a small protocol/behavior check, not a claim of universal reliability. Quota-blocked or budget-blocked checks are marked pending and consume no inference calls; use the button again after recovery. This avoids automatic retry loops.
