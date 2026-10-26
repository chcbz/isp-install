import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildArchive } from '../../skills/archive-maintenance-1.1.1/scripts/build-archive.mjs'
import { ArchiveJobReconciler, executeArchiveScript } from '../archive-job-reconciler.mjs'
import { PositionSkillReconciler } from '../position-skill-reconciler.mjs'
import { fileURLToPath } from 'node:url'
const hash=s=>createHash('sha256').update(s).digest('hex')
const source=(text,id='external-new-work')=>({workId:id,editionId:`edition-${id}`,title:'外部新底本',author:'测试作者',sourceName:'outside.txt',sourceRights:'owned-test-fixture',sourceText:text,sourceSha256:hash(text)})
const response=data=>({ok:true,status:200,json:async()=>({protocolVersion:1,requestId:'test-request',code:'E0',msg:'',data})})

test('arbitrary external titles and chapter counts, optional preface, exact hashes and deterministic editions',()=>{
  for(const [text,chapters,preface] of [['序言正文。\n\n第一回 初见\n你好。\n第二回 重逢\n再见。',2,true],['# 开篇\n甲。\n# 中篇\n乙。\n# 终篇\n丙。',3,false],['没有章节标题的正文。',1,false]]){
    const input=source(text),r=buildArchive(input),m=JSON.parse(r.manifestJson)
    assert.equal(m.chapterCount,chapters);assert.equal(!!m.preface,preface);assert.equal(m.source.sha256,hash(text))
    assert.equal(r.manifestFileSha256,hash(r.manifestJson));assert.deepEqual(buildArchive(input),r)
    assert.equal(m.readerParagraphCount,m.chapters.reduce((n,c)=>n+c.paragraphCount,0)+(m.preface?.paragraphCount||0))
    assert.ok(m.chapters.every(c=>c.paragraphs.every(p=>p.sha256===hash(p.text)&&p.utf8ByteLength===Buffer.byteLength(p.text))))
  }
})
test('reject source mismatch and empty chapters; never fabricate missing original text',()=>{
  assert.throws(()=>buildArchive({...source('正文'),sourceSha256:'a'.repeat(64)}),/MISMATCH/)
  assert.throws(()=>buildArchive(source('第一回 开始\n第二回 无正文')),/EMPTY_CHAPTER/)
})
test('actual installed script protocol consumes stdin and emits a verified deterministic manifest',async()=>{
  const packageRoot=fileURLToPath(new URL('../../skills/archive-maintenance-1.1.1/',import.meta.url))
  const input=source('第一回 见面\n你好，世界。')
  const result=await executeArchiveScript({packageRoot,manifest:{entrypoint:'scripts/build-archive.mjs'}},input)
  assert.deepEqual(result,buildArchive(input))
})
test('native archive job uses the explicit Agent and exact installed digest, not another installed skill',async()=>{
  const job={jobId:'job1',agentId:'agent1',state:'WAITING',installationId:'grant1-1',packageDigest:'sha256:'+'a'.repeat(64),manifestSha256:'b'.repeat(64),skillKey:'archive-maintenance',mode:'DRAFT_ONLY'}
  const sourceData=source('正文'),result=buildArchive(sourceData);const calls=[]
  const manager={listInstalledSkills:()=>[{skillInstallationId:'grant1-1',active:true,enabled:true,kind:'EXECUTABLE',packageSha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),manifest:{skillKey:'archive-maintenance',runner:'local-script'}}]}
  const runner=new ArchiveJobReconciler({manager,apiOrigin:'https://api.test',agentId:'agent1',execute:async()=>result,nativeFetch:async(url,options)=>{
    calls.push([url.pathname,options?.method||'GET'])
    if(url.pathname==='/internal/archive/v1/jobs')return response([job])
    if(url.pathname.endsWith('/source'))return response(sourceData)
    return response(options?.method==='POST'?{jobId:'job1',state:'DRAFT',resultDigest:result.manifestFileSha256}:{jobId:'job1',state:'WAITING'})
  }})
  assert.deepEqual(await runner.poll(),{processed:1});assert.equal(calls.filter(c=>c[1]==='POST').length,1)
  const installed=manager.listInstalledSkills()[0];manager.listInstalledSkills=()=>[installed]
  installed.enabled=false;await assert.rejects(runner.poll(),/NOT_READY/)
  installed.enabled=true;installed.active=false;await assert.rejects(runner.poll(),/NOT_READY/)
  installed.active=true
  job.packageDigest='sha256:'+'c'.repeat(64);await assert.rejects(runner.poll(),/NOT_READY/)
  job.agentId='other';await assert.rejects(runner.poll(),/JOB_INVALID/)
})
test('position installation uses the real shared PREPARE/ACTIVATE journal and only server receipts retire results',async t=>{
  const {mkdtempSync,mkdirSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path')
  const {SkillInstallManager}=await import('../skill-install-manager.mjs')
  const {packageFixture,command,activate,binding,profile,headers}=await import('./fixtures/skill-management-fixture.mjs')
  const {replyMessage}=await import('../message-envelope.mjs')
  const root=mkdtempSync(join(tmpdir(),'position-management-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
  const home=join(root,'home');mkdirSync(home);const pkg=packageFixture()
  const prepare=command(pkg.target,{skillChangeId:'ps_grant'}),activation=activate(prepare);let phase=0,downloads=0,results=0
  const manager=new SkillInstallManager({profile:profile(home),stateRoot:join(root,'state'),enabled:true,runtimeInstanceId:'boot_demo',
    wsUrl:'http://127.0.0.1:8080/ws/agent/channel'.replace('http:','ws:'),getRuntimeHeaders:()=>headers(binding),sendResultFn:()=>false,
    fetchFn:async()=>{downloads++;return new Response(pkg.bytes,{headers:{'content-type':'application/octet-stream','content-length':String(pkg.bytes.length)}})}})
  manager.initialize();manager.bindSession(binding)
  const runner=new PositionSkillReconciler({manager,apiOrigin:'http://127.0.0.1:8080',agentId:binding.scope.agentId,nativeFetch:async(url,options)=>{
    if(url.pathname==='/internal/agent/position-skills')return response(phase===0?[prepare]:phase===1?[activation]:[])
    assert.equal(url.pathname,'/internal/agent/position-skills/results');const e=JSON.parse(options.body);results++
    assert.equal(e.data.evidence.outcome,phase===0?'PREPARED':'APPLIED');phase++
    return response(replyMessage(e,'work.result.receipt','receipt_'+phase,'E0','committed',{
      schemaVersion:2,skillChangeId:e.data.skillChangeId,commandId:e.data.commandId,attempt:e.data.attempt,receiptStatus:'ACCEPTED'}))
  }})
  assert.deepEqual(await runner.poll(),{processed:2});assert.equal(downloads,1);assert.equal(results,2)
  assert.equal(manager.listInstalledSkills()[0].enabled,true);assert.equal(manager.pendingResults().length,0)
  assert.deepEqual(await runner.poll(),{processed:0});assert.equal(downloads,1)
})
test('position recovery does not steal market results or invent receipt acknowledgments',async()=>{
  const manager={pendingResults:()=>[{envelope:{messageType:'work.result',data:{schemaVersion:2,skillChangeId:'sc_market'}}}],handle:()=>assert.fail('market result is owned by normal management transport')}
  const runner=new PositionSkillReconciler({manager,apiOrigin:'https://api.test',agentId:'agent1',nativeFetch:async(url,options)=>{assert.equal(options.method,undefined);return response([])}})
  assert.deepEqual(await runner.poll(),{processed:0})
})

test('chapter heading without subtitle is structural, not a paragraph',()=>{
  const m=JSON.parse(buildArchive(source('第一回\n旧版本正文。\n第二回\n后一章正文。')).manifestJson)
  assert.equal(m.chapterCount,2);assert.equal(m.chapters[0].paragraphs[0].text,'旧版本正文。')
})

test('parser failure gets a durable safe receipt and does not starve the next book',async()=>{
  const base={agentId:'agent1',state:'WAITING',installationId:'g1-1',packageDigest:'sha256:'+'a'.repeat(64),manifestSha256:'b'.repeat(64),skillKey:'archive-maintenance',mode:'DRAFT_ONLY'}
  const jobs=[{...base,jobId:'bad'},{...base,jobId:'good'}],results=[]
  const manager={listInstalledSkills:()=>[{skillInstallationId:'g1-1',active:true,enabled:true,kind:'EXECUTABLE',packageSha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),manifest:{skillKey:'archive-maintenance',runner:'local-script'}}]}
  const runner=new ArchiveJobReconciler({manager,apiOrigin:'https://api.test',agentId:'agent1',execute:async(_installed,data)=>{if(data.workId==='bad')throw Object.assign(new Error('private details'),{code:'ARCHIVE_SCRIPT_FAILED'});return buildArchive(data)},nativeFetch:async(url,options)=>{
    if(url.pathname==='/internal/archive/v1/jobs')return response(jobs)
    const id=url.pathname.split('/').at(-2)
    if(url.pathname.endsWith('/source'))return response(source('正文',id))
    if(options.method!=='POST')return response({state:'WAITING'})
    const body=JSON.parse(options.body);results.push(body)
    return response(body.errorCode?{jobId:id,state:'FAILED',errorCode:body.errorCode}:{jobId:id,state:'DRAFT',resultDigest:body.manifestFileSha256})
  }})
  assert.deepEqual(await runner.poll(),{processed:2});assert.equal(results[0].errorCode,'ARCHIVE_SCRIPT_FAILED');assert.ok(!JSON.stringify(results).includes('private details'));assert.ok(results[1].manifestJson)
})

test('a durable publication CAS conflict does not starve the next book and cannot masquerade as published',async()=>{
  const base={agentId:'agent1',state:'WAITING',installationId:'g1-1',packageDigest:'sha256:'+'a'.repeat(64),manifestSha256:'b'.repeat(64),skillKey:'archive-maintenance',mode:'AUTO'}
  const jobs=[{...base,jobId:'stale'},{...base,jobId:'good'}],states=[]
  const manager={listInstalledSkills:()=>[{skillInstallationId:'g1-1',active:true,enabled:true,kind:'EXECUTABLE',packageSha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),manifest:{skillKey:'archive-maintenance',runner:'local-script'}}]}
  const runner=new ArchiveJobReconciler({manager,apiOrigin:'https://api.test',agentId:'agent1',execute:async(_i,s)=>buildArchive(s),nativeFetch:async(url,options)=>{
    if(url.pathname==='/internal/archive/v1/jobs')return response(jobs)
    const id=url.pathname.split('/').at(-2)
    if(url.pathname.endsWith('/source'))return response(source('正文',id))
    if(options.method!=='POST')return response({state:'WAITING'})
    const result=JSON.parse(options.body),state=id==='stale'?'FAILED':'PUBLISHED';states.push(state)
    return response({jobId:id,state,errorCode:id==='stale'?'ARCHIVE_EDITION_CONFLICT':null,resultDigest:result.manifestFileSha256})
  }})
  assert.deepEqual(await runner.poll(),{processed:2});assert.deepEqual(states,['FAILED','PUBLISHED'])
})
