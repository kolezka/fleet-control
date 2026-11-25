import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {Requests} from './requests.ts';

test('explicit project and task ownership is immutable even on registration replay',()=>{
  const db=new Database(':memory:');
  try {
    const req=new Requests(db), run={runId:'run-1',orchestrator:'supervisor',phase:'build',projectId:'Atlas',taskId:'A-17'};
    expect(req.registerRun(run)).toMatchObject({projectId:'Atlas',taskId:'A-17'});
    expect(()=>req.registerRun({...run,projectId:'Beacon'})).toThrow(/ownership/);
    expect(()=>req.registerRun({...run,taskId:'A-18'})).toThrow(/ownership/);
    expect(new Requests(db).current().runs[0]).toMatchObject({projectId:'Atlas',taskId:'A-17'});
    expect(()=>req.registerRun({...run,runId:'partial',taskId:undefined})).toThrow(/together/);
    req.registerRun({runId:'legacy',orchestrator:'supervisor',phase:'build'});
    expect(()=>req.registerRun({...run,runId:'legacy'})).toThrow(/ownership/);
  }finally{db.close()}
});
