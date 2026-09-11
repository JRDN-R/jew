// Run: node tests/transcription.cjs. No API key or external requests required.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const source=id=>html.match(new RegExp('<script id="'+id+'"[^>]*>([\\s\\S]*?)</script>'))[1];
for(const id of ['transcription-source','app-source'])new vm.Script(source(id));
const success=text=>({ok:true,json:async()=>({status:'completed',steps:[{type:'model_output',content:[{type:'text',text,
  annotations:[{type:'word_info',speaker:'spk_1',start_offset:'1.5s'}]}]}]})});
let requests=[],respond=()=>success('Plain words.');
const context=vm.createContext({window:{},URL,Blob,DOMException,AbortController,setTimeout,clearTimeout,btoa,
  fetch:async(url,options)=>{requests.push({url,options});return respond(url,options);}});
vm.runInContext(source('transcription-source'),context);
const api=context.window.JEWTranscription;

async function testAPI(){
  const bytes=api.wav(new Float32Array([-2,-0.5,0,0.5,2]));
  const view=new DataView(bytes.buffer);
  assert.equal(Buffer.from(bytes.subarray(0,4)).toString(),'RIFF');
  assert.equal(view.getUint32(24,true),16000);
  assert.equal(view.getUint16(22,true),1);
  assert.equal(view.getUint16(34,true),16);
  assert.equal(view.getInt16(44,true),-32768);
  assert.equal(view.getInt16(52,true),32767);
  assert.equal(api.transcriptText(await success('<hello> The time is 12:30.').json()),'<hello> The time is 12:30.');
  assert.throws(()=>api.transcriptText({status:'failed'}),/did not finish/);
  assert.throws(()=>api.transcriptText({}),/unreadable/);

  const audio=new Float32Array(api.MAX_SAMPLES+4000).fill(0.1);
  const words=[];
  await api.transcribe(audio,'test-key',new AbortController().signal,(text,fraction)=>words.push({text,fraction}));
  assert.equal(requests.length,2);
  let frames=0;
  for(const {url,options} of requests){
    assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(options.headers['x-goog-api-key'],'test-key');
    assert(!url.includes('test-key'));
    assert(options.body.length<20*1000*1000,'request below inline size limit');
    const body=JSON.parse(options.body);
    assert.equal(body.model,'gemini-3.5-transcribe');
    assert.equal(body.store,false);
    assert.deepEqual(body.generation_config,{transcription_config:{mode:{type:'verbatim'}}});
    assert.equal(body.input.length,1);
    assert.equal(body.input[0].type,'audio');
    assert.equal(body.input[0].mime_type,'audio/wav');
    frames+=(Buffer.from(body.input[0].data,'base64').length-44)/2;
  }
  assert.equal(frames,audio.length,'chunks cover every audio sample exactly once');
  assert.equal(words[1].fraction,1);
  const quiet=audio.slice();quiet.fill(0,api.MAX_SAMPLES-8000,api.MAX_SAMPLES-4000);
  const end=api.chunkEnd(quiet,0);assert(end>api.MAX_SAMPLES-8000&&end<api.MAX_SAMPLES-4000,'split at quiet interval');
  console.log('PASS WAV encoding, bounded chunks, plain-text response and exact request configuration');

  requests=[];respond=()=>({ok:false,status:429});
  await assert.rejects(api.transcribe(audio,'test-key',new AbortController().signal,()=>{}),/usage limit/);
  assert.equal(requests.length,1,'no automatic retry or alternate billed model');
  respond=()=>({ok:false,status:403});
  await assert.rejects(api.request(bytes,'test-key',new AbortController().signal),/does not have access/);
  const canceled=new AbortController();canceled.abort();
  const before=requests.length;
  await assert.rejects(api.request(bytes,'test-key',canceled.signal),{name:'AbortError'});
  assert.equal(requests.length,before,'canceled jobs do not upload');
  respond=(_,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Canceled','AbortError'))));
  const active=new AbortController();const pending=api.request(bytes,'test-key',active.signal);active.abort();
  await assert.rejects(pending,{name:'AbortError'});
  console.log('PASS quota and credential errors, cancellation before/during upload');
}

function appHarness(){
  const elements=new Map(),events={};
  const node=()=>({value:'',textContent:'',hidden:false,disabled:false,dataset:{},style:{},classList:{add(){},remove(){}},
    setAttribute(){},addEventListener(){},replaceChildren(){},append(){},focus(){},removeAttribute(){},load(){},pause(){},select(){}});
  const document={getElementById(id){if(!elements.has(id))elements.set(id,node());return elements.get(id);},
    createElement:node,createElementNS:()=>({...node(),namespaceURI:'http://www.w3.org/2000/svg'}),querySelector(){return null;},querySelectorAll(){return [];}};
  const ctx=vm.createContext({document,navigator:{},Blob,File:class{},URL,AbortController,DOMException,setTimeout,clearTimeout,
    WebAssembly,Worker:class{},addEventListener:(name,fn)=>{events[name]=fn;},
    OfflineAudioContext:class{
      createBufferSource(){return{connect(){},start(){},disconnect(){}};}
      async startRendering(){return{getChannelData:()=>new Float32Array([0.1,0.2])};}
    }});
  ctx.window=ctx;
  vm.runInContext(source('recording-time-source'),ctx);
  vm.runInContext(source('app-source').replace(/\}\)\(\);\s*$/,
    'globalThis.test={clips,transcribeAll,updateTranscript,invalidateResults,readRecordingTimes,get busy(){return busy;},get output(){return output;},setDecode(fn){decodeClip=fn;},setMetadataLoader(fn){loadMediaDecoder=fn;},setOutput(value){output=value;}};})();'),ctx);
  ctx.JEWTranscription={RATE:16000,transcribe:async(samples,key,signal,onChunk)=>onChunk('first',1)};
  ctx.test.setDecode(async()=>({duration:0.1}));
  ctx.test.clips.push({id:1,file:{name:'first.mov',size:20},duration:0.1},{id:2,file:{name:'second.wav',size:20},duration:0.1});
  document.getElementById('geminiKey').value='test-key';
  return{ctx,element:id=>document.getElementById(id),events};
}

async function testApp(){
  const {ctx,element,events}=appHarness();let calls=0;
  ctx.JEWTranscription.transcribe=async(samples,key,signal,onChunk)=>{calls++;onChunk(calls===1?'First clip.':'Second clip.',1);};
  ctx.test.setOutput({existing:true});
  await ctx.test.transcribeAll();
  assert.equal(element('transcriptText').value,'First clip.\n\nSecond clip.');
  assert.equal(calls,2);
  assert(ctx.test.output.existing,'transcription preserves existing MP3');
  assert.equal(element('downloadTranscript').hidden,false);
  let copied,shared;
  ctx.navigator.clipboard={writeText:async text=>{copied=text;}};
  ctx.navigator.share=async payload=>{shared=payload.text;};
  await element('copyTranscript').onclick();await element('shareTranscript').onclick();
  assert.equal(copied,'First clip.\n\nSecond clip.');assert.equal(shared,copied);
  ctx.navigator.share=async()=>{throw new Error('Share unavailable');};
  await element('shareTranscript').onclick();assert.match(element('copyStatus').textContent,/Download TXT/);
  assert.equal(ctx.test.busy,false);assert.equal(element('geminiKey').disabled,false);
  assert.equal(element('progressArea').hidden,true);
  calls=0;
  ctx.JEWTranscription.transcribe=async(samples,key,signal,onChunk)=>{if(++calls===2)throw new Error('usage limit');onChunk('Keep this text.',1);};
  await ctx.test.transcribeAll();
  assert.equal(element('transcriptText').value,'Keep this text.');
  assert.match(element('transcriptInfo').textContent,/Incomplete/);
  assert.match(element('error').textContent,/second.wav/);
  ctx.JEWTranscription.transcribe=async(samples,key,signal,onChunk)=>{
    onChunk('Keep partial.',0.5);element('cancelButton').onclick();
    assert(signal.aborted);throw new DOMException('Canceled','AbortError');
  };
  await ctx.test.transcribeAll();
  assert.equal(element('transcriptText').value,'Keep partial.');
  assert.match(element('transcriptInfo').textContent,/Canceled/);
  assert.equal(element('transcribeButton').disabled,false);
  ctx.test.setOutput(null);ctx.test.invalidateResults();
  assert.equal(element('transcriptText').value,'');assert.equal(element('transcriptResult').hidden,true);
  events.pagehide();assert.equal(element('geminiKey').value,'');
  console.log('PASS queue order, copy/download state, partial recovery, cancel UI, and key cleanup');
}

async function testRecordingTimes(){
  const {ctx,element}=appHarness();
  const times={'first.mov':'2026-09-11T10:36:00-04:00','second.wav':'2026-09-11T14:32:00Z','added.m4a':'2026-09-11T14:30:00Z'};
  let release;const gate=new Promise(resolve=>{release=resolve;});
  let requests=0;
  ctx.test.setMetadataLoader(async job=>{await gate;job.decoder={stop(){},request:async(type,{file})=>{
    if(requests++===0)ctx.test.clips.push({id:3,file:{name:'added.m4a',size:20},dateChecked:false});
    return{metadata:{format:{tags:{creation_time:times[file.name]}}}};
  }};});
  const scan=ctx.test.readRecordingTimes();
  assert.equal(element('exportButton').disabled,true);assert.equal(element('transcribeButton').disabled,true);
  release();await scan;
  assert.deepEqual(Array.from(ctx.test.clips,clip=>clip.file.name),['added.m4a','second.wav','first.mov']);
  assert.equal(element('exportButton').disabled,false);assert.equal(element('transcribeButton').disabled,false);
  const dates=ctx.JEWRecordingTime;
  assert.equal(dates.fromMetadata({format:{tags:{date:'2026-09-11'}}}),null,'date without time is not invented midnight');
  assert.equal(dates.fromMetadata({format:{tags:{creation_time:'1904-01-01T00:00:00Z'}}}),null);
  assert.equal(dates.fromMetadata({format:{tags:{'com.apple.quicktime.creationdate':'2026-09-11T10:32:00-0400',creation_time:'2026-09-12T12:00:00Z'}}}),Date.parse('2026-09-11T14:32:00Z'));
  const fallback=[{id:3,fileTime:null},{id:2,fileTime:20},{id:4,fileTime:20},{id:1,recordedAt:10}].sort(dates.compare);
  assert.deepEqual(fallback.map(clip=>clip.id),[1,2,4,3]);
  ctx.test.clips.forEach((clip,i)=>{clip.dateChecked=false;clip.recordedAt=null;clip.fileTime=3-i;});
  ctx.test.setMetadataLoader(async()=>{throw new Error('offline');});await ctx.test.readRecordingTimes();
  assert.deepEqual(Array.from(ctx.test.clips,clip=>clip.fileTime),[1,2,3]);
  assert.match(element('dateStatus').textContent,/could not be read/);
  console.log('PASS sorting across batches, time zones, missing dates, stable ties, and offline fallback');
}

(async()=>{await testAPI();await testApp();await testRecordingTimes();})().catch(error=>{console.error(error);process.exitCode=1;});
