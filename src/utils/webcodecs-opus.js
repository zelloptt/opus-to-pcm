import Event from './event.js';

// Native Opus decoder backed by the browser's WebCodecs `AudioDecoder`.
//
// This is an opt-in alternative to the `OpusWorker` path (which spins up a
// full Emscripten-compiled libopus bundle inside a dedicated Web Worker).
// `AudioDecoder` runs in the user agent's media pipeline, typically off the
// main thread and often backed by a platform codec, so it avoids:
//
//   - the ~918 KB inlined worker bundle and its V8 isolate,
//   - the dynamic `eval`/`new Function` code paths Emscripten emits for
//     `cwrap`-generated C shims, and
//   - the per-decoder PartitionAlloc pages that don't reliably return to
//     the OS after `worker.terminate()`.
//
// It is enabled via `new OpusToPCM({ useNative: true })` and only when
// `typeof AudioDecoder !== 'undefined'`. Opus is a required codec in the
// WebCodecs spec, so in any Chromium-based environment (notably Electron,
// which is where Dispatch Hub lives) `AudioDecoder` + `codec: 'opus'` is
// guaranteed to be supported. For non-Chromium environments where
// `AudioDecoder` is missing, `OpusToPCM` falls back to `OpusWorker` when
// `fallback: true`.
//
// ## Sample-rate handling
//
// WebCodecs' Opus decoder in Chromium only accepts `sampleRate: 48000`
// in `AudioDecoderConfig` and always emits 48 kHz `AudioData`, even
// though libopus itself supports returning decoded audio at 8, 12, 16,
// 24 or 48 kHz via `opus_decoder_create(Fs, ...)`. The Zello Channels
// SDK, however, derives the downstream player's sample rate from the
// codec header attached to each stream and passes it in as
// `options.sampleRate` (24 kHz for narrow-/mediumband streams, 48 kHz
// for wideband). If we just forwarded the raw 48 kHz samples the
// `OpusWorker` replacement would play back at half speed / an octave
// low whenever the session picked 24 kHz.
//
// To preserve drop-in behavior, we resample the WebCodecs output down
// to `options.sampleRate` before emitting it and report that same rate
// from `getSampleRate()`. For the 48 kHz case the resample is a no-op;
// for 24 kHz (the common case) it's an exact 2:1 decimation. For any
// other requested rate we fall back to linear interpolation, which is
// more than adequate for 16-bit-equivalent voice content that has
// already been band-limited by the encoder.
//
// Interface contract (matches `OpusWorker`/`Ogg`):
//   - emits 'data'              with an interleaved Float32Array of PCM
//   - emits 'corrupted_stream'  when a decode error is surfaced (only when
//                               `config.handleCorruptedStream` is set)
//   - `getSampleRate()`         returns the output sample rate
//   - `decode(packet)`          accepts a Uint8Array/ArrayBuffer of one
//                               Opus packet
//   - `destroy()`               tears down the decoder

const WEBCODECS_OPUS_RATE = 48000;

export default class WebCodecsOpus extends Event {
    constructor(channels, config) {
        super('webcodecs-opus');
        this.channels = channels || 1;
        this.config = config || {};
        // Target output rate. Matches the rate the Zello Channels SDK's
        // player was configured with for this stream.
        this.outputSampleRate = this.config.sampleRate || WEBCODECS_OPUS_RATE;
        // Monotonically-increasing timestamp in microseconds. WebCodecs
        // only requires input timestamps to be strictly increasing for
        // ordering; the value is not inspected by us on the output side.
        // A per-packet 60ms step is the upper bound on an Opus frame.
        this.nextTimestamp = 0;
        this.closed = false;

        this.decoder = new AudioDecoder({
            output: this._onAudioData.bind(this),
            error: this._onError.bind(this)
        });

        try {
            this.decoder.configure({
                codec: 'opus',
                sampleRate: WEBCODECS_OPUS_RATE,
                numberOfChannels: this.channels
            });
        } catch (err) {
            this._onError(err);
        }
    }

    getSampleRate() {
        return this.outputSampleRate;
    }

    decode(packet) {
        if (this.closed || !this.decoder || this.decoder.state === 'closed') {
            return;
        }
        const bytes = toUint8Array(packet);
        if (!bytes || bytes.byteLength === 0) {
            return;
        }

        let chunk;
        try {
            chunk = new EncodedAudioChunk({
                type: 'key',
                timestamp: this.nextTimestamp,
                data: bytes
            });
        } catch (err) {
            this._onError(err);
            return;
        }
        this.nextTimestamp += 60000; // 60ms in us, upper bound on an Opus frame

        try {
            this.decoder.decode(chunk);
        } catch (err) {
            this._onError(err);
        }
    }

    _onAudioData(audioData) {
        try {
            const numFrames = audioData.numberOfFrames;
            const numChannels = audioData.numberOfChannels;
            if (!numFrames || !numChannels) {
                return;
            }

            // Always pull planar f32 from WebCodecs: it's the one format
            // the spec requires implementations to support, and it makes
            // the subsequent resample step channel-agnostic.
            const planes = new Array(numChannels);
            for (let ch = 0; ch < numChannels; ch++) {
                planes[ch] = new Float32Array(numFrames);
                audioData.copyTo(planes[ch], {planeIndex: ch, format: 'f32-planar'});
            }

            const srcRate = audioData.sampleRate || WEBCODECS_OPUS_RATE;
            const dstRate = this.outputSampleRate;

            let interleaved;
            if (srcRate === dstRate) {
                interleaved = interleave(planes, numFrames, numChannels);
            } else if (srcRate % dstRate === 0) {
                const decim = srcRate / dstRate;
                interleaved = decimateInterleave(planes, numFrames, numChannels, decim);
            } else {
                interleaved = linearResampleInterleave(planes, numFrames, numChannels, srcRate, dstRate);
            }

            this.dispatch('data', interleaved);
        } catch (err) {
            this._onError(err);
        } finally {
            audioData.close();
        }
    }

    _onError(err) {
        if (this.config.handleCorruptedStream) {
            this.dispatch('corrupted_stream', err);
        }
    }

    destroy() {
        this.closed = true;
        try {
            if (this.decoder && this.decoder.state !== 'closed') {
                this.decoder.close();
            }
        } catch (_) {
            // Best-effort cleanup; ignore teardown errors.
        }
        this.decoder = null;
        this.offAll();
    }
}

function toUint8Array(packet) {
    if (!packet) {
        return null;
    }
    if (packet instanceof Uint8Array) {
        return packet;
    }
    if (packet instanceof ArrayBuffer) {
        return new Uint8Array(packet);
    }
    if (ArrayBuffer.isView(packet)) {
        return new Uint8Array(packet.buffer, packet.byteOffset, packet.byteLength);
    }
    return null;
}

function interleave(planes, numFrames, numChannels) {
    if (numChannels === 1) {
        return planes[0];
    }
    const out = new Float32Array(numFrames * numChannels);
    for (let i = 0; i < numFrames; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            out[i * numChannels + ch] = planes[ch][i];
        }
    }
    return out;
}

// Integer-factor decimation. Opus output for voice is already effectively
// band-limited by the encoder to well under the target Nyquist (e.g.
// narrowband voice at 4 kHz into a 24 kHz stream has ~20 kHz of headroom),
// so plain decimation is adequate without an additional anti-alias filter.
function decimateInterleave(planes, numFrames, numChannels, decim) {
    const outFrames = Math.floor(numFrames / decim);
    const out = new Float32Array(outFrames * numChannels);
    for (let i = 0; i < outFrames; i++) {
        const srcIdx = i * decim;
        for (let ch = 0; ch < numChannels; ch++) {
            out[i * numChannels + ch] = planes[ch][srcIdx];
        }
    }
    return out;
}

// Fallback resampler for non-integer ratios. Linear interpolation is fine
// for speech bandwidths; anyone shipping music through this path should
// bring their own resampler.
function linearResampleInterleave(planes, numFrames, numChannels, srcRate, dstRate) {
    const outFrames = Math.floor(numFrames * dstRate / srcRate);
    const out = new Float32Array(outFrames * numChannels);
    const ratio = srcRate / dstRate;
    for (let i = 0; i < outFrames; i++) {
        const srcPos = i * ratio;
        const i0 = Math.floor(srcPos);
        const i1 = Math.min(i0 + 1, numFrames - 1);
        const frac = srcPos - i0;
        for (let ch = 0; ch < numChannels; ch++) {
            const a = planes[ch][i0];
            const b = planes[ch][i1];
            out[i * numChannels + ch] = a + (b - a) * frac;
        }
    }
    return out;
}
