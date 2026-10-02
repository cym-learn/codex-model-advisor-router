import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const html = readFileSync(new URL('../src/settings.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../src/settings-client.js', import.meta.url), 'utf8');
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.value = ''; this.checked = false; this.disabled = false; this.textContent = ''; this.children = []; this.dataset = {}; this.events = {}; }
  addEventListener(name, listener) { this.events[name] = listener; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  querySelectorAll() { return this.children.flatMap(x => [...(x.dataset?.mutation ? [x] : []), ...(x.querySelectorAll?.() ?? [])]); }
  focus() {}
  async emit(name) { if (this.disabled && ['click','submit'].includes(name)) return; return this.events[name]?.({preventDefault() {}}); }
}
const base = () => ({token:'local-token', mode:'rules', credentialConfigured:true, baseline:{model:'gpt-6-sol',effort:'high'}, catalogCount:15, briefs:{version:2,entries:[]}, threads:[], trial:null, busy:false});
test('unrestricted controller does not claim an active trial registration', async () => {
  const state=base(); state.trial={enabled:false,unrestricted:true};
  const {nodes}=await app(state);
  assert.equal(nodes['trial-state'].textContent,'当前没有试用登记。');
});

test('editing a multi-folder card sends original identity and all edited paths together',async()=>{
 const state=base(),target='c:\\frontend\nd:\\backend';
 state.briefs.entries=[{scope:'project',target,text:'shared summary',enabled:true}];
 const {nodes:n,calls,settle}=await app(state);
 const card=n['brief-list'].children[0],actions=card.children[3];
 await actions.children[0].emit('click');
 assert.equal(n['brief-target'].value,target);
 n['brief-target'].value='d:\\backend\ne:\\docs';await n['brief-target'].emit('input');
 n['brief-consent'].checked=true;await n['brief-consent'].emit('change');
 await n['brief-form'].emit('submit');await settle();
 const body=JSON.parse(calls.find(c=>c.options.method==='POST').options.body);
 assert.equal(body.originalTarget,target);assert.equal(body.target,'d:\\backend\ne:\\docs');
});
async function app(state = base(), post = () => ({ok:true})) {
  const nodes = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(m => [m[1], new Element()]));
  nodes['brief-scope'].value = 'project'; nodes.mode.value = 'rules';
  const calls = []; let getError = false;
  runInNewContext(script, {
    document:{getElementById:id=>nodes[id],createElement:tag=>new Element(tag)}, window:{confirm:()=>true}, AbortSignal,
    fetch:async (path, options) => {
      calls.push({path, options});
      if (options.method === 'POST') { const value = await post(JSON.parse(options.body)); return {ok:value.status == null || value.status < 400, status:value.status ?? 200, json:async()=>value}; }
      if (getError) throw Error('offline');
      return {ok:true,status:200,json:async()=>state};
    }
  });
  async function settle() { for (let i=0;i<5;i++) await new Promise(resolve=>setImmediate(resolve)); }
  await settle();
  return {nodes,calls,settle,offline:()=>{getError=true;}};
}
test('summary preview is literal and each edit revokes consent before a scope-bound save', async () => {
  const {nodes:n,calls,settle} = await app();
  n['brief-target'].value='C:\\demo'; await n['brief-target'].emit('input');
  n['brief-text'].value='<img src=x onerror=alert(1)>'; await n['brief-text'].emit('input');
  assert.equal(n['brief-preview'].textContent,n['brief-text'].value);
  assert.equal(n['brief-preview'].children.length,0);
  assert.equal(n['brief-save'].disabled,true);
  n['brief-consent'].checked=true; await n['brief-consent'].emit('change');
  assert.equal(n['brief-save'].disabled,false);
  n['brief-text'].value+=' edited'; await n['brief-text'].emit('input');
  assert.equal(n['brief-consent'].checked,false);
  n['brief-consent'].checked=true; await n['brief-consent'].emit('change');
  await n['brief-form'].emit('submit'); await settle();
  const request=calls.find(c=>c.options.method==='POST');
  assert.equal(request.path,'/api/project-briefs');
  assert.equal(request.options.credentials,'same-origin');
  assert.equal(request.options.headers['X-Advisor-Token'],'local-token');
  assert.deepEqual(JSON.parse(request.options.body),{action:'save',scope:'project',target:'C:\\demo',text:n['brief-text'].value,consent:true});
  assert.equal(n['brief-consent'].checked,false);
});
test('unknown catalog blocks auto even after consent, while rules remains available', async () => {
  const state=base(); state.catalogCount=null;
  const {nodes:n,calls}=await app(state);
  n.mode.value='auto'; await n.mode.emit('change'); n['routing-consent'].checked=true; await n['routing-consent'].emit('change');
  assert.equal(n['mode-save'].disabled,true);
  await n['mode-save'].emit('click'); assert.equal(calls.filter(c=>c.options.method==='POST').length,0);
  n.mode.value='rules'; await n.mode.emit('change'); assert.equal(n['mode-save'].disabled,false);
});
test('409 on connection check keeps it user-driven with no automatic second request', async () => {
  const {nodes:n,calls,settle}=await app(base(),()=>({status:409,error:'busy'}));
  await n['check-connection'].emit('click'); await settle();
  assert.equal(calls.filter(c=>c.options.method==='POST').length,1);
  assert.match(n.notice.textContent,/手动重试/);
  assert.equal(n['check-connection'].disabled,true);
  assert.match(n['connection-result'].textContent,/未确认成功/);
});
test('generic successful connection response is not labeled verified; offline retains editor but disables mutations', async () => {
  const {nodes:n,calls,settle,offline}=await app();
  await n['check-connection'].emit('click'); await settle();
  assert.match(n['connection-result'].textContent,/未提供连接确认/);
  assert.equal(calls.filter(c=>c.options.method==='POST').length,1);
  n['brief-text'].value='unsaved draft'; await n['brief-text'].emit('input');
  offline(); await n.refresh.emit('click'); await settle();
  assert.equal(n['brief-text'].value,'unsaved draft');
  assert.equal(n['mode-save'].disabled,true);
  assert.equal(n['key-setup'].disabled,true);
  assert.match(n['mode-state'].textContent,/未知/);
});
test('over-limit summary cannot be submitted even when set programmatically', async () => {
  const {nodes:n}=await app(); n['brief-target'].value='thread-123'; n['brief-text'].value='字'.repeat(2001);
  await n['brief-text'].emit('input'); n['brief-consent'].checked=true; await n['brief-consent'].emit('change');
  assert.equal(n['brief-save'].disabled,true); assert.match(n['brief-count'].textContent,/超出上限/);
});
