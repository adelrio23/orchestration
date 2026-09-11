import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

export function projectChoices(engine) {
  const candidates = new Set([engine.state.repo].filter(Boolean));
  try { for (const item of JSON.parse(fs.readFileSync(path.join(engine.dir, 'project-bookmarks.json'), 'utf8'))) if (typeof item === 'string') candidates.add(item); } catch {}
  // Projects live wherever the user put them: the home folder itself and the
  // usual Windows/macOS/Linux locations, including OneDrive-redirected ones.
  // A narrow list made the picker look empty and broken.
  const home = os.homedir();
  const roots = [path.join(engine.dir, 'projects'), home];
  for (const parent of [home, path.join(home, 'OneDrive')]) {
    for (const name of ['Documents', 'Desktop', 'Downloads', 'Projects', 'Code', 'code', 'dev', 'Dev', 'src', 'repos', 'git', 'GitHub', 'workspace']) roots.push(path.join(parent, name));
  }
  roots.push(path.join(home, 'Documents', 'Codex'), path.join(home, 'source', 'repos'));
  for (const root of [...new Set(roots)]) {
    try { for (const entry of fs.readdirSync(root, { withFileTypes: true }).slice(0, 300)) if (entry.isDirectory() && !entry.isSymbolicLink()) candidates.add(path.join(root, entry.name)); } catch {}
  }
  for (const repo of [...candidates].slice(0,400)) {
    if (!fs.existsSync(path.join(repo,'.git'))) continue;
    const result=spawnSync('git',['-c','core.hooksPath=/dev/null','worktree','list','--porcelain'],{cwd:repo,encoding:'utf8',windowsHide:true,timeout:3000,maxBuffer:100000});
    if(result.status===0)for(const line of result.stdout.split(/\r?\n/))if(line.startsWith('worktree '))candidates.add(line.slice(9));
  }
  return [...new Set([...candidates].map(p => path.resolve(p)))].filter(p => fs.existsSync(path.join(p, '.git'))).map(p => ({ name: path.basename(p), path: p })).sort((a,b) => a.name.localeCompare(b.name));
}
export function browseFolders(folder) {
  const current = path.resolve(typeof folder === 'string' && folder ? folder : os.homedir());
  const entries = fs.readdirSync(current, { withFileTypes: true });
  return { current, parent: path.dirname(current), repository: fs.existsSync(path.join(current, '.git')), folders: entries.filter(e => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.')).sort((a,b) => a.name.localeCompare(b.name)).slice(0,500).map(e => ({ name:e.name, path:path.join(current,e.name) })) };
}
