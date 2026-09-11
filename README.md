# Just Encode Whatever

Add audio or video files and export their audio as one stereo MP3 at 192 kbps, or transcribe them to plain text with Gemini 3.5 Transcribe. MP3 export and date reading stay on your device; transcription sends audio to Google.

- Common audio inputs: MP3, M4A, AAC, WAV, AIFF, CAF, FLAC, OGG, Opus, WMA, and more.
- Common video inputs: MOV, MP4, WebM, MKV, AVI, MPEG, WMV, FLV, and more. Export uses the first audio track and excludes video, subtitles, and data tracks.
- New uploads are automatically sorted by embedded recording date and time, oldest first, across both audio and video. If recording time is absent, the file modification time is used and labeled **File time**. Undated files stay in upload order at the end; equal times keep their upload order. Use the arrows after uploading for manual adjustments.
- Corrupt files, unsupported codecs, and videos without audio produce an error; the queue stays available to edit and retry.
- Preview playback depends on browser support; a file that cannot preview can still convert.

## How it works

Serve `index.html` on any static HTTPS host, including GitHub Pages. No build step or backend is required.

Browser-supported audio uses Web Audio directly. Recording-date extraction, video, and other audio formats use the single-thread [FFmpeg.wasm core 0.12.10](https://www.npmjs.com/package/@ffmpeg/core/v/0.12.10), downloaded on demand from jsDelivr (about 31 MB before compression). An internet connection is needed for this download if it is not already cached. The single-thread core does not require SharedArrayBuffer or cross-origin isolation headers. If dates cannot be read, sorting falls back to labeled file times. Embedded dates can also reflect an edit or export rather than the original recording.

The decoder reads each source file through WORKERFS and produces stereo 44.1 kHz PCM. The embedded [lamejs](https://github.com/zhuker/lamejs) encoder combines clips into a single MP3. Cancel stops decoder downloads and both workers; temporary decoder URLs and files are released. Large clips still require device memory for decoded audio. DRM-protected media and some codecs are unsupported.

FFmpeg.wasm core is an upstream binary loaded at runtime; its [source and license information](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10) are maintained upstream. The existing lamejs source and license notice remain embedded in the page.

## Transcription

Enter your own Gemini API key in the app and select **Transcribe all**. The key stays in this tab's memory and is cleared when leaving the page. It is never saved to browser storage or included in the repository. Do not embed a shared key in this public HTML. A shared service would need a protected backend and authentication.

The app uses Google's [Interactions API for Gemini 3.5 Transcribe](https://ai.google.dev/gemini-api/docs/transcribe) with verbatim mode and without timestamp or diarization options. It sends only audio, extracts text from the response, and combines clips in the displayed order without speaker labels, timestamps, summaries, or clip headings. It requests `store: false` and does not create persistent Files API uploads; Google's normal API data-use terms still apply.

Audio is converted to 16 kHz mono WAV and sent sequentially in sections of up to five minutes, under the 20 MB inline request limit. Splits prefer a quiet point near the limit. Every source sample is included once, although chunk boundaries can affect word recognition. Cancel stops further uploads; requests already received by Google may still count toward usage. Text received before a failure or cancellation remains available.

**Copy text** copies the entire transcript. **Share / Messages** opens the device share sheet with the full text, where iPhone users can choose Messages. The browser decides which destinations are available; the app does not send a message automatically. **Download TXT** saves a plain-text file and remains available when sharing is unsupported.

Google currently lists a [free tier for this model](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-transcribe), with usage limits. The API project's billing tier determines whether calls are free; the app cannot switch a billed project to the free tier. Free-tier content may be used to improve Google's products. Quota errors stop processing; the app does not retry automatically or switch models.

## Verification

Run `node tests/media-formats.cjs` with Node 18+, `curl`, `ffmpeg`, and `ffprobe` installed. The test downloads the pinned decoder into a temporary cache, generates audio/video fixtures, and runs the actual embedded decoder and encoder. It checks common formats, embedded MOV/M4A timestamps, MP3 stream type and duration, clip order, missing audio, corrupt files, file selection, native/fallback routing, download errors, and cancellation. Set `FFMPEG_CORE_DIR` to use an existing directory containing `ffmpeg-core.js` and `ffmpeg-core.wasm`.

Run `node tests/transcription.cjs` for mocked Google API and application checks, including plain-text configuration, WAV encoding, size-limited chunks, copy/share, partial recovery, cancellation, and sorting across batches/time zones/fallbacks. This does not call Google or verify access for a real API key.

These checks run without a browser. Device-specific preview, file-picker, and sharing behavior require testing on the target device.
