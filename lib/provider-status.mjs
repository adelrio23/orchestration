import { spawn } from 'node:child_process';
import { safeEnv } from './process.mjs';
// Read-only app-server requests. No threads or model turns are created.
export function codexRead(config, method, params = {}) {
  if (!['model/list','account/rateLimits/read'].includes(method)) throw Error('Unsupported status request');
  return new Promise((resolve,reject)=>{
    const child=spawn(config.command,['app-server','--stdio'],{env:safeEnv(),windowsHide:true,stdio:['pipe','pipe','pipe']});
    let buffer='',bytes=0,done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);child.stdin.end();child.kill();error?reject(error):resolve(value)};
    const send=v=>child.stdin.write(JSON.stringify(v)+'\n');
    const timer=setTimeout(()=>finish(Error('Codex status check timed out')),20000);
    child.on('error',e=>finish(e));child.on('exit',()=>finish(Error('Codex status connection closed')));child.stdin.on('error',e=>finish(e));
    child.stderr.on('data',()=>{});
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>2000000)return finish(Error('Status output limit'));buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);let msg;try{msg=JSON.parse(line)}catch{continue}if(msg.id===1){if(msg.error)return finish(Error(msg.error.message));send({method:'initialized',params:{}});send({id:2,method,params})}if(msg.id===2)finish(msg.error?Error(msg.error.message):null,msg.result)}});
    send({id:1,method:'initialize',params:{clientInfo:{name:'local-coordinator',version:'0.2.0'},capabilities:{experimentalApi:true}}});
  });
}
export function quotaWindows(result) {
  const buckets=result?.rateLimitsByLimitId ? Object.values(result.rateLimitsByLimitId) : [result?.rateLimits];
  return buckets.filter(Boolean).flatMap(b=>['primary','secondary'].flatMap(key=>{
    const w=b[key];return w && typeof w.usedPercent==='number' ? [{bucket:b.limitId||'codex',window:key,remaining:Math.max(0,Math.min(100,100-w.usedPercent)),resetsAt:w.resetsAt??null}] : [];
  }));
}
