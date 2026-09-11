import { discover, preflight } from './adapters.mjs';
import { run, safeEnv } from './process.mjs';
import { ghSpec } from './repositories.mjs';

// Readiness reporting only. Nothing here makes a model call, changes state or
// spends the call budget; every command is a local version/auth query.

const windows = () => process.platform === 'win32';
const FIX = {
  codex: 'Install Codex, then run: codex login — choose the ChatGPT option. An API key is refused.',
  kimi: 'Install Kimi Code, then run: kimi login — the managed kimi-code provider is required.',
  claude: windows()
    ? 'Claude runs through WSL here. In PowerShell run: wsl -e bash -lc "claude" and sign in with your Claude subscription.'
    : 'Run: claude and sign in with your Claude subscription.'
};
const GH_FIX = windows()
  ? 'The coordinator uses the GitHub CLI inside WSL. In PowerShell run: wsl -e bash -lc "gh auth login"'
  : 'Run: gh auth login';

export async function agentReadiness(cwd, runner = run) {
  const adapters = discover();
  const report = [];
  for (const [name, config] of Object.entries(adapters)) {
    const versionArgs = config.wsl ? ['--exec', 'claude', '--version'] : ['--version'];
    const version = await runner(config.command, versionArgs, { cwd, timeout: 15000, env: safeEnv() });
    if (version.code !== 0 || version.reason) {
      report.push({ name, installed: false, ready: false, detail: 'Not installed, or not on PATH.', fix: FIX[name] });
      continue;
    }
    const installed = { name, installed: true, version: version.output.trim().split(/\r?\n/)[0] };
    try {
      await preflight(name, config, cwd, runner);
      report.push({ ...installed, ready: true, detail: 'Signed in and ready.' });
    } catch (error) {
      report.push({ ...installed, ready: false, detail: error.message, fix: FIX[name] });
    }
  }
  return report;
}

export async function githubReadiness(cwd, runner = run) {
  const spec = ghSpec(['auth', 'status'], cwd);
  const result = await runner(spec.command, spec.args, { cwd, timeout: 15000, env: safeEnv() });
  if (result.code !== 0 || result.reason) return { ready: false, user: null, detail: 'GitHub CLI is not installed or not signed in.', fix: GH_FIX };
  const user = /Logged in to \S+ (?:account )?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)/.exec(result.output)?.[1] || null;
  return { ready: true, user, detail: user ? `Signed in as ${user}.` : 'Signed in.' };
}

// Lists every repository the signed-in account can push to. The coordinator
// only accepts a private target, but hiding the public ones made the list look
// broken; they are returned and labelled instead.
export async function listRepositories(cwd, runner = run) {
  const spec = ghSpec(['repo', 'list', '--json', 'nameWithOwner,isPrivate,updatedAt', '--limit', '200'], cwd);
  const result = await runner(spec.command, spec.args, { cwd, timeout: 30000, env: safeEnv() });
  if (result.code !== 0 || result.reason) throw Error('Could not list your repositories. Sign in to the GitHub CLI first.');
  let list;
  try { list = JSON.parse(result.output); } catch { throw Error('Unexpected GitHub CLI output while listing repositories'); }
  if (!Array.isArray(list)) throw Error('Unexpected GitHub CLI output while listing repositories');
  return list
    .filter(repo => typeof repo?.nameWithOwner === 'string')
    .map(repo => ({
      name: repo.nameWithOwner,
      isPrivate: !!repo.isPrivate,
      updatedAt: repo.updatedAt || null,
      eligible: !!repo.isPrivate,
      reason: repo.isPrivate ? null : 'Public. The coordinator only pushes to a private repository — make it private to use it.'
    }))
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.name.localeCompare(b.name));
}

// Kept for callers that only want targets which can actually be authorized.
export async function privateRepositories(cwd, runner = run) {
  return (await listRepositories(cwd, runner)).filter(repo => repo.eligible).map(repo => repo.name);
}

export async function setupStatus(engine, runner = run) {
  const cwd = engine.state.repo || process.cwd();
  const agents = await agentReadiness(cwd, runner);
  const github = await githubReadiness(cwd, runner).catch(error => ({ ready: false, user: null, detail: error.message, fix: GH_FIX }));
  const usable = agents.filter(agent => agent.ready).map(agent => agent.name);
  return {
    node: process.version,
    agents,
    github,
    project: engine.state.repo
      ? { ready: true, detail: engine.state.repo }
      : { ready: false, detail: 'No project selected yet.', fix: 'Create or choose a project in this panel.' },
    target: engine.state.github
      ? { ready: true, detail: `${engine.state.github.name} → ${engine.state.github.branch}` }
      : { ready: false, detail: 'No GitHub target authorized. The project still builds and tests locally.', fix: 'Connect a private repository below.' },
    // A build and an independent review need two different providers.
    usableAgents: usable,
    canBuild: usable.length >= 1,
    canReview: usable.length >= 2
  };
}
