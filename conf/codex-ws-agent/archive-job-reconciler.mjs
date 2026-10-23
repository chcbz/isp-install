import { spawn } from 'node:child_process'
import { resolveSkillEntrypoint } from './skill-manifest.mjs'
const fail = code => { throw Object.assign(new Error(code),{ code }) }
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value)

/** Executes only an installed, measured local script. Source snapshots are input data, never instructions or paths.
 * Re-running the pure parser is safe; the fixed backend job/result identity owns publication idempotency. */
export class ArchiveJobReconciler {
  constructor({ manager,nativeFetch,apiOrigin,agentId,current=()=>true,execute=executeArchiveScript }) {
    this.manager=manager;this.fetch=nativeFetch;this.origin=new URL(apiOrigin).origin;this.agentId=agentId
    this.current=current;this.execute=execute;this.inFlight=null
  }
  poll(){if(!this.inFlight)this.inFlight=this.run().finally(()=>{this.inFlight=null});return this.inFlight}
  async json(path,options={}) {
    const r=await this.fetch(new URL(path,this.origin),options)
    if(!r.ok)throw Object.assign(new Error('ARCHIVE_NATIVE_REJECTED'),{code:'ARCHIVE_NATIVE_REJECTED',status:r.status})
    const w=await r.json()
    if(w?.protocolVersion!==1 || w.code!=='E0' || !Object.hasOwn(w,'data'))fail('ARCHIVE_WIRE_INVALID')
    return w.data
  }
  installed(job) {
    const found=this.manager.listInstalledSkills().find(i=>i.installationId===job.installationId)
    if(!found || `sha256:${found.packageSha256}`!==job.packageDigest || found.manifestSha256!==job.manifestSha256
        || found.manifest?.skillKey!==job.skillKey || found.manifest.runner!=='local-script')fail('ARCHIVE_SKILL_NOT_READY')
    return found
  }
  async run(){
    if(!this.current())return {processed:0}
    const jobs=await this.json('/internal/archive/v1/jobs');if(!Array.isArray(jobs))fail('ARCHIVE_WIRE_INVALID')
    let processed=0
    for(const job of jobs){
      if(!id(job?.jobId)||job.agentId!==this.agentId||job.state!=='WAITING')fail('ARCHIVE_JOB_INVALID')
      if(!this.current())fail('ARCHIVE_SESSION_CHANGED')
      const path=`/internal/archive/v1/jobs/${job.jobId}`
      const prior=await this.json(`${path}/result`)
      if(['DRAFT','PUBLISHED','FAILED'].includes(prior?.state))continue
      const installed=this.installed(job)
      const source=await this.json(`${path}/source`)
      let result
      try { result=await this.execute(installed,source) }
      catch(error) {
        if(!['ARCHIVE_SCRIPT_FAILED','ARCHIVE_SCRIPT_RESULT_INVALID'].includes(error.code))throw error
        this.installed(job)
        if(!this.current())fail('ARCHIVE_SESSION_CHANGED')
        const failed=await this.json(`${path}/result`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({manifestJson:null,manifestFileSha256:null,errorCode:error.code})})
        if(failed?.jobId!==job.jobId || failed.state!=='FAILED' || failed.errorCode!==error.code)fail('ARCHIVE_RECEIPT_INVALID')
        processed++;continue
      }
      this.installed(job)
      if(!this.current())fail('ARCHIVE_SESSION_CHANGED')
      const receipt=await this.json(`${path}/result`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)})
      const publicationConflict=job.mode==='AUTO' && receipt?.state==='FAILED' && receipt.errorCode==='ARCHIVE_EDITION_CONFLICT'
      if(receipt?.jobId!==job.jobId || receipt.resultDigest!==result.manifestFileSha256
          || (!publicationConflict && !(job.mode==='AUTO'?['PUBLISHED']:['DRAFT','PUBLISHED']).includes(receipt.state)))fail('ARCHIVE_RECEIPT_INVALID')
      processed++
    }return {processed}
  }
}
export async function executeArchiveScript(installation,source){
  const entrypoint=resolveSkillEntrypoint(installation.packageRoot,installation.manifest.entrypoint)
  if(!entrypoint.endsWith('.mjs'))fail('ARCHIVE_SCRIPT_TYPE_INVALID')
  return new Promise((resolve,reject)=>{
    // Do not inherit API credentials, user HOME, provider tokens, or shell startup files.
    const child=spawn(process.execPath,[entrypoint],{cwd:installation.packageRoot,env:{PATH:process.env.PATH||'',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe'],windowsHide:true})
    let output='';child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk})
    child.stderr.resume();child.on('error',reject)
    child.on('close',code=>{if(code!==0)return reject(Object.assign(new Error('ARCHIVE_SCRIPT_FAILED'),{code:'ARCHIVE_SCRIPT_FAILED'}));try{resolve(JSON.parse(output))}catch{reject(Object.assign(new Error('ARCHIVE_SCRIPT_RESULT_INVALID'),{code:'ARCHIVE_SCRIPT_RESULT_INVALID'}))}})
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(source))
  })
}
