// Isolated integration child: actual Runtime transport/installer/reconcilers, no provider calls.
import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RuntimeV1Client } from '../../../cyf-agent-runtime-v1/lib/runtime-client.mjs'
import { SkillInstallManager } from '../../skill-install-manager.mjs'
import { PositionSkillReconciler } from '../../position-skill-reconciler.mjs'
import { SkillRegistry } from '../../skill-registry.mjs'
import { createLocalScriptRunner } from '../../skill-runners/local-script.mjs'
import { ArchiveJobReconciler } from '../../archive-job-reconciler.mjs'
let client,manager,positions,jobs,registry
const lines=createInterface({input:process.stdin})
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n')
for await (const line of lines) {
 try {
  const message=JSON.parse(line)
  if(message.op==='INIT') {
   const state=join(message.root,'runtime-state'),home=join(message.root,'codex-home');mkdirSync(state,{recursive:true,mode:0o700});mkdirSync(home,{recursive:true,mode:0o700})
   writeFileSync(join(state,'runtime-authorization.json'),JSON.stringify({installationId:message.manifest.installationId,runtimeAuthorization:message.authorization}),{mode:0o600})
   client=new RuntimeV1Client({manifest:message.manifest,apiBaseUrl:message.origin,stateDir:state,hostId:'archive-host',runtimeInstanceId:'archive-boot'})
   const session=await client.session()
   manager=new SkillInstallManager({profile:{profileId:'archive-fixture',agentId:message.manifest.canonicalAgentId,codexHome:home,codexWorkdir:home},stateRoot:join(message.root,'installer'),wsUrl:message.origin.replace(/^http/,'ws')+'/ws/agent/channel',enabled:true,getRuntimeHeaders:()=>client.sessionHeaders(),fetchFn:globalThis.fetch,sendResultFn:()=>false,runtimeInstanceId:'archive-boot'})
   manager.initialize()
   const scope={tenantId:session.tenantId,clientId:session.clientId,ownerJiacn:message.ownerJiacn,agentId:session.canonicalAgentId}
   const fence={installationId:session.installationId,hostId:session.hostId,runtimeInstanceId:session.runtimeInstanceId,sessionGeneration:String(session.sessionGeneration)}
   manager.bindSession({scope,fence})
   const runner=createLocalScriptRunner({bwrapBin:'/usr/bin/bwrap'})
   registry=new SkillRegistry({scope,loadInstalled:()=>manager.listInstalledSkills(),runnerRegistry:new Map([['local-script',runner]]),toolProbes:new Map([['node',()=>runner.probeTool()]])})
   registry.setSession(fence)
   manager.verifyCandidate=async row=>(await registry.measureInstallation(row)).item
   const shared={manager,nativeFetch:(url,options)=>client.nativeFetch(url,options),apiOrigin:message.origin,agentId:message.manifest.canonicalAgentId}
   positions=new PositionSkillReconciler(shared);jobs=new ArchiveJobReconciler(shared)
   // This private pipe is consumed without logging by the test JVM. No credentials in receipts/artifacts.
   emit({op:'SESSION',headers:client.sessionHeaders()})
  } else if(message.op==='INSTALL') {
   const progress=await positions.poll()
   const catalog=await registry.refresh()
   if(!catalog)throw new Error(registry.lastErrorCode||'FIXTURE_CATALOG_UNAVAILABLE')
   emit({op:message.op,...progress,catalog,installed:manager.listInstalledSkills().map(i=>({installationId:i.installationId,skillKey:i.manifest?.skillKey||null}))})
  } else if(message.op==='RUN') emit({op:message.op,...await jobs.poll()})
  else if(message.op==='NEGATIVE') {
   const results=[]
   for(const headers of [{Authorization:'Bearer user-jwt'},{'X-API-Key':'retired'}, {...client.sessionHeaders(),'X-Agent-Runtime-Id':'old-boot'}])results.push((await fetch(message.origin+'/internal/archive/v1/jobs',{headers})).status)
   emit({op:message.op,statuses:results})
  } else if(message.op==='STOP') {client.invalidateSession();emit({op:'STOPPED'});lines.close();process.stdin.destroy();break}
  else throw new Error('FIXTURE_COMMAND_INVALID')
 } catch(error) {emit({op:'FAILED',code:error.code||error.message||'UNKNOWN',status:error.status||null})}
}
