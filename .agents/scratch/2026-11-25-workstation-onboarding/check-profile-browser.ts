import page from '../../../web/workstation.html';
import { strict as assert } from 'node:assert';
const profile = {group:'Lab',description:'Fixture',defaultHarness:null};
let stored = {name:'Runner',origin:'https://runner.invalid',profile};
let writes=0;
const server=Bun.serve({hostname:'127.0.0.1',port:0,routes:{'/workstation':page,'/api/manage/runner/profile':{GET:()=>Response.json(stored), POST:async req=>{const body=await req.json();assert.deepEqual(body.expected,stored);writes++;stored={...stored,name:body.name,profile:body.profile};return Response.json(stored)}}}});
const session=`fleet-profile-${process.pid}`;
const run=async(...args:string[])=>(await Bun.$`agent-browser --session ${session} ${args}`.quiet()).text().trim();
try {
  await run('open',`${server.url}workstation?host=runner`);
  await run('wait','--text','Loaded saved settings.');
  await run('fill','#group','Compute');
  const preview=await run('get','text','#changes');assert.match(preview,/Group: Lab → Compute/);assert.equal(writes,0);
  await run('click','#save');await run('wait','--text','Changes saved.');assert.equal(writes,1);assert.equal(stored.profile.group,'Compute');
  await run('reload');await run('wait','--text','Loaded saved settings.');assert.equal(await run('get','value','#group'),'Compute');
  console.log(JSON.stringify({preview,writes,reloadedGroup:stored.profile.group,userAgent:await run('eval','navigator.userAgent')}));
}finally{try{await run('close')}finally{server.stop(true)}}
