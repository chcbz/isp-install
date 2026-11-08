import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { beginProviderUsage } from '../../skills/native-image/scripts/provider-usage.mjs'
import { pendingProviderUsage } from '../provider-usage-receipts.mjs'
import { acknowledgeNativeUsage } from '../native-usage-receipts.mjs'
function fixture(t) {
  const directory=mkdtempSync(resolve(tmpdir(),'provider-usage-'));t.after(()=>rmSync(directory,{recursive:true,force:true}))
  mkdirSync(resolve(directory,'scratch'),{mode:0o700})
  const store={directory,command:{executionId:'exec'},read(key){const p=resolve(directory,`${key}.json`);return existsSync(p)?JSON.parse(readFileSync(p)):null},write(key,value){writeFileSync(resolve(directory,`${key}.json`),JSON.stringify(value),{mode:0o600})}}
  return {store,journal:resolve(directory,'scratch/.provider-usage')}
}
const config={model:'gpt-image-2.5-flare',usageChannel:'gpt',usageTier:'standard',usagePriceVersion:'fixture',apiKey:'secret'}
const ack=(store,p,revision)=>acknowledgeNativeUsage(store,p,{executionId:'exec',attemptId:'a'.repeat(64),revision,status:'PENDING_USAGE',costYuan:null})
test('start precedes terminal; lost ACK stable; business receipt does not consume costs; scratch cleanup keeps copied source',t=>{
 const {store,journal}=fixture(t);const call=beginProviderUsage({directory:journal,config,mode:'generate'})
 store.write('receipt',{business:'done'})
 const first=pendingProviderUsage(store);assert.equal(first.length,1);assert.equal(first[0].payload.observation.phase,'STARTED')
 assert.equal(JSON.stringify(first).includes('secret'),false)
 call.complete({usage:{input_tokens:1},responseModel:null,providerRequestId:'provider-id'})
 assert.deepEqual(pendingProviderUsage(store),first);ack(store,first[0],'1')
 const terminal=pendingProviderUsage(store);assert.equal(terminal[0].payload.observation.phase,'TERMINAL')
 rmSync(journal,{recursive:true});assert.deepEqual(pendingProviderUsage(store),terminal)
 ack(store,terminal[0],'2');assert.deepEqual(pendingProviderUsage(store),[])
})
test('two calls remain independent and duplicate complete cannot erase actual usage',t=>{
 const {store,journal}=fixture(t)
 const one=beginProviderUsage({directory:journal,config,mode:'edit'});one.complete({usage:{output_tokens:99}});one.complete({usage:null})
 beginProviderUsage({directory:journal,config,mode:'generate'})
 assert.equal(pendingProviderUsage(store).length,2)
 const terminal=readdirSync(journal).find(x=>x.endsWith('-terminal.json'))
 assert.equal(JSON.parse(readFileSync(resolve(journal,terminal))).evidence.usage.output_tokens,99)
})
