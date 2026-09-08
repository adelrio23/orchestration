import fs from 'node:fs';import path from 'node:path';import {Coordinator,git,verdict} from './core.mjs';
// Synthetic checks exercise the actual configured adapters without touching the selected project.
export async function checkCompatibility(engine, provider) {
 if(!Object.hasOwn(engine.state.providers,provider))throw Error('Unknown provider');
 if(engine.state.mode!=='paused'||engine.running.size||engine.chatting||engine.monitoring||engine.integrating||engine.githubBusy||engine.state.recoveryRequired)throw Error('Pause and drain active work before testing models');
 const pauseVersion=engine.state.pauseVersion||0;
 const config=structuredClone(engine.state.adapters[provider]);
 engine.state.compatibility ||= {};
 const key=JSON.stringify([provider,config.models]);
 const record={provider,models:config.models,at:new Date().toISOString(),status:'running',checks:[]};
 engine.state.compatibility[key]=record;
 if(/^quota/.test(engine.state.providers[provider].blocked||'')){record.status='pending_quota';engine.save();return record}
 if(engine.state.calls+2>engine.state.limits.maxCalls){record.status='pending_budget';engine.save();return record}
 engine.chatting=true;engine.state.externalOperation='Model compatibility check';engine.save();
 try {
  const root=path.join(engine.dir,'compatibility',Date.now()+'-'+provider),repo=path.join(root,'repo');fs.mkdirSync(repo,{recursive:true});git(repo,'init');
  fs.writeFileSync(path.join(repo,'math.mjs'),"export function add(){throw Error('not implemented')}\n");
  const tests="import test from 'node:test';import assert from 'node:assert/strict';import {add} from './math.mjs';test('addition',()=>{assert.equal(add(2,3),5);assert.equal(add(-2,.5),-1.5);for(const x of [null,NaN,Infinity,'2',undefined]){assert.throws(()=>add(x,2),TypeError);assert.throws(()=>add(2,x),TypeError)}})";
  fs.writeFileSync(path.join(repo,'math.test.mjs'),tests);git(repo,'add','.');git(repo,'-c','user.name=Compatibility','-c','user.email=test@localhost','-c','commit.gpgsign=false','commit','-m','Synthetic model fixture');
  const invoke=async(name,cfg,prompt,role,cwd,limits)=>{if((engine.state.pauseVersion||0)!==pauseVersion)throw Error('Compatibility check stopped by Pause');engine.state.calls++;engine.save();const r=await engine.executor(name,cfg,prompt,role,cwd,limits);record.checks.push({role,status:r.status,requestedModel:cfg.models?.[role],reportedModels:r.reportedModels||[]});if(r.status==='quota')engine.state.providers[name].blocked='quota: compatibility check reached account limit';if(r.status==='interrupted')engine.state.recoveryRequired='Compatibility process termination uncertain; verify it stopped.';engine.save();return r};
  const child=new Coordinator(path.join(root,'state'),{executor:invoke});child.state.adapters[provider]=config;child.configure({repo,requirements:'Finite addition only.',testCommands:[[process.execPath,'--test','math.test.mjs']]});child.setLimits({maxCalls:2,maxAttempts:1,timeoutMs:60000});
  const t=child.addTask({title:'Model build check',requirements:'Return a coordinator-files proposal replacing math.mjs only. Export add(a,b), reject either non-finite/non-number argument with TypeError, otherwise return a+b. Do not modify tests.',acceptance:'Addition and validation tests pass.',scope:['math.mjs'],eligible:[provider]});
  await child.dispatch(t,provider);record.buildPassed=t.tests?.passed===true&&t.stage==='review';
  if(!record.buildPassed){record.status=record.checks.some(c=>c.status==='quota')?'pending_quota':'failed';record.detail=t.blocked||'Build or proposal validation failed';return record}
  // A deliberately flawed implementation must be rejected; a rubber-stamp review cannot pass.
  const reviewed=await invoke(provider,config,'Read-only compatibility review. Requirement: add(a,b) must reject either invalid argument with TypeError. Candidate: export function add(a,b){return a+b}. It returns string concatenation and accepts invalid inputs. Explain whether it meets the requirement. End with REVIEW: PASS or REVIEW: FAIL on its own line. Do not run tools or modify files.','review',repo,child.state.limits);
  record.reviewPassed=reviewed.status==='ok' && /^REVIEW:\s*FAIL\s*$/m.test(reviewed.text) && !verdict(reviewed.text);
  record.status=reviewed.status==='quota'?'pending_quota':record.reviewPassed?'passed':'failed';record.detail=record.reviewPassed?'Synthetic build tests passed and defective code was rejected.':'Review did not establish compatibility';return record;
 }catch(error){record.status='failed';record.detail=error.message;return record}
 finally{engine.chatting=false;engine.state.externalOperation=null;engine.save()}
}
