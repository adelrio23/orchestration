import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function projectChoices(engine) {
  const candidates = new Set([engine.state.repo].filter(Boolean));
  try { for (const item of JSON.parse(fs.readFileSync(path.join(engine.dir, 'project-bookmarks.json'), 'utf8'))) if (typeof item === 'string') candidates.add(item); } catch {}
  for (const root of [path.join(engine.dir, 'projects'), path.join(os.homedir(), 'Documents', 'Codex'), path.join(os.homedir(), 'Projects'), path.join(os.homedir(), 'source', 'repos')]) {
    try { for (const entry of fs.readdirSync(root, { withFileTypes: true }).slice(0, 300)) if (entry.isDirectory() && !entry.isSymbolicLink()) candidates.add(path.join(root, entry.name)); } catch {}
  }
  return [...new Set([...candidates].map(p => path.resolve(p)))].filter(p => fs.existsSync(path.join(p, '.git'))).map(p => ({ name: path.basename(p), path: p })).sort((a,b) => a.name.localeCompare(b.name));
}
export function browseFolders(folder) {
  const current = path.resolve(typeof folder === 'string' && folder ? folder : os.homedir());
  const entries = fs.readdirSync(current, { withFileTypes: true });
  return { current, parent: path.dirname(current), repository: fs.existsSync(path.join(current, '.git')), folders: entries.filter(e => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.')).sort((a,b) => a.name.localeCompare(b.name)).slice(0,500).map(e => ({ name:e.name, path:path.join(current,e.name) })) };
}
