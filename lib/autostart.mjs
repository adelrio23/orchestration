import { createProject, githubTarget } from './repositories.mjs';
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
