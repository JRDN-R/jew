# Just Encode Whatever

Add audio or video files, arrange the clips, and export their audio as one stereo MP3 at 192 kbps. Files stay on your device.

- Common audio inputs: MP3, M4A, AAC, WAV, AIFF, CAF, FLAC, OGG, Opus, WMA, and more.
- Common video inputs: MOV, MP4, WebM, MKV, AVI, MPEG, WMV, FLV, and more. Export uses the first audio track and excludes video, subtitles, and data tracks.
- Selection order is preserved. Use the arrows to change it before exporting.
- Corrupt files, unsupported codecs, and videos without audio produce an error; the queue stays available to edit and retry.
- Preview playback depends on browser support; a file that cannot preview can still convert.

## How it works

Serve `index.html` on any static HTTPS host, including GitHub Pages. No build step or backend is required.

Browser-supported audio uses Web Audio directly. Video and other audio formats use the single-thread [FFmpeg.wasm core 0.12.10](https://www.npmjs.com/package/@ffmpeg/core/v/0.12.10), downloaded on demand from jsDelivr (about 31 MB before compression). An internet connection is needed for this download if it is not already cached. No media is uploaded. The single-thread core does not require SharedArrayBuffer or cross-origin isolation headers.

The decoder reads each source file through WORKERFS and produces stereo 44.1 kHz PCM. The embedded [lamejs](https://github.com/zhuker/lamejs) encoder combines clips into a single MP3. Cancel stops decoder downloads and both workers; temporary decoder URLs and files are released. Large clips still require device memory for decoded audio. DRM-protected media and some codecs are unsupported.

FFmpeg.wasm core is an upstream binary loaded at runtime; its [source and license information](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10) are maintained upstream. The existing lamejs source and license notice remain embedded in the page.

## Verification

Run `node tests/media-formats.cjs` with Node 18+, `curl`, `ffmpeg`, and `ffprobe` installed. The test downloads the pinned decoder into a temporary cache, generates audio/video fixtures, and runs the actual embedded decoder and encoder. It checks common formats, MP3 stream type and duration, clip order, missing audio, corrupt files, file selection, native/fallback routing, download errors, and cancellation. Set `FFMPEG_CORE_DIR` to use an existing directory containing `ffmpeg-core.js` and `ffmpeg-core.wasm`.

These checks run without a browser. Device-specific preview, file-picker, and sharing behavior require testing on the target device.
