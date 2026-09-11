// Run: node tests/media-formats.cjs (Node 18+, curl, ffmpeg, and ffprobe).
// Exercises the actual embedded WASM decoder and MP3 encoder without a browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = id => html.match(new RegExp('<script id="' + id + '"[^>]*>([\\s\\S]*?)</script>'))[1];
for (const id of ['app-source', 'decoder-source', 'worker-source', 'encoder-source', 'recording-time-source', 'transcription-source']) new vm.Script(source(id));

// Minimal DOM/Worker stand-ins for the application's import and lifecycle logic.
function applicationContext() {
  const elements = new Map();
  const element = () => ({value: 0, textContent: '', hidden: false, disabled: false,
    addEventListener() {}, replaceChildren() {}, focus() {}, removeAttribute() {}, load() {}, pause() {}});
  const document = {getElementById(id) {
    if (!elements.has(id)) elements.set(id, {...element(), textContent: id.endsWith('-source') ? source(id) : ''});
    return elements.get(id);
  }};
  let nativeResult = null;
  const context = vm.createContext({document, console, URL, Blob, File: class {}, WebAssembly,
    DOMException, AbortController, setTimeout, clearTimeout, navigator: {},
    fetch: async () => {throw new Error('offline');},
    Worker: class {postMessage() {} terminate() {this.stopped = true;}},
    OfflineAudioContext: class {
      async decodeAudioData() {if (!nativeResult) throw new Error('Unsupported codec'); return nativeResult;}
      createBuffer(channels, length, sampleRate) {
        const data = Array.from({length: channels}, () => new Float32Array(length));
        return {length, sampleRate, numberOfChannels: channels, duration: length / sampleRate, getChannelData: i => data[i]};
      }
    }, addEventListener() {}
  });
  context.window = context;
  vm.runInContext(source('app-source').replace(/\}\)\(\);\s*$/, 'globalThis.test = {isMedia, isVideo, decodeClip, loadMediaDecoder, workerClient};})();'), context);
  return {context, setNative: value => {nativeResult = value;}};
}

async function testApplication() {
  const {context, setNative} = applicationContext();
  const {isMedia, isVideo, decodeClip, loadMediaDecoder, workerClient} = context.test;
  const media = (name, type = '', size = 20) => ({name, type, size, arrayBuffer: async () => new ArrayBuffer(8)});
  for (const name of ['sound.MP3', 'sound.WMA', 'sound.opus', 'movie.MOV', 'movie.mkv', 'movie.avi']) assert(isMedia(media(name)), name);
  assert(isMedia(media('no-extension', 'video/mp4')));
  assert(isMedia(media('no-extension', 'audio/mpeg')));
  assert(!isMedia(media('notes.txt', 'text/plain')));
  assert(!isMedia(media('empty.mp3', 'audio/mpeg', 0)));
  assert(isVideo(media('movie.MOV')));
  const native = {length: 4, sampleRate: 44100, numberOfChannels: 2};
  setNative(native);
  assert.equal(await decodeClip({file: media('sound.m4a')}, {canceled: false}), native);
  const pcm = new Uint8Array(new Float32Array([0.25, -0.5, 0.125, 0.75]).buffer);
  const job = {canceled: false, decoder: {request: async () => ({pcm})}};
  const video = await decodeClip({file: media('movie.MOV')}, job);
  assert.equal(video.length, 2);
  assert.equal(video.getChannelData(0)[0], 0.25);
  assert.equal(video.getChannelData(1)[1], 0.75);
  setNative(null);
  assert.equal((await decodeClip({file: media('sound.wma')}, job)).length, 2);
  await assert.rejects(decodeClip({file: media('movie.mp4')}, {canceled: true}), {name: 'AbortError'});
  const offlineJob = {canceled: false, coreURLs: []};
  await assert.rejects(loadMediaDecoder(offlineJob), /internet connection/);
  assert.equal(offlineJob.assetController, null);
  const client = workerClient('decoder');
  const pending = client.request('decode');
  client.stop();
  await assert.rejects(pending, {name: 'AbortError'});
  console.log('PASS file selection, native decoding, fallback, video extraction, offline error, and cancellation');
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jew-test-'));
const cache = process.env.FFMPEG_CORE_DIR || path.join(os.tmpdir(), 'jew-ffmpeg-core-0.12.10');
fs.mkdirSync(cache, {recursive: true});
for (const name of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  const target = path.join(cache, name);
  if (!fs.existsSync(target)) execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--max-time', '120',
    'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/' + name, '--output', target]);
}

// WORKERFS uses FileReaderSync on slices of a File in the browser.
const fileBlob = bytes => ({size: bytes.length, bytes, slice: (start, end) => fileBlob(bytes.subarray(start, end))});
let reply;
const decoder = vm.createContext({console, URL, WebAssembly, Uint8Array, ArrayBuffer, Blob,
  TextDecoder, TextEncoder, performance, atob, btoa,
  FileReaderSync: class {readAsArrayBuffer(blob) {return Uint8Array.from(blob.bytes).buffer;}},
  self: {location: {href: 'https://test.invalid/decoder.js'}, postMessage: message => {reply = message;}}
});
decoder.importScripts = () => {
  vm.runInContext(fs.readFileSync(path.join(cache, 'ffmpeg-core.js'), 'utf8'), decoder);
  const create = decoder.createFFmpegCore;
  decoder.createFFmpegCore = options => create({...options, wasmBinary: fs.readFileSync(path.join(cache, 'ffmpeg-core.wasm'))});
};
vm.runInContext(source('decoder-source'), decoder);
let serial = 0;
async function request(type, data = {}) {
  reply = null;
  await decoder.self.onmessage({data: {id: ++serial, type, ...data}});
  assert(reply, 'worker responds');
  if (reply.error) throw new Error(reply.error);
  return reply;
}
const encoder = vm.createContext({Blob, self: {postMessage: message => {reply = message;}}});
vm.runInContext(source('encoder-source') + '\n' + source('worker-source'), encoder);
const dates=vm.createContext({window:{}});vm.runInContext(source('recording-time-source'),dates);
function encode(type, data = {}) {
  reply = null;
  encoder.self.onmessage({data: {id: ++serial, type, ...data}});
  assert(!reply.error, reply.error);
  return reply;
}
function fixture(name, audioCodec, video = false, frequency = 440, extra = []) {
  const target = path.join(temp, name);
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=0.25`];
  if (video) args.push('-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=12:d=0.25', '-map', '1:v:0', '-map', '0:a:0', '-c:v', video);
  args.push('-c:a', audioCodec, ...extra, target);
  execFileSync('ffmpeg', args, {stdio: 'pipe'});
  return fileBlob(fs.readFileSync(target));
}

(async () => {
  try {
    await testApplication();
    await request('init', {coreURL: 'https://test.invalid/core.js', wasmURL: 'https://test.invalid/core.wasm'});
    const metadataClips=[];
    for(const [name,time,video] of [['later.m4a','2026-09-11T14:36:00Z',false],['earlier.mov','2026-09-11T14:32:00Z','mpeg4']]){
      const file=fixture(name,'aac',video,440,['-metadata','creation_time='+time]);
      const {metadata}=await request('metadata',{file});
      const recordedAt=dates.window.JEWRecordingTime.fromMetadata(metadata);
      assert.equal(recordedAt,Date.parse(time),name+' embedded recording time');
      metadataClips.push({id:metadataClips.length+1,name,recordedAt});
    }
    metadataClips.sort(dates.window.JEWRecordingTime.compare);
    assert.deepEqual(metadataClips.map(clip=>clip.name),['earlier.mov','later.m4a']);
    assert.equal(dates.window.JEWRecordingTime.fromMetadata((await request('metadata',{file:fixture('undated.wav','pcm_s16le')})).metadata),null);
    console.log('PASS embedded MOV/M4A recording times, mixed order, and missing date');
    encode('init');
    let totalFrames = 0;
    const formats = [
      ['memo.m4a', 'aac'], ['song.mp3', 'libmp3lame'], ['sound.wav', 'pcm_s16le'],
      ['sound.aiff', 'pcm_s16be'], ['sound.caf', 'pcm_s16le'], ['sound.flac', 'flac'],
      ['sound.ogg', 'libvorbis'], ['sound.opus', 'libopus'], ['sound.wma', 'wmav2'], ['sound.aac', 'aac'],
      ['iPhone.MOV', 'aac', 'mpeg4'], ['video.mp4', 'aac', 'mpeg4'],
      ['video.webm', 'libopus', 'libvpx'], ['video.mkv', 'flac', 'mpeg4'],
      ['video.avi', 'pcm_s16le', 'mpeg4'], ['video.mpg', 'mp2', 'mpeg2video'],
      ['video.wmv', 'wmav2', 'wmv2'], ['video.flv', 'libmp3lame', 'flv']
    ];
    const expectedFrequencies = [];
    for (let index = 0; index < formats.length; index++) {
      const [name, codec, video] = formats[index];
      const frequency = 300 + index * 60;
      const {pcm} = await request('decode', {file: fixture(name, codec, video, frequency)});
      const frames = pcm.length / 8;
      const nativeFrames = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(temp, name), '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '44100', '-f', 'f32le', '-']).length / 8;
      assert(frames > 0 && Math.abs(frames - nativeFrames) < 2048, `${name}: WASM ${frames} frames, native ${nativeFrames} frames`);
      totalFrames += frames;
      const floats = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      const left = new Int16Array(frames), right = new Int16Array(frames);
      let peak = 0;
      for (let i = 0; i < frames; i++) {
        const l = floats.getFloat32(i * 8, true), r = floats.getFloat32(i * 8 + 4, true);
        assert(Number.isFinite(l) && Number.isFinite(r));
        peak = Math.max(peak, Math.abs(l));
        left[i] = Math.round(Math.max(-1, Math.min(1, l)) * (l < 0 ? 32768 : 32767));
        right[i] = Math.round(Math.max(-1, Math.min(1, r)) * (r < 0 ? 32768 : 32767));
      }
      assert(peak > 0.02, `${name}: audible extracted audio`);
      encode('encode', {left, right});
      expectedFrequencies.push({frequency, frames});
      console.log('PASS', name);
    }
    const {blob} = encode('finish');
    const mp3 = path.join(temp, 'mixed.mp3');
    fs.writeFileSync(mp3, Buffer.from(await blob.arrayBuffer()));
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', mp3]));
    assert.equal(info.streams.length, 1);
    assert.equal(info.streams[0].codec_type, 'audio');
    assert.equal(info.streams[0].codec_name, 'mp3');
    assert.equal(info.streams[0].channels, 2);
    assert(Math.abs(Number(info.format.duration) - totalFrames / 44100) < 0.1);
    const decoded = execFileSync('ffmpeg', ['-v', 'error', '-i', mp3, '-f', 'f32le', '-ac', '1', '-ar', '44100', '-']);
    let offset = 0;
    for (const {frequency, frames} of expectedFrequencies) {
      const start = offset + Math.floor(frames * 0.35), end = offset + Math.floor(frames * 0.75);
      let crossings = 0;
      for (let i = start + 1; i < end; i++) if (decoded.readFloatLE((i - 1) * 4) < 0 && decoded.readFloatLE(i * 4) >= 0) crossings++;
      assert(Math.abs(crossings * 44100 / (end - start) - frequency) < 20, 'joined clip order preserved');
      offset += frames;
    }
    console.log('PASS mixed-format MP3: audio only, duration and clip order');

    const silent = path.join(temp, 'no-audio.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=32x32:d=0.1', '-an', '-c:v', 'mpeg4', silent]);
    await assert.rejects(request('decode', {file: fileBlob(fs.readFileSync(silent))}), /no audio track/);
    await assert.rejects(request('decode', {file: fileBlob(Buffer.from('not valid media'))}), /Could not read the audio/);
    await request('decode', {file: fixture('after-error.wav', 'pcm_s16le')});
    console.log('PASS missing audio, corrupt media, and recovery after errors');
  } finally {fs.rmSync(temp, {recursive: true, force: true});}
})().catch(error => {console.error(error); process.exitCode = 1;});
