import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {join,resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const read=name=>readFileSync(join(root,name),'utf8').replace(/^\uFEFF/,'');
const manifest=JSON.parse(read('release-files.json'));
const files=[...manifest.application,...manifest.sourceOnly];

test('release allowlist is complete, confined and excludes local/private artifacts',()=>{
 assert.equal(new Set(files).size,files.length);
 for(const name of files){
  assert.match(name,/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/);assert.ok(!name.split('/').includes('..'));
  assert.ok(existsSync(join(root,name)),`missing ${name}`);
  assert.doesNotMatch(name,/^(?:PROJECT_HANDOFF|RESULTS|OUTCOMES|VALIDATION|EVALUATION)(?:[-.]|$)|(?:^|\/)(?:checkpoint|ledger|config\.toml|project-contexts\.json|product-trial\.json)(?:[.-]|$)|\.dpapi|\.jsonl$|^benchmark\//i);
 }
 for(const entry of ['src/proxy.mjs','src/metadata-worker.mjs','scripts/manage.ps1','scripts/credential-window.ps1','src/settings.html','routing-policy.json'])assert.ok(manifest.application.includes(entry));
 for(const name of files.filter(x=>/\.(?:mjs|js)$/.test(x))){
  for(const [,dep] of read(name).matchAll(/(?:from\s*|import\s*\(|new URL\(\s*)['"](\.[^'"]+)['"]/g)){
   const resolved=relative(root,resolve(dirname(join(root,name)),dep)).replaceAll('\\','/');
   if(resolved && !resolved.endsWith('/') && /\.[a-z]+$/i.test(resolved))assert.ok(files.includes(resolved),`${name} requires ${resolved}`);
  }
 }
 assert.equal(JSON.parse(read('routing-policy.json')).policyVersion,'research-v5b-r10');
 assert.equal(JSON.parse(read('package.json')).version,'0.9.0');
 assert.equal(JSON.parse(read('runtime-lock.json')).nodeVersion,'v24.21.0');
});

test('public document links resolve in the exported source',()=>{
 for(const name of files.filter(x=>x.endsWith('.md'))){
  for(const [,target] of read(name).matchAll(/\]\(([^)]+)\)/g)){
   if(/^(?:https?:|#)/.test(target))continue;
   const relativeTarget=target.split('#')[0];if(!relativeTarget)continue;
   const normalized=relative(root,resolve(dirname(join(root,name)),relativeTarget)).replaceAll('\\','/');
   assert.ok(files.includes(normalized),`${name}: link missing ${target}`);
  }
 }
});

test('source export copies only the allowlist and refuses to overwrite it',{skip:process.platform!=='win32',timeout:30000},()=>{
 const dir=mkdtempSync(join(tmpdir(),'advisor-release-'));
 const args=['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'scripts/package.ps1'),'-OutputDir',dir,'-StageOnly'];
 try{
  execFileSync('powershell.exe',args,{encoding:'utf8',timeout:20000});
  const exported=join(dir,'source/codex-model-advisor-router');
  const walk=base=>readdirSync(base,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(base,e.name)):[relative(exported,join(base,e.name)).replaceAll('\\','/')]);
  assert.deepEqual(walk(exported).sort(),[...files].sort());
  assert.throws(()=>execFileSync('powershell.exe',args,{encoding:'utf8',stdio:'pipe',timeout:10000}),/Output already exists/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('version updates replace documentation without nesting and rollback removes new docs',{skip:process.platform!=='win32',timeout:15000},()=>{
 const dir=mkdtempSync(join(tmpdir(),'advisor-docs-'));
 const quote=s=>s.replaceAll("'","''");
 const script=`$ErrorActionPreference='Stop'
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${quote(join(root,'scripts/manage.ps1'))}',[ref]$null,[ref]$null)
foreach($name in @('Assert-Within','Copy-Version')) {
 $f=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
 Invoke-Expression $f.Extent.Text
}
$installRoot='${quote(join(dir,'installed'))}'; $candidate='${quote(join(dir,'candidate'))}'; $previous='${quote(join(dir,'previous'))}'
foreach($base in @($installRoot,$candidate,$previous)) {
 foreach($name in @('src','scripts','skills')) {New-Item -ItemType Directory -Path (Join-Path $base $name) -Force | Out-Null}
 '{}' | Set-Content -LiteralPath (Join-Path $base 'package.json')
}
New-Item -ItemType Directory -Path (Join-Path $installRoot 'docs'),(Join-Path $candidate 'docs') | Out-Null
'old' | Set-Content -LiteralPath (Join-Path $installRoot 'docs/stale.md')
'current' | Set-Content -LiteralPath (Join-Path $candidate 'docs/INSTALL.md')
Copy-Version $candidate
if(-not (Test-Path -LiteralPath (Join-Path $installRoot 'docs/INSTALL.md')) -or (Test-Path -LiteralPath (Join-Path $installRoot 'docs/docs')) -or (Test-Path -LiteralPath (Join-Path $installRoot 'docs/stale.md'))) {throw 'Incorrect docs replacement'}
Copy-Version $previous
if(Test-Path -LiteralPath (Join-Path $installRoot 'docs')) {throw 'New docs survived rollback'}
'DOCS_UPDATE_ROLLBACK_OK'`;
 try{assert.match(execFileSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',timeout:10000}),/DOCS_UPDATE_ROLLBACK_OK/);}
 finally{rmSync(dir,{recursive:true,force:true});}
});
