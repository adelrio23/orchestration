# Quick start

Get the coordinator running before changing any advanced settings.

## Windows

1. Install **Node.js 22 or newer** and **Git**.
2. Install and sign in to at least two supported agent CLIs: Codex, Claude Code, or Kimi Code.
3. Double-click `start.cmd`.
4. Your browser opens to <http://127.0.0.1:4317/>.
5. In **Project**, select an existing clean Git repository or create a new project.
6. Enter one concrete goal and keep the default test command only if the project uses Node's test runner.
7. Click **Plan and build**. Keep the terminal window open.

The coordinator starts paused and does not dispatch work merely because the dashboard opened.

## Check the installation

Run:

```powershell
node doctor.mjs
```

Fix any failed Node, Git, CLI, or login check before starting autonomous work. A single available provider is insufficient because a provider cannot independently review its own work.

## First safe demo

Use a disposable repository and a small goal such as:

> Create a static one-page channel landing page with a title, description, and three video cards. Add tests for any JavaScript behavior.

Start with **Show me a draft first**. Confirm the proposed milestones and file ownership before enabling unattended execution.

## If it does not open

- Confirm the terminal prints `Local coordinator: http://127.0.0.1:4317`.
- Open that address manually.
- If port 4317 is busy, set another port before starting:
  ```powershell
  $env:PORT = '4318'
  node server.mjs
  ```
- If a stale-lock message appears, read it before deleting anything; the coordinator normally clears locks whose process is no longer running.

## Stop safely

Press **Pause**, allow active bounded calls to drain, then press `Ctrl+C` in the terminal. Do not delete worktrees or state to interrupt a running task.
