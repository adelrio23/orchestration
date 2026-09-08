# Verification — 7 September 2026, America/Chicago

## Result

**44 offline tests passed**, including real disposable Git worktree/merge tests. A separate **live two-agent workflow passed** using the installed subscription CLIs: Codex builder → tests → Kimi reviewer → combined tests → local integration. A further live two-call planning check passed. No GitHub mutation or Claude model call was made.

## Automated planning validation

The lead proposed one milestone from a fresh synthetic addition fixture, and Kimi independently approved its scope and acceptance criteria. The coordinator queued it and entered running mode using exactly two CLI calls. The smoke script then paused before builder dispatch; this planning check did not itself execute the build. The source checkout remained unchanged. Evidence: `data/verification/planning-smoke.json`.

The final regression run passed all 40 tests, with no failures or skips (`data/verification/planning-tests.tap`). Planning coverage includes independent approval, rejection and quota stops, essential questions, invalid scopes, stale source context, atomic queueing, call budgets, pause during review, persistent in-flight state, bounded source excerpts, and using the latest integrated files for subsequent milestones. Planning produces at most three sequential milestones and does not repeatedly re-plan after rejection.

## Installed interfaces verified

| Component | Evidence |
|---|---|
| Codex | Installed `codex-cli 0.153.4`; `exec --help` and ChatGPT login checked. Binary discovery uses the installed desktop bin directory. |
| Kimi | Installed `0.41.0`; CLI help, `doctor`, managed OAuth provider and actual stream format checked. |
| Claude | WSL Claude Code `2.1.252`; help and subscription authentication checked without a model call. Disabled by default because usage was reported exhausted. |
| GitHub CLI | WSL `gh repo create --help` verified and existing authentication check returned success. |

Actual CLI testing caught two differences from initial assumptions: Kimi rejects `--plan` together with `--prompt`, and its stream uses `role: assistant` with string `content`. Both are handled in the final adapter. An initial direct-write Codex workflow was blocked by read-only permissions; the final workflow deliberately uses read-only file proposals for every builder, applied by the coordinator after validation. No permission bypass was used.

## Live workflow

- Fixture: `data/live-demo-1788825603251/` (disposable, separate from the user's source projects).
- Task: implement finite-number addition in one file, with prewritten positive/negative/fractional and invalid-input tests.
- Codex proposed the implementation; scoped proposals were applied by the coordinator.
- Tests passed before committing; Kimi independently reviewed and returned PASS.
- Combined tests passed; integration commit: `6a1e2f1b99eae1308779240d8ee07cbbb212b0ef`.
- Exactly **2 model CLI invocations** in the successful workflow. Codex: about 17.3 seconds; Kimi: about 45.9 seconds.
- Codex reported **30,894 input tokens**, including **23,552 cached input tokens**, and **231 output tokens**. These are the CLI's reported usage fields, not subscription balances or a dollar charge.
- Kimi did not report token usage in the observed stream; recorded as **unavailable**.
- A read-only WSL Git check successfully resolved this Windows-created integration object using the translated common Git directory. This verifies the metadata transport used before a GitHub push, not a live push.

Detailed local evidence: `data/verification/live-workflow.json`, `codex-smoke.json`, `kimi-smoke.json`, and `tests.tap`. These runtime records stay outside source control.

## Regression coverage

Build/review/integration, source-checkout preservation, quota handoff, simulated Claude recovery, auth failure, persistent caps, pause/drain/resume, independent concurrency, dependencies, scope violations, test mutation detection, failed tests/review, candidate tampering, integration locking, crash recovery, uncertain termination gates, adapter permissions, measured/missing usage parsing, automatic integration once, serialized durable chat, one-step new projects, existing repositories, safe local creation, private GitHub target authorization, creation/push once-only behavior, failed push checkpoints, proposal path validation, configuration-race prevention, merge-conflict preservation, process limits, redaction, local session-token and origin checks.

The dashboard was opened and inspected in the Codex browser. New and Existing project modes and the separate Chat panel were checked. The responsive layout was checked in the narrow app panel. An independent code reviewer identified content-fingerprint, integration-race, termination-recovery, worktree-transport and configuration-race issues; those were fixed and covered by regression tests.

## Not claimed as verified

- **Claude model execution:** not run. After its quota recovers, explicitly enable it and make one bounded chat/review smoke call. Help/auth checks do not prove model access.
- **Live GitHub creation/push:** not performed because no destination repository has been chosen for publication. Command interfaces, authentication, translated Git metadata and simulated success/failure gates are verified.
- **Remaining quota/reset monitoring:** Codex measured limits and reset timestamps are verified through its installed app-server. Kimi/Claude percentages are unavailable; bounded recovery calls are tested with simulated quota/recovery responses, not a live quota-reset cycle.
- **Enterprise readiness or large autonomous project planning:** not established. Automatic planning is bounded to one to three small milestones in a single-user, one-project-per-workspace coordinator. Larger applications need further validation.
- **Hard per-provider internal request budgets:** the app caps invocations, time, output and workload; third-party CLI internal model/tool requests are not universally measurable or controllable.

## Model and recovery upgrade

All 44 regression tests passed (`data/verification/upgrade-tests.tap`). Installed Codex app-server read-only calls returned six available model IDs and subscription quota windows. The restarted HTTP server returned that catalog and live windows with zero model calls. It detected an exhausted Codex window and blocked that provider. Project discovery returned the permanent `Documents/Codex/yt-autonomous-growth` worktree and linked worktrees.

Each adapter passes an explicit configured model; settings are persisted and validated. Requested model and reported model identity are separate fields. Missing reported identity is not inferred. Tests cover pause during a recovery call, cooldown, three-attempt cap, measured recovery, disabled-provider preservation, and unavailable status on read failure. Real Claude help confirmed its model flag; no new Claude inference or live GitHub mutation was made.

Codex uses the documented `model/list` and `account/rateLimits/read` endpoints: https://learn.chatgpt.com/docs/app-server . Status checks do not create inference turns. Kimi/Claude recovery calls count toward the normal invocation budget, require pending work in running mode, and never bypass authentication or disabled-provider controls.
