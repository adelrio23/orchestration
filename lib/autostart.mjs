import fs from 'node:fs';
import path from 'node:path';
import { createProject, githubTarget, ghSpec } from './repositories.mjs';
import { git } from './core.mjs';
import { run } from './process.mjs';
import { githubReadiness, listRepositories } from './setup.mjs';

// One call that does every setup step the operator would otherwise click
// through: create the project, get a private GitHub target, turn on automatic
// integration, pushing and continuous planning, then plan and start.
// Anything optional that fails is reported and the run continues without it;
// only a failure that would leave nothing running stops this.

export async function launchAutonomous(engine, body, deps = {}) {
  const { readiness = githubReadiness, repositories = listRepositories, target = githubTarget } = deps;
  const notes = [];

  if (!engine.state.repo) {
    createProject(engine, {
      name: body.name,
      requirements: body.requirements,
      testCommands: body.testCommands?.length ? body.testCommands : [['node', '--test', 'test/*.test.mjs']]
    });
    notes.push(`Created the project repository at ${engine.state.repo}.`);
  } else notes.push(`Using the existing project at ${engine.state.repo}.`);

  // GitHub is optional: without it the project still builds, tests and
  // integrates locally, so a failure here must not stop the run.
  let pushing = false;
  if (engine.state.github) { pushing = true; notes.push(`Already pushing to ${engine.state.github.name}.`); }
  else if (body.github === false) notes.push('GitHub was not requested; work stays local.');
  else {
    try {
      const auth = await readiness(engine.state.repo);
      if (!auth.ready || !auth.user) throw Error(auth.detail || 'the GitHub CLI is not signed in');
      const wanted = `${auth.user}/${body.name}`;
      const existing = (await repositories(engine.state.repo)).find(repo => repo.name.toLowerCase() === wanted.toLowerCase());
      if (existing && !existing.eligible) throw Error(`${wanted} already exists and is public; the coordinator only pushes to a private repository`);
      await target(engine, { name: wanted, create: !existing, authorizeAutoPush: true });
      pushing = true;
      notes.push(`${existing ? 'Connected to' : 'Created'} the private repository ${wanted}; each integrated milestone pushes to ${engine.state.github.branch}.`);
    } catch (error) {
      notes.push(`Continuing without GitHub: ${error.message}. Work still builds, tests and integrates locally.`);
    }
  }

  engine.setPolicy({ autoIntegrate: true, autoPush: pushing, autoPlan: true });
  notes.push(pushing ? 'Integration and pushing are automatic; no approvals.' : 'Integration is automatic; pushing stays off until a GitHub target exists.');

  const available = Object.keys(engine.state.providers).filter(name => engine.state.providers[name].enabled && !engine.state.providers[name].blocked);
  if (available.length < 2) throw Error(`Two signed-in agents are required so one can review the other's work independently; ${available.length === 1 ? `only ${available[0]} is ready` : 'none are ready'}. Run the setup check.`);

  const record = await engine.chat({
    provider: available[0], intent: 'plan', autoStart: true,
    message: body.requirements || 'Plan the next milestones that move the project toward its goal.'
  });
  notes.push(`${available[0]} is planning; ${available.slice(1).join(' and ')} will review independently.`);

  return { notes, pushing, github: engine.state.github?.name || null, providers: available, planStatus: record?.plan?.status || record?.status || 'unknown', planError: record?.planError || null };
}

// Clones a repository straight from the signed-in GitHub account and configures
// it as the project, so an existing project never has to already be on disk or
// have its path typed by hand.
export async function cloneFromGitHub(engine, body, deps = {}) {
  const { runner = run, repositories = listRepositories, authorizeTarget = githubTarget } = deps;
  if (engine.state.repo) throw Error('This dashboard already has a project; use a separate data workspace for another one');
  if (typeof body.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(body.name) || body.name.endsWith('.git')) throw Error('Choose a repository as owner/repository');

  const known = await repositories(process.cwd());
  const match = known.find(repo => repo.name.toLowerCase() === body.name.toLowerCase());
  if (!match) throw Error(`${body.name} is not in your GitHub account`);

  const root = path.join(engine.dir, 'projects');
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, body.name.split('/')[1]);

  if (fs.existsSync(path.join(target, '.git'))) {
    // A previous attempt already downloaded it; reuse rather than dead-end.
    engine.event('github_project_reused', { name: body.name, repo: target });
  } else {
    if (fs.existsSync(target)) throw Error(`${target} already exists but is not a repository; remove it and try again`);
    // core.autocrlf rewrites line endings on checkout, which makes a freshly
    // cloned repository look modified in every file. Clone without it.
    const spec = ghSpec(['repo', 'clone', body.name, toCloneTarget(target), '--', '-c', 'core.autocrlf=false'], root);
    const result = await runner(spec.command, spec.args, { cwd: root, timeout: 300000 });
    if (result.code !== 0 || result.reason) throw Error(`Could not clone ${body.name}. ${String(result.output || '').slice(-300)}`);
    if (!fs.existsSync(path.join(target, '.git'))) throw Error(`Clone of ${body.name} did not produce a repository`);
  }

  // A download is disposable, so a checkout that still differs from the commit
  // is reset to match rather than handed to the user as "repository not clean".
  try {
    git(target, 'config', 'core.autocrlf', 'false');
    if (git(target, 'status', '--porcelain')) { git(target, 'reset', '--hard'); git(target, 'clean', '-fd'); }
  } catch {}

  const detected = body.testCommands?.length ? { testCommands: body.testCommands, integrationTestCommands: null, reason: 'supplied manually' } : detectTestCommands(target);
  engine.configure({ repo: target, requirements: body.requirements, testCommands: detected.testCommands });
  if (detected.integrationTestCommands?.length) engine.setTestCommands(detected);
  if (match.isPrivate) {
    try {
      await authorizeTarget(engine, { name: body.name, create: false, authorizeAutoPush: true });
      engine.setPolicy({ autoIntegrate: true, autoPush: true, autoPlan: true });
      engine.event('github_source_auto_authorized', { name: body.name });
    } catch (error) { engine.event('github_source_auto_authorize_failed', { name: body.name, reason: String(error.message).slice(-300) }); }
  }
  engine.event('github_project_cloned', { name: body.name, repo: target });
  engine.event('test_commands_detected', { reason: detected.reason, commands: detected.testCommands });
  engine.save();
  return { repo: target, name: body.name, private: match.isPrivate, tests: detected, githubAuthorized: engine.state.github?.name === body.name };
}

export function detectTestCommands(repo) {
  const windows = process.platform === 'win32', exists = name => fs.existsSync(path.join(repo, name));
  if (exists('scripts/test.sh')) {
    const full = [[...(windows ? ['wsl.exe', 'bash'] : ['bash']), './scripts/test.sh']];
    if (exists('tests/offline') || exists('tests/offline.py')) return { testCommands: [[...(windows ? ['wsl.exe', 'env', 'PYTHONUTF8=1', 'python3'] : ['python3']), '-m', 'tests.offline', 'discover', '-s', 'tests', '-t', '.']], integrationTestCommands: full, reason: 'Python offline suite plus scripts/test.sh' };
    return { testCommands: full, integrationTestCommands: null, reason: 'scripts/test.sh' };
  }
  if (exists('package.json')) try { const pkg=JSON.parse(fs.readFileSync(path.join(repo,'package.json'),'utf8')); if(pkg.scripts?.test&&!/no test specified/i.test(pkg.scripts.test)) return { testCommands:[['npm','test']], integrationTestCommands:null, reason:'package.json test script' }; } catch {}
  if (exists('pyproject.toml') || exists('pytest.ini') || exists('tests')) return { testCommands: [[...(windows ? ['wsl.exe', 'env', 'PYTHONUTF8=1', 'python3'] : ['python3']), '-m', 'pytest']], integrationTestCommands: null, reason: 'Python test project' };
  if (exists('go.mod')) return { testCommands: [['go','test','./...']], integrationTestCommands: null, reason: 'Go module' };
  if (exists('Cargo.toml')) return { testCommands: [['cargo','test']], integrationTestCommands: null, reason: 'Cargo project' };
  throw Error('Could not detect a test command. Open Advanced setup and enter one trusted command.');
}

// gh runs inside WSL on Windows, so the destination it is given must be a path
// WSL understands, even though the coordinator writes and reads the Windows one.
export function toCloneTarget(windowsPath) {
  return process.platform === 'win32'
    ? windowsPath.replaceAll('\\', '/').replace(/^([a-zA-Z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)
    : windowsPath;
}
