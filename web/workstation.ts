import { parseWorkstationProfile, type WorkstationProfile } from '../src/domain/workstation-profile.ts';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const field = (id: string) => element<HTMLInputElement>(id);
const host = new URLSearchParams(location.search).get('host') ?? '';
const api = './api/manage/' + encodeURIComponent(host) + '/profile';
type Snapshot = {name:string; origin:string; profile:WorkstationProfile|null};
let snapshot: Snapshot | null = null;
let busy = false;
const notice = (s:string) => {element('notice').textContent=s};
const values = () => ({name:field('name').value.trim(),group:field('group').value.trim(),description:field('description').value.trim(),defaultHarness:field('harness').value || null});
function diff() {
  if (!snapshot) return;
  const old = {name:snapshot.name,group:snapshot.profile?.group ?? '',description:snapshot.profile?.description ?? '', defaultHarness:snapshot.profile?.defaultHarness ?? null};
  const now=values();
  const labels={name:'Display name',group:'Group',description:'Description',defaultHarness:'Harness preference'};
  const changes=(Object.keys(labels) as (keyof typeof labels)[]).filter(k=>old[k]!==now[k]).map(k=>`${labels[k]}: ${old[k] || 'None'} → ${now[k] || 'None'}`);
  element('changes').textContent=changes.join('\n') || 'No pending changes.';
  field('save').disabled=busy || !changes.length || !now.name || !now.group;
}
function lock() {element<HTMLFieldSetElement>('fields').disabled=busy || !snapshot; field('reload').disabled=busy;diff();}
async function load() {
  if (busy) return;
  busy=true; snapshot=null;lock();
  try {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(host)) throw Error();
    const res=await fetch(api,{signal:AbortSignal.timeout(15000)});if(!res.ok) throw Error();
    const raw=await res.json();const profile=parseWorkstationProfile(raw.profile);
    if(typeof raw.name!=='string'||typeof raw.origin!=='string'||(raw.profile!==null&&!profile)) throw Error();
    snapshot={name:raw.name,origin:raw.origin,profile};
    element('identity').textContent=`${host} · ${raw.origin} (address and credentials are not editable here)`;
    field('name').value=raw.name;field('group').value=profile?.group ?? '';field('description').value=profile?.description ?? '';field('harness').value=profile?.defaultHarness ?? '';notice('Loaded saved settings.');
  } catch {notice('Cannot read workstation configuration.');} finally {busy=false;lock()}
}
element('profileForm').addEventListener('input',diff);
element('profileForm').addEventListener('submit',async e=>{
  e.preventDefault();if(!snapshot||busy||field('save').disabled)return;
  const {name,...profile}=values();if(!parseWorkstationProfile(profile)){notice('Invalid group, description or harness.');return}
  busy=true;lock();
  try {
    const res=await fetch(api,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expected:snapshot,name,profile}),signal:AbortSignal.timeout(15000)});
    if(res.status===409){snapshot=null;notice('Configuration changed. Reload saved settings before editing again.');return}
    if(!res.ok)throw Error();const stored=await res.json();if(stored.name!==name||stored.origin!==snapshot.origin||!parseWorkstationProfile(stored.profile)||Object.keys(profile).some(k=>stored.profile[k]!==profile[k as keyof typeof profile]))throw Error();
    snapshot={name,origin:stored.origin,profile:stored.profile};notice('Changes saved.');
  }catch{snapshot=null;notice('Save not confirmed. Reload to check the stored configuration.')}finally{busy=false;lock()}
});
field('reload').addEventListener('click',()=>void load());void load();
