import fs from 'node:fs';
import path from 'node:path';
import { git } from './core.mjs';
import { run } from './process.mjs';

const unixPath = cwd => cwd.replaceAll('\\', '/').replace(/^([a-zA-Z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
export function ghSpec(args, cwd) {
  return process.platform === 'win32' ? { command: 'wsl.exe', args: ['--cd', unixPath(cwd), '--exec', 'gh', ...args] } : { command: 'gh', args };
}
function idle(engine) { if (engine.state.mode !== 'paused' || engine.running.size || engine.integrating || engine.chatting || engine.monitoring || engine.githubBusy || engine.state.recoveryRequired) throw Error('Pause, recover interruptions and drain active work first'); }
function repoName(name) { if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name) || name.endsWith('.git')) throw Error('Use owner/repository without .git'); return name; }

export function createLocal(engine, name) {
  idle(engine);
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,60}$/.test(name)) throw Error('Use a short local name containing letters, numbers, - or _');
  const root = path.join(engine.dir, 'projects'); fs.mkdirSync(root, { recursive: true });
  const repo = path.join(root, name); fs.mkdirSync(repo); // Existing paths always fail; never overwrite.
  git(repo, 'init', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n\nLocal project managed by the agent coordinator.\n`);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.env\n.env.*\n*.log\n');
  git(repo, 'add', '--', 'README.md', '.gitignore'); git(repo, '-c', 'user.name=Local Coordinator', '-c', 'user.email=coordinator@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initialize local project');
  engine.event('local_repository_created', { repo }); engine.save(); return { repo };
}
export function createProject(engine, body) {
  idle(engine);
  if (engine.state.repo) throw Error('This dashboard already has a project; use a separate data workspace for another project');
  if (typeof body.requirements !== 'string' || !body.requirements.trim() || body.requirements.length > 6000) throw Error('Describe what the project should do (at most 6000 characters)');
  if (!Array.isArray(body.testCommands) || !body.testCommands.length || body.testCommands.length > 5 || body.testCommands.some(cmd => !Array.isArray(cmd) || !cmd.length || cmd.length > 20 || cmd.some(v => typeof v !== 'string' || !v || v.length > 1000))) throw Error('Provide valid test command arrays');
  const { repo } = createLocal(engine, body.name);
  engine.configure({ repo, requirements: body.requirements, testCommands: body.testCommands });
  return { repo };
}

export async function githubTarget(engine, { name, create = false, authorizeAutoPush = false }, runner = run) {
  idle(engine); if (!engine.state.repo) throw Error('Configure the local repository first'); repoName(name);
  if (typeof create !== 'boolean' || typeof authorizeAutoPush !== 'boolean') throw Error('Invalid GitHub options');
  if (create && engine.state.githubCreationAttempt) throw Error('Repository creation already attempted; verify GitHub and connect the existing repository instead');
  engine.githubBusy = true;
  engine.state.externalOperation = 'GitHub target authorization'; engine.save();
  try {
    const spec = ghSpec(['auth', 'status'], engine.state.repo);
    const auth = await runner(spec.command, spec.args, { cwd: engine.state.repo, timeout: 15000 });
    if (auth.code !== 0 || auth.reason) throw Error('GitHub CLI authentication unavailable. Log in outside the coordinator.');
    if (create) {
      engine.state.githubCreationAttempt = { name, at: new Date().toISOString(), status: 'attempted' }; engine.save();
      const spec = ghSpec(['repo', 'create', name, '--private'], engine.state.repo);
      const result = await runner(spec.command, spec.args, { cwd: engine.state.repo, timeout: 60000 });
      if (result.code !== 0 || result.reason) throw Error('Private repository creation failed or is uncertain. No automatic retry; inspect GitHub.');
      engine.state.githubCreationAttempt.status = 'created'; engine.save();
    }
    const check = ghSpec(['repo', 'view', name, '--json', 'nameWithOwner,isPrivate'], engine.state.repo);
    const result = await runner(check.command, check.args, { cwd: engine.state.repo, timeout: 15000 });
    if (result.code !== 0 || result.reason) throw Error('Could not verify GitHub repository');
    const info = JSON.parse(result.output);
    if (!info.isPrivate || info.nameWithOwner?.toLowerCase() !== name.toLowerCase()) throw Error('Only the named private repository is supported in this version');
    const branch = `coordinator/${engine.state.id}/integration`;
    engine.state.github = { name, url: `https://github.com/${name}.git`, branch, repo: engine.state.repo, authorized: true, authorizedAt: new Date().toISOString() };
    engine.state.policy.autoPush = authorizeAutoPush;
    engine.event('github_target_authorized', { name, branch, autoPush: authorizeAutoPush }); engine.save(); return engine.state.github;
  } finally { engine.githubBusy = false; engine.state.externalOperation = null; engine.save(); }
}

export async function pushCandidate(engine, task, runner = run) {
  if (engine.githubBusy || engine.running.size || engine.integrating || engine.chatting || engine.state.recoveryRequired) throw Error('Active work or recovery prevents push');
  const target = engine.state.github, integration = engine.state.integration;
  if (!target?.authorized || task.status !== 'integrated' || !task.integrationTests?.passed || !task.review?.passed || !integration || task.integrationCommit !== integration.head) throw Error('Reviewed and tested integration plus an authorized GitHub target required');
  if (task.pushAttempt) throw Error('Push already attempted for this candidate; inspect GitHub manually');
  if (git(integration.dir, 'rev-parse', 'HEAD') !== task.integrationCommit || git(integration.dir, 'status', '--porcelain')) throw Error('Integration changed before push');
  const expected = `https://github.com/${repoName(target.name)}.git`;
  if (target.url !== expected || target.branch !== integration.branch || target.repo !== engine.state.repo) throw Error('GitHub target changed');
  engine.githubBusy = true;
  try {
    const common = git(engine.state.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const gitDir = process.platform === 'win32' ? unixPath(common) : common;
    const command = process.platform === 'win32' ? 'wsl.exe' : 'git';
    const prefix = process.platform === 'win32' ? ['--cd', unixPath(engine.state.repo), '--exec', 'git'] : [];
    const verify = await runner(command, [...prefix, '--git-dir', gitDir, 'cat-file', '-e', `${task.integrationCommit}^{commit}`], { cwd: engine.state.repo, timeout: 15000 });
    if (verify.code !== 0 || verify.reason) throw Error('GitHub push transport cannot read the candidate Git object; no push attempted');
    task.pushAttempt = { at: new Date().toISOString(), commit: task.integrationCommit, status: 'attempted', url: target.url, branch: target.branch };
    engine.state.externalOperation = 'GitHub push'; engine.save();
    const args = ['--git-dir', gitDir, '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', '--porcelain', target.url, `${task.integrationCommit}:refs/heads/${target.branch}`];
    const argv = [...prefix, ...args];
    const result = await runner(command, argv, { cwd: integration.dir, timeout: 60000 });
    task.pushAttempt.status = result.code === 0 && !result.reason ? 'pushed' : 'failed_or_uncertain';
    if (task.pushAttempt.status !== 'pushed') { engine.state.mode = 'paused'; throw Error('Push failed or is uncertain. No automatic retry; inspect GitHub.'); }
    engine.event('pushed', { task: task.id, commit: task.integrationCommit, branch: target.branch }); return task.pushAttempt;
  } finally { engine.githubBusy = false; engine.state.externalOperation = null; engine.save(); }
}
