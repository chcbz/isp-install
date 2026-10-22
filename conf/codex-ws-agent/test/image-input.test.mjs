import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImageMagick, MagickFormat, MagickImageCollection } from '@imagemagick/magick-wasm'
import { normalizeImageInput, detectImageInput, IMAGE_INPUT_MIMES } from '../image-input.mjs'
import { buildMaterialsInputs } from '../materials-input.mjs'
const seed = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4XmNgAAIAAAUAAQYUdaMAAAAASUVORK5CYII=', 'base64')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const make = format => ImageMagick.read(seed, image => image.write(format, bytes => Buffer.from(bytes)))
for (const [mime, format] of [['image/png',MagickFormat.Png],['image/jpeg',MagickFormat.Jpeg],['image/webp',MagickFormat.WebP],['image/gif',MagickFormat.Gif],['image/bmp',MagickFormat.Bmp],['image/tiff',MagickFormat.Tiff],['image/avif',MagickFormat.Avif]]) {
  test(`${mime}: real decode, PNG derivative and original receipt`, t => {
    const bytes = make(format), normalized = normalizeImageInput(bytes, mime)
    assert.equal(detectImageInput(normalized.bytes).mime, 'image/png')
    assert.equal(normalized.provenance.sourceSha256, hash(bytes))
    assert.equal(normalized.provenance.sha256, hash(normalized.bytes))
    const dir = mkdtempSync(join(tmpdir(), 'cyf-image-test-')); t.after(() => rmSync(dir,{recursive:true,force:true}))
    const path = join(dir, 'misleading.txt'); writeFileSync(path, bytes, {mode:0o400})
    const result = buildMaterialsInputs({ inputs: [{inputRef:'input_1', bytes, sha256:hash(bytes), byteLength:String(bytes.length),contentMimeType:mime,path}],
      supportedInputs: [{mimeType:mime,carrier:'LOCAL_IMAGE',carrierContractDigest:`sha256:${'a'.repeat(64)}`}],
      adapters:{localImage:{supportedMimeTypes:['image/png'],toNativeInput:({path})=>({type:'localImage',path})}},
      authorizationId:'materials_test',snapshotDigest:'b'.repeat(64)})
    assert.equal(result.nativeInputs.length,1); assert.equal(result.inputReceipts[0].sha256,hash(bytes))
    assert.deepEqual(readFileSync(path),bytes)
    assert.equal(detectImageInput(readFileSync(result.nativeInputs[0].path)).mime,'image/png')
  })
}
test('MIME spoof and damaged content fail explicitly', () => {
  assert.throws(()=>normalizeImageInput(make(MagickFormat.Jpeg),'image/png'),{code:'IMAGE_MIME_MISMATCH'})
  assert.throws(()=>normalizeImageInput(Buffer.from([255,216,255]),'image/jpeg'),{code:'IMAGE_DECODE_FAILED'})
  assert.throws(()=>normalizeImageInput(Buffer.from('<svg/>'),'image/svg+xml'),{code:'IMAGE_FORMAT_UNSUPPORTED'})
})
for (const format of [MagickFormat.Gif,MagickFormat.Tiff,MagickFormat.WebP]) test(`${format}: no silent first frame`,()=>{
  ImageMagick.readCollection(seed, collection => ImageMagick.read(seed, image => {
    image.negate(); image.animationDelay = 10; collection[0].animationDelay = 10
    collection.push(image)
    const bytes=collection.write(format,data=>Buffer.from(data))
    collection.pop()
    assert.throws(()=>normalizeImageInput(bytes),{code:'IMAGE_MULTIFRAME_REQUIRES_SELECTION'})
  }))
})
test('advertised image family is explicit and does not include documents',()=>{
  assert.equal(IMAGE_INPUT_MIMES.length,9);assert.ok(!IMAGE_INPUT_MIMES.includes('application/pdf'))
})

test('native CHAT passes a normalized JPEG path but binds the original receipt', async t => {
  const { prepareChatMaterials } = await import('../materials-chat.mjs')
  const dir=mkdtempSync(join(tmpdir(),'cyf-chat-image-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const bytes=make(MagickFormat.Jpeg),path=join(dir,'original.input');writeFileSync(path,bytes,{mode:0o400})
  const config={mediaKind:'image',mimeType:'image/jpeg',carrier:'LOCAL_IMAGE',carrierContractDigest:`sha256:${'a'.repeat(64)}`}
  const source={...config,sourceRefId:'source_1',sha256:hash(bytes),byteLength:String(bytes.length),bytes,path}
  const result=await prepareChatMaterials({profile:{},message:{},
    materials:{authorizationId:'materials_test',manifestDigest:`sha256:${'b'.repeat(64)}`,manifest:{profile:{supportedInputs:[config]}}},
    materializer:{materialize:async()=>({directory:dir,sources:[source]})},
    profileRuntime:{contractReadback:{measured:true,toolPolicy:'MANIFEST_READ_ONLY',recovery:'durable-inbox-turn-readback-v1',supportedInputs:[config]},mapInputPath:path=>path},
    adapters:{localImage:{supportedMimeTypes:['image/png'],toNativeInput:({path})=>({type:'localImage',path})}}})
  assert.notEqual(result.nativeInputs[0].path,path)
  assert.equal(detectImageInput(readFileSync(result.nativeInputs[0].path)).mime,'image/png')
  assert.equal(result.inspectionInputReceiptDraft.sources[0].sha256,hash(bytes))
})

test('image edit posts a PNG derivative with original and derivative audit hashes', async () => {
  const {createImageProviderRunner}=await import('../skill-runners/image-provider.mjs')
  const bytes=make(MagickFormat.Bmp),normalized=normalizeImageInput(bytes,'image/bmp')
  const binding={ready:true,bindingId:'binding',revision:'1',digest:'a'.repeat(64),model:'test',endpoint:'https://images.example.test',credential:'fixture'}
  let called=false, audited=false
  const sentinel=new Error('stop after verifying request')
  const runner=createImageProviderRunner({bindings:{resolve:async()=>binding},scope:{},fetchFn:async (_url,options)=>{
    called=true;const body=JSON.parse(options.body)
    assert.equal(body.images[0].image_url,`data:image/png;base64,${normalized.bytes.toString('base64')}`)
    assert.deepEqual(Object.keys(body.images[0]),['image_url']);throw sentinel
  }})
  await assert.rejects(runner.run({descriptor:{manifest:{entrypoint:'image-http.edit',requirements:{providerAlias:'image'}}},binding,
    inputs:[{inputRef:'input_1',contentMimeType:'image/bmp',bytes,sha256:hash(bytes),byteLength:String(bytes.length)}],instruction:'test',parameters:{},
    effects:{invoke:async (_id,request,fn)=>{audited=true;assert.equal(request.inputs[0].sha256,hash(bytes));assert.deepEqual(request.derivedInputs[0],normalized.provenance);return fn()}}}),error=>error===sentinel)
  assert.ok(called && audited)
})

for (const mime of ['image/heic','image/heif']) test(`${mime}: pinned real HEVC image decodes without relabelling original bytes`,()=>{
  const bytes=readFileSync(new URL('./fixtures/image-input/gray-hevc.heif',import.meta.url))
  assert.equal(hash(bytes),'d386c35ece16c8bdcf31fb5de150ecc596a94b23d5dd9057a71d0ddfe1261d71')
  const result=normalizeImageInput(bytes,mime)
  assert.equal(result.width,128);assert.equal(result.height,128)
  assert.equal(result.provenance.sourceSha256,hash(bytes));assert.equal(result.provenance.sourceMimeType,'image/heic')
  assert.equal(detectImageInput(result.bytes).mime,'image/png')
})

test('normalization is deterministic across wall-clock seconds (no retry identity drift)',async()=>{
  const bytes=readFileSync(new URL('./fixtures/image-input/gray-hevc.heif',import.meta.url))
  const first=normalizeImageInput(bytes,'image/heif')
  await new Promise(resolve=>setTimeout(resolve,1100))
  const second=normalizeImageInput(bytes,'image/heif')
  assert.deepEqual(second.bytes,first.bytes)
  assert.equal(first.provenance.sha256,'32e22f5cde12802bde690e6d0acb5a6d93c05d5002ff629e10060b5e856bd14d')
})

test('derived input refuses wrong original linkage, tampered bytes and pre-existing symlinks',async t=>{
  const {prepareImageDerivative}=await import('../image-input-file.mjs')
  const {buildTypedInspectionNativeInputs}=await import('../typed-inspection-input-carriers.mjs')
  const {symlinkSync,unlinkSync}=await import('node:fs')
  const dir=mkdtempSync(join(tmpdir(),'cyf-image-provenance-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const bytes=make(MagickFormat.Jpeg),path=join(dir,'original.input');writeFileSync(path,bytes,{mode:0o400})
  const derivative=prepareImageDerivative({path,bytes,mimeType:'image/jpeg'})
  const source={sourceRefId:'source_1',sha256:hash(bytes),byteLength:String(bytes.length),mimeType:'image/jpeg',carrier:'LOCAL_IMAGE',carrierContractDigest:`sha256:${'a'.repeat(64)}`,bytes,path,derivative}
  const request={authorizationId:'materials_test',manifestDigest:`sha256:${'b'.repeat(64)}`,sources:[source],adapters:{localImage:{supportedMimeTypes:['image/png'],toNativeInput:({path})=>({type:'localImage',path})}}}
  for(const patch of [{sourceSha256:'0'.repeat(64)},{bytes:Buffer.from('forged')},{sourceMimeType:'image/bmp'}]){
    assert.throws(()=>buildTypedInspectionNativeInputs({...request,sources:[{...source,derivative:{...derivative,...patch}}]}),{code:'TYPED_INSPECTION_IMAGE_PROVENANCE_INVALID'})
  }
  unlinkSync(derivative.path);symlinkSync(path,derivative.path)
  assert.throws(()=>prepareImageDerivative({path,bytes,mimeType:'image/jpeg'}),{code:'IMAGE_NORMALIZATION_STORAGE_FAILED'})
  assert.deepEqual(readFileSync(path),bytes)
})
