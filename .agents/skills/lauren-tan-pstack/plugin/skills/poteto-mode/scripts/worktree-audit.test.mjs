import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const audit = fileURLToPath(new URL('./worktree-audit.sh', import.meta.url));
for (const timestamps of ['native', 'gnu']) test(`audit preserves spaced paths, scopes session metadata, and holds unpreserved work (${timestamps} timestamps)`, () => {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pstack audit ')));
  const repo = path.join(fixture, 'main repo');
  const home = path.join(fixture, 'home');
  const bin = path.join(fixture, 'bin');
  fs.mkdirSync(repo); fs.mkdirSync(bin); fs.mkdirSync(home);
  if (timestamps === 'gnu') {
    fs.writeFileSync(path.join(bin, 'stat'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '-f') { console.log('File system status'); process.exit(0); }
if (args[0] !== '-c' || args[1] !== '%Y') process.exit(1);
console.log(Math.floor(fs.statSync(args[2]).mtimeMs / 1000));
`, {mode:0o755});
    fs.writeFileSync(path.join(bin, 'date'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '+%s') console.log(Math.floor(Date.now() / 1000));
else if (args[0] === '-d' && args[1].startsWith('@')) console.log(new Date(Number(args[1].slice(1)) * 1000).toISOString().slice(0, 10));
else process.exit(1);
`, {mode:0o755});
  }
  const env = {...process.env, HOME:home, PATH:`${bin}:${process.env.PATH}`, GIT_CONFIG_NOSYSTEM:'1'};
  const git = (...args) => execFileSync('git', ['-C',repo,...args], {env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  try {
    git('init','-b','main'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
    git('commit','--allow-empty','-m','base'); git('update-ref','refs/remotes/origin/main','HEAD');
    const paths = {};
    for (const branch of ['safe','recent','quoted','closed','scratch']) {
      paths[branch] = path.join(fixture,`${branch} tree`);
      git('worktree','add','-b',branch,paths[branch],'main');
    }
    execFileSync('git',['-C',paths.closed,'commit','--allow-empty','-m','unmerged'],{env,stdio:'ignore'});
    fs.writeFileSync(path.join(paths.scratch,'precious.txt'),'user work');
    fs.writeFileSync(path.join(bin,'gh'),'#!/bin/sh\nprintf \'[{"number":1,"state":"CLOSED","headRefName":"closed"}]\\n\'\n',{mode:0o755});
    const sessions=path.join(home,'.codex','sessions'); fs.mkdirSync(sessions,{recursive:true});
    fs.writeFileSync(path.join(sessions,'recent chat.jsonl'), JSON.stringify({type:'session_meta',payload:{cwd:paths.recent}})+'\n');
    fs.writeFileSync(path.join(sessions,'quoted chat.jsonl'), JSON.stringify({type:'session_meta',payload:{cwd:repo}})+'\n'+JSON.stringify({type:'message',text:paths.quoted})+'\n');
    const out=execFileSync('bash',[audit,repo],{env,encoding:'utf8'});
    const rows=new Map(out.trim().split('\n').filter(line => !line.startsWith('#')).slice(1).map(line=>{const c=line.split('\t'); return [c[8],c];}));
    assert.equal(rows.size,5);
    assert.equal(rows.get(paths.safe)[7],'safe');
    assert.equal(rows.get(paths.recent)[7],'verify-recent-chat');
    assert.equal(rows.get(paths.quoted)[7],'safe');
    assert.equal(rows.get(paths.closed)[7],'review');
    assert.equal(rows.get(paths.scratch)[7],'hold-wip');
    assert.equal(fs.readFileSync(path.join(paths.scratch,'precious.txt'),'utf8'),'user work');
  } finally { fs.rmSync(fixture,{recursive:true,force:true}); }
});

test('audit follows origin HEAD and honors an explicit base without fetching', () => {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pstack bases ')));
  const repo = path.join(fixture, 'repo');
  const worktree = path.join(fixture, 'feature');
  const home = path.join(fixture, 'home');
  const bin = path.join(fixture, 'bin');
  for (const dir of [repo, home, bin]) fs.mkdirSync(dir);
  const gitBinary = execFileSync('which', ['git'], {encoding:'utf8'}).trim();
  const fetchLog = path.join(fixture, 'fetch-attempted');
  const env = {...process.env, HOME:home, PATH:`${bin}:${process.env.PATH}`, GIT_CONFIG_NOSYSTEM:'1'};
  const git = (...args) => execFileSync(gitBinary, ['-C',repo,...args], {env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  try {
    git('init','-b','main'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
    git('commit','--allow-empty','-m','base'); git('update-ref','refs/remotes/origin/main','HEAD');
    git('worktree','add','-b','feature',worktree,'main');
    execFileSync(gitBinary,['-C',worktree,'commit','--allow-empty','-m','feature'],{env,stdio:'ignore'});
    git('update-ref','refs/remotes/origin/release','feature');
    git('symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/release');
    fs.writeFileSync(path.join(bin,'git'),`#!/bin/sh\nfor arg do\n  if [ "$arg" = fetch ]; then touch '${fetchLog}'; exit 1; fi\ndone\nexec '${gitBinary}' "$@"\n`,{mode:0o755});
    for (const command of ['gh','origin']) fs.writeFileSync(path.join(bin,command),'#!/bin/sh\nprintf "[]\\n"\n',{mode:0o755});
    const run = (...args) => execFileSync('bash',[audit,...args,repo],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
    const row = output => output.trim().split('\n').find(line=>line.endsWith(`\t${worktree}`)).split('\t');
    const automatic = run();
    assert.match(automatic, /^# base: origin\/release/m);
    assert.equal(row(automatic)[2],'YES');
    assert.equal(row(automatic)[7],'safe');
    const explicit = run('--base','origin/main');
    assert.equal(row(explicit)[2],'no');
    assert.equal(row(explicit)[7],'review');
    git('symbolic-ref','--delete','refs/remotes/origin/HEAD');
    git('update-ref','refs/remotes/origin/master','feature');
    git('update-ref','-d','refs/remotes/origin/main');
    assert.match(run(), /^# base: origin\/master/m);
    assert.throws(()=>run('-b','origin/missing'), error => error.status === 1 && /base ref not found/.test(error.stderr));
    assert.equal(fs.existsSync(fetchLog),false);
  } finally { fs.rmSync(fixture,{recursive:true,force:true}); }
});
