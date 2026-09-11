import { checkCompatibility } from './lib/compatibility.mjs';
import { projectChoices, browseFolders } from './lib/project-picker.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Coordinator } from './lib/core.mjs';
import { createLocal, createProject, githubTarget, pushCandidate } from './lib/repositories.mjs';

export function createServer(engine) {
  engine.pushHandler = task => pushCandidate(engine, task);
  const token = crypto.randomBytes(24).toString('hex');
  return http.createServer(async (req, res) => {
    const address = serverAddress(res); const origin = `http://${address}`;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    try {
      if (req.headers.host !== address || (req.headers.origin && req.headers.origin !== origin)) throw Error('Local origin required');
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8').replace('__TOKEN__', token)); return; }
      if (req.headers['x-coordinator-token'] !== token) { res.writeHead(403); res.end('Local session required'); return; }
      let value;
      if (req.method === 'GET' && url.pathname === '/api/state') value = engine.state;
      else if (req.method === 'GET' && url.pathname === '/api/projects') value = projectChoices(engine);
      else if (req.method === 'GET' && url.pathname === '/api/memory') value = engine.portableMemory();
      else if (req.method === 'POST') {
        if (!String(req.headers['content-type']).startsWith('application/json')) throw Error('JSON required');
        let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 50000) throw Error('Request too large'); }
        const body = JSON.parse(raw || '{}');
        if (url.pathname === '/api/folders') value = browseFolders(body.folder);
        else if (url.pathname === '/api/configure') engine.configure(body);
        else if (url.pathname === '/api/check-model') value = await checkCompatibility(engine,body.provider);
        else if (url.pathname === '/api/models') engine.setModels(body);
        else if (url.pathname === '/api/check-usage') await engine.monitorProviders(true);
        else if (url.pathname === '/api/limits') engine.setLimits(body);
        else if (url.pathname === '/api/tasks') value = engine.addTask(body);
        else if (url.pathname === '/api/control') engine.control(body.action);
        else if (url.pathname === '/api/decision') engine.decision(body.text);
        else if (url.pathname === '/api/provider') engine.provider(body.name, body.enabled);
        else if (url.pathname === '/api/retry') engine.retry(body.id, body.confirmation);
        else if (url.pathname === '/api/integrate') await engine.integrate(body.id);
        else if (url.pathname === '/api/chat') value = await engine.chat(body);
        else if (url.pathname === '/api/accept-plan') value = engine.acceptPlan(body.id);
        else if (url.pathname === '/api/policy') engine.setPolicy(body);
        else if (url.pathname === '/api/local-repository') value = createLocal(engine, body.name);
        else if (url.pathname === '/api/project') value = createProject(engine, body);
        else if (url.pathname === '/api/github-target') value = await githubTarget(engine, body);
        else if (url.pathname === '/api/push') value = await pushCandidate(engine, engine.task(body.id));
        else if (url.pathname === '/api/recover') engine.acknowledgeRecovery(body.confirmation);
        else throw Error('Unknown action');
        value ||= { ok: true };
      } else { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));
    } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
}
function serverAddress(res) { return `127.0.0.1:${res.socket.localPort}`; }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.env.COORDINATOR_DATA || fileURLToPath(new URL('./data', import.meta.url)));
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'server.lock');
  const claimLock = () => fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
  try { claimLock(); }
  catch {
    // A lock whose owning process is gone is a crash/closed-window leftover, not a live server.
    // Reclaim it automatically; a lock held by a running process is still refused.
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(lock, 'utf8')).pid; } catch {}
    let alive = false;
    if (Number.isInteger(holder)) { try { process.kill(holder, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
    if (alive) throw Error(`Another coordinator is already running (process ${holder}). Stop it first, or use a different COORDINATOR_DATA directory and PORT.`);
    console.log(`Clearing a stale lock left by a previous run${holder ? ` (process ${holder} is no longer running)` : ''}.`);
    fs.rmSync(lock, { force: true });
    claimLock();
  }
  let server;
  try {
    const engine = new Coordinator(dir); server = createServer(engine);
    const timer = setInterval(() => { engine.monitorProviders().catch(()=>{}); engine.recoverProvider().catch(()=>{}); engine.tick(); }, 1000);
    server.listen(Number(process.env.PORT || 4317), '127.0.0.1', () => console.log(`Local coordinator: http://127.0.0.1:${server.address().port} (paused)`));
    server.on('error', error => { console.error(error.message); clearInterval(timer); fs.unlinkSync(lock); process.exitCode = 1; });
    let closing = false;
    const close = () => {
      if (closing) return; closing = true; clearInterval(timer); engine.control('pause');
      console.log('Paused. Draining bounded active calls before shutdown.');
      const drain = setInterval(() => { if (!engine.running.size && !engine.integrating && !engine.chatting && !engine.monitoring && !engine.githubBusy) { clearInterval(drain); server.close(() => { fs.unlinkSync(lock); }); } }, 200);
    };
    process.on('SIGINT', close); process.on('SIGTERM', close);
  } catch (error) { fs.unlinkSync(lock); throw error; }
}
