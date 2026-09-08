import { discover, preflight } from './lib/adapters.mjs';
import { run } from './lib/process.mjs';
const adapters = discover();
for (const [name, config] of Object.entries(adapters)) {
  const args = config.wsl ? ['--exec', 'claude', '--version'] : ['--version'];
  const r = await run(config.command, args, { timeout: 15000 });
  console.log(`${name}: ${r.code === 0 ? r.output.trim() : 'not accessible'}; launcher ${config.command}`);
  try { await preflight(name, config, process.cwd()); console.log('  Subscription/provider check passed. No model call made.'); }
  catch (e) { console.log('  ' + e.message); }
}
