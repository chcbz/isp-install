// Isolated diagnostic: production egress implementation, owned bwrap netns,
// dummy sleep holder, no credentials/model/API calls or production state writes.
import {spawn} from 'node:child_process';
import {readFileSync,statSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {RestrictedProviderEgress} from '/home/isp/apps/cyf-agent-runtime-v1/app/codex-ws-agent/typed-inspection-network.mjs';
const output=process.argv[2];if(!output?.startsWith('/var/tmp/cyf-doc-chain-fix/rootcause-repro-20261023/'))throw Error('Evidence path required');
const events=[];const start=performance.now();const record=(event,facts={})=>{const r={ms:Math.round(performance.now()-start),event,...facts};events.push(r);console.log(JSON.stringify(r));};
const identity=p=>{let s=statSync(p,{bigint:true});return {dev:String(s.dev),ino:String(s.ino),size:String(s.size),sha256:createHash('sha256').update(readFileSync(p)).digest('hex')}};
const codexMode=process.argv[3]==='codex';
const snapshot='/home/isp/state/cyf-agent-runtime-v1/unified/agents/linchong/codex-home/.cyf-app-server-bin-UsJLkZ';
const sandboxArgs=codexMode?['--unshare-all','--die-with-parent','--new-session','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/tmp/codex-home','--dir','/runtime','--ro-bind',snapshot,'/runtime','--setenv','HOME','/tmp','--setenv','CODEX_HOME','/tmp/codex-home','--chdir','/tmp','/runtime/bin/codex','app-server']:['--unshare-all','--die-with-parent','--new-session','--ro-bind','/usr','/usr','--ro-bind','/lib64','/lib64','--ro-bind','/lib','/lib','--proc','/proc','--dev','/dev','--','/usr/bin/sleep','180'];
async function trial(id){
const log=(event,facts={})=>record(event,{trial:id,...facts});
const child=spawn('/usr/bin/bwrap',sandboxArgs,{stdio:['pipe','pipe','pipe']});
child.stderr.on('data',x=>log('holder-stderr',{text:x.toString()}));child.on('exit',(code,signal)=>log('holder-exit',{code,signal}));
const spawnFn=(bin,args,options)=>{if(bin==='/usr/bin/nsenter' && args.includes('-c') && args.at(-1).includes('def c(host,port')){args=[...args];args[args.length-1]=args.at(-1).replace("except Exception:d=b''","except Exception as exc:sys.stderr.write(type(exc).__name__+': '+str(exc)+'\\n');d=b''")}log('command-start',{bin,kind:args.includes('-c')?'python-probe':args.includes('nft')?'nft':'namespace-control'});const p=spawn(bin,args,options);p.stdout?.on('data',x=>log('command-stdout',{bin,text:x.toString()}));p.stderr?.on('data',x=>log('command-stderr',{bin,text:x.toString()}));p.on('close',(code,signal)=>log('command-close',{bin,code,signal}));return p;};
const e=new RestrictedProviderEgress({providerBaseUrl:'https://provider.example.invalid',networkConnectTimeoutMs:15000,spawnFn});
const assertOwner=e._assertOwner.bind(e);e._assertOwner=()=>{const t=performance.now();try{return assertOwner()}finally{log('owner-check',{durationMs:Math.round(performance.now()-t)})}};
const delay=monitorEventLoopDelay({resolution:20});delay.enable();let outcome={};
try {
 log('bind-start',{childPid:child.pid});await e.bindOwner(child,identity('/usr/bin/bwrap'),identity(codexMode?snapshot+'/bin/codex':'/usr/bin/sleep'));log('bind-ok',{holderPid:e.owner.holder.pid});
 await e.start();log('proxy-start',{proxyPort:e.port,canaryPort:e.canaryPort});
 e.server.prependListener('connect',(req,socket)=>{log('proxy-connect',{authority:req.url});socket.on('error',x=>log('proxy-socket-error',{code:x.code}));socket.on('close',()=>log('proxy-socket-close'));socket.on('finish',()=>log('proxy-socket-finish'));});
 e.server.on('connection',socket=>log('proxy-tcp',{remote:socket.remoteAddress}));e.server.on('clientError',error=>log('proxy-client-error',{code:error.code}));
 await e.attach();log('attach-pass');outcome={result:'PASS',attestation:e.attestation};
} catch(error){log('attach-fail',{code:error.code,message:error.message});outcome={result:'FAIL',code:error.code,message:error.message};}
finally {delay.disable();log('event-loop',{maxMs:delay.max/1e6,meanMs:delay.mean/1e6});await e.dispose();child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null||child.signalCode!==null?r():child.once('exit',r));return {id,...outcome};}

}
const result=await Promise.all([trial(1),trial(2),trial(3)]);writeFileSync(output,JSON.stringify({observedAt:new Date().toISOString(),implementation:'installed Runtime1.2.6',noProviderRequests:true,result,events},null,2));
