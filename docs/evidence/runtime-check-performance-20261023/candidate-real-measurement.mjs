import { measureCodexAppServerBinaryAsync } from '/home/isp/wsps/chcbz/isp-install-worktrees/runtime-check-performance-20261023/conf/codex-ws-agent/app-server-adapter.mjs'
import { mkdtempSync, chmodSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, get } from 'node:http'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
const root=mkdtempSync('/var/tmp/cyf-runtime-integrity-diagnostic-');chmodSync(root,0o700)
const events=[];const loop=monitorEventLoopDelay({resolution:20});let timer;const pending=new Set()
const server=createServer((req,res)=>{res.writeHead(403);res.end()});await new Promise(r=>server.listen(0,'127.0.0.1',r))
const profile={codexBin:'/home/isp/state/cyf-agent-runtime-v1/unified/agents/linchong/codex-home/.cyf-app-server-bin-UsJLkZ/bin/codex',codexHome:root,appServerSchemaContractId:'codex-cli-0.161.0'}
let result
try{
 loop.enable();timer=setInterval(()=>{let done;const p=new Promise(r=>done=r);pending.add(p);const start=performance.now();get({host:'127.0.0.1',port:server.address().port},res=>{res.resume();res.on('end',()=>{events.push({status:res.statusCode,elapsedMs:performance.now()-start});pending.delete(p);done()})}).on('error',error=>{events.push({error:error.code});pending.delete(p);done()})},100)
 const start=performance.now();const first=await measureCodexAppServerBinaryAsync(profile,{environment:{PATH:'/usr/bin:/bin',HOME:root,CODEX_HOME:root}});const firstMs=performance.now()-start
 const next=performance.now();const second=await measureCodexAppServerBinaryAsync(profile,{environment:{PATH:'/usr/bin:/bin',HOME:root,CODEX_HOME:root}})
 result={observedAt:new Date().toISOString(),noModelCalls:true,firstMs,cachedMs:performance.now()-next,sameSnapshot:first.snapshotPath===second.snapshotPath,measuredCli:first.cliVersion,maxEventLoopDelayMs:loop.max/1e6,localHttpResponses:events}
}finally{clearInterval(timer);await Promise.all([...pending]);loop.disable();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true})}
writeFileSync('/var/tmp/cyf-doc-chain-fix/rootcause-repro-20261023/perf-candidate/real-measurement-final.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
