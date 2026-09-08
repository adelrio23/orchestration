// Optional: two live subscription calls. Plans and reviews one milestone; does not dispatch builders.
import fs from 'node:fs';
import path from 'node:path';
import { Coordinator, git } from './lib/core.mjs';
const root=path.resolve('data','planning-smoke-'+Date.now()), repo=path.join(root,'repo');
fs.mkdirSync(path.join(repo,'test'),{recursive:true});git(repo,'init');
fs.writeFileSync(path.join(repo,'math.mjs'),"export function add() { throw new Error('not implemented'); }\n");
fs.writeFileSync(path.join(repo,'test/math.test.mjs'),"import test from 'node:test'; import assert from 'node:assert/strict'; import {add} from '../math.mjs'; test('addition',()=>assert.equal(add(2,3),5)); test('invalid input',()=>assert.throws(()=>add('2',3),TypeError));\n");
git(repo,'add','.');git(repo,'-c','user.name=Smoke','-c','user.email=smoke@localhost','-c','commit.gpgsign=false','commit','-m','Planning fixture');
const c=new Coordinator(path.join(root,'state'));
c.configure({repo,requirements:'Complete add(a,b) in math.mjs: add finite numeric arguments and throw TypeError for anything else. Existing Node tests must pass. This is the entire project; no UI, server, deployment or additional features.',testCommands:[[process.execPath,'--test','test/*.test.mjs']]});
c.setLimits({maxCalls:4,maxAttempts:1,timeoutMs:90000});
const head=git(repo,'rev-parse','HEAD');
const result=await c.chat({provider:'codex',intent:'plan',autoStart:true,message:'Propose exactly one small milestone to complete the project. The existing tests are provided; inspect them. Do not invent additional features.'});
const passed=result.plan?.review?.passed===true && result.plan.status==='queued' && c.state.mode==='running' && c.state.tasks.length===1;
c.control('pause');
fs.mkdirSync('data/verification',{recursive:true});fs.writeFileSync('data/verification/planning-smoke.json',JSON.stringify({passed,root,calls:c.state.calls,result,runs:c.state.runs,sourceUnchanged:git(repo,'rev-parse','HEAD')===head&&!git(repo,'status','--porcelain')},null,2));
console.log(JSON.stringify({passed,calls:c.state.calls,status:result.status,phase:result.phase,planError:result.planError,reviewer:result.plan?.review?.provider,milestones:c.state.tasks.length}));
if(!passed)process.exitCode=1;
