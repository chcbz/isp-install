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
  const manager={listInstalledSkills:()=>[{installationId:'grant1-1',packageSha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),manifest:{skillKey:'archive-maintenance',runner:'local-script'}}]}
  const runner=new ArchiveJobReconciler({manager,apiOrigin:'https://api.test',agentId:'agent1',execute:async()=>result,nativeFetch:async(url,options)=>{
    calls.push([url.pathname,options?.method||'GET'])
    if(url.pathname==='/internal/archive/v1/jobs')return response([job])
    if(url.pathname.endsWith('/source'))return response(sourceData)
    return response(options?.method==='POST'?{jobId:'job1',state:'DRAFT',resultDigest:result.manifestFileSha256}:{jobId:'job1',state:'WAITING'})
  }})
  assert.deepEqual(await runner.poll(),{processed:1});assert.equal(calls.filter(c=>c[1]==='POST').length,1)
  job.packageDigest='sha256:'+'c'.repeat(64);await assert.rejects(runner.poll(),/NOT_READY/)
  job.agentId='other';await assert.rejects(runner.poll(),/JOB_INVALID/)
})
test('lost native install receipt is recovered from persisted server state without reinstalling',async()=>{
  const e={grantId:'grant1',fencingToken:'1',deliveryEpoch:'1',installationId:'grant1-1',status:'SUCCEEDED',packageDigest:'sha256:'+'a'.repeat(64),messageId:'m1',commandId:'grant1-1',attempt:1}
  let ack=null
  const manager={pendingResults:()=>[{envelope:e}],acknowledgeResultReceipt:r=>{ack=r},execute:()=>assert.fail('must not reinstall')}
  const runner=new PositionSkillReconciler({manager,apiOrigin:'https://api.test',agentId:'agent1',nativeFetch:async url=>response(url.pathname.endsWith('/receipt')?{grantId:'grant1',revision:'1',physicalInstallationId:'grant1-1',state:'INSTALLED',packageDigest:e.packageDigest,manifestSha256:null,errorCode:null}:[])})
  assert.deepEqual(await runner.poll(),{processed:0});assert.equal(ack.receiptStatus,'ACCEPTED');assert.equal(ack.correlationId,'m1')
})
test('installation receipt from a different generation is not accepted',async()=>{
  let ack=false
  const manager={pendingResults:()=>[{envelope:{grantId:'grant1',fencingToken:'1'}}],acknowledgeResultReceipt:()=>{ack=true}}
  const runner=new PositionSkillReconciler({manager,apiOrigin:'https://api.test',agentId:'agent1',nativeFetch:async url=>response(url.pathname.endsWith('/receipt')?{grantId:'grant1',revision:'2'}:[])})
  await runner.poll();assert.equal(ack,false)
})

test('chapter heading without subtitle is structural, not a paragraph',()=>{
  const m=JSON.parse(buildArchive(source('第一回\n旧版本正文。\n第二回\n后一章正文。')).manifestJson)
  assert.equal(m.chapterCount,2);assert.equal(m.chapters[0].paragraphs[0].text,'旧版本正文。')
})

test('parser failure gets a durable safe receipt and does not starve the next book',async()=>{
  const base={agentId:'agent1',state:'WAITING',installationId:'g1-1',packageDigest:'sha256:'+'a'.repeat(64),manifestSha256:'b'.repeat(64),skillKey:'archive-maintenance',mode:'DRAFT_ONLY'}
  const jobs=[{...base,jobId:'bad'},{...base,jobId:'good'}],results=[]
  const manager={listInstalledSkills:()=>[{installationId:'g1-1',packageSha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),manifest:{skillKey:'archive-maintenance',runner:'local-script'}}]}
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
