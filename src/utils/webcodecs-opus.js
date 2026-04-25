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

// Maximum number of times we'll rebuild the underlying `AudioDecoder`
// in response to errors before giving up on the stream. `AudioDecoder`
// transitions to 'closed' on any decode error, so to match libopus's
// forgiving behavior we rebuild and keep going. A small upper bound
// prevents a pathological stream from spinning forever.
const MAX_REBUILD_ATTEMPTS = 5;

// Backstop for the `flush()`-then-`close()` dance in `destroy()`. In
// healthy operation `AudioDecoder.flush()` resolves in well under a
// millisecond, so a one-second timeout is purely a safety net for the
// case where the audio process hangs or the promise never settles.
// Without it, a stuck flush would retain this instance (and its event
// listeners) for the lifetime of the page.
//
// Exported so the test suite can assert against the same value rather
// than hardcoding it; not part of the public runtime API.
export const FLUSH_TIMEOUT_MS = 1000;

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
        this.rebuildAttempts = 0;
        this.decoder = this.buildDecoder();
    }

    buildDecoder() {
        let dec;
        try {
            dec = new AudioDecoder({
                output: this.onAudioData.bind(this),
                error: this.onError.bind(this)
            });
            dec.configure({
                codec: 'opus',
                sampleRate: WEBCODECS_OPUS_RATE,
                numberOfChannels: this.channels
            });
        } catch (err) {
            // If `new AudioDecoder()` succeeded and `configure()` threw,
            // we own a partially-constructed decoder whose underlying
            // media-process resource would otherwise leak until GC.
            // Release it explicitly, mirroring `closeDecoder()`.
            if (dec) {
                try {
                    if (dec.state !== 'closed') {
                        dec.close();
                    }
                } catch (_) {
                    // Already in an unrecoverable state; nothing to do.
                }
            }
            if (this.config.handleCorruptedStream) {
                this.safeDispatch('corrupted_stream', err);
            }
            return null;
        }
        return dec;
    }

    // Public-ish flag used by `OpusToPCM` to detect a `WebCodecsOpus`
    // that failed to configure (e.g. an environment that exposes
    // `AudioDecoder` but doesn't actually support `codec: 'opus'`).
    // When false, the caller should treat this instance as unusable
    // and either fall back or surface a hard failure.
    get isSupported() {
        return this.decoder !== null;
    }

    // Close and null `this.decoder` in a single safe step. Used by both
    // the rebuild path and the budget-exhausted path so the underlying
    // `AudioDecoder` is always explicitly released (rather than left
    // for GC, which is unreliable for media-process resources).
    closeDecoder() {
        const old = this.decoder;
        this.decoder = null;
        if (!old) {
            return;
        }
        try {
            if (old.state !== 'closed') {
                old.close();
            }
        } catch (_) {
            // Decoder is already in an unrecoverable state; nothing to do.
        }
    }

    getSampleRate() {
        return this.outputSampleRate;
    }

    // Wrapper around `Event.dispatch` that isolates listener exceptions
    // from our internal lifecycle. Without this, a thrown error from a
    // consumer's `'data'` handler (e.g. a bug deep in `player.feed`)
    // would propagate back into `onAudioData`'s catch block, get
    // misclassified as a decoder error, and burn through the rebuild
    // budget. Same hazard for a throwing `'corrupted_stream'`
    // listener, which would skip the rebuild entirely and leave the
    // stream silently dead.
    safeDispatch(event, data) {
        try {
            this.dispatch(event, data);
        } catch (_) {
            // Listener bug; not a decoder problem. Intentionally
            // swallowed so we don't tear down a healthy decoder over
            // a defect downstream.
        }
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
            this.onError(err);
            return;
        }
        this.nextTimestamp += 60000; // 60ms in us, upper bound on an Opus frame

        try {
            this.decoder.decode(chunk);
        } catch (err) {
            this.onError(err);
        }
    }

    onAudioData(audioData) {
        try {
            const numFrames = audioData.numberOfFrames;
            const numChannels = audioData.numberOfChannels;
            if (!numFrames || !numChannels) {
                return;
            }

            // Reset the rebuild counter on any successful output so a
            // rare corrupted frame early in a long stream doesn't burn
            // through the rebuild budget for the rest of the session.
            this.rebuildAttempts = 0;

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

            if (interleaved.length > 0) {
                this.safeDispatch('data', interleaved);
            }
        } catch (err) {
            this.onError(err);
        } finally {
            audioData.close();
        }
    }

    onError(err) {
        if (this.config.handleCorruptedStream) {
            this.safeDispatch('corrupted_stream', err);
        }
        if (this.closed) {
            return;
        }
        // Per WebCodecs, `AudioDecoder` transitions to 'closed' on any
        // error, which would silently drop every subsequent packet of
        // this stream. libopus by contrast tolerates bad frames and
        // keeps decoding the rest. Rebuild the underlying decoder so
        // the next `decode()` call can succeed. `nextTimestamp` stays
        // monotonic across the rebuild, which is all WebCodecs requires.
        if (this.rebuildAttempts >= MAX_REBUILD_ATTEMPTS) {
            // Close the most recently-built decoder before giving up;
            // otherwise its underlying media-process resource is left
            // for GC, which is unreliable. Subsequent `decode()` calls
            // become silent no-ops because `this.decoder` is null.
            this.closeDecoder();
            // Surface a final terminal error so consumers aren't left
            // wondering why the stream went silent.
            if (this.config.handleCorruptedStream) {
                this.safeDispatch('corrupted_stream',
                    new Error('WebCodecs decoder rebuild budget exhausted'));
            }
            return;
        }
        this.rebuildAttempts++;
        this.closeDecoder();
        this.decoder = this.buildDecoder();
    }

    destroy() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        const dec = this.decoder;
        this.decoder = null;
        if (!dec) {
            this.offAll();
            return;
        }
        // Drain any in-flight decodes before tearing down. `AudioDecoder.
        // decode()` is pipelined: the output callback for each chunk fires
        // some microtasks after the decode was issued. Calling `close()`
        // synchronously (as the initial implementation did) aborts the
        // pipeline and silently drops whatever `AudioData` callbacks
        // haven't fired yet, which for an end-of-message destroy meant
        // losing the tail of the audio. Since `stopPlayback` in the SDK
        // computes playback duration from packet count, the player would
        // underrun at the end and sit "stuck" waiting for PCM that never
        // arrived.
        //
        // `flush()` resolves once every queued decode has produced its
        // output (or thrown). We keep the listener list live until then
        // so the last few `dispatch('data', ...)` calls make it through
        // to `IncomingMessage.ondata` and into the player. After flush
        // resolves we actually close the decoder and tear down listeners.
        //
        // The flush is also bounded by `FLUSH_TIMEOUT_MS` so a stuck or
        // never-settling flush promise (e.g. an audio process hang)
        // can't retain this instance and its event listeners forever.
        // Whichever of {flush settled, timeout fired} happens first
        // wins; the other becomes a no-op via the `finalized` guard.
        let finalized = false;
        let timeoutHandle = null;
        const finalize = () => {
            if (finalized) {
                return;
            }
            finalized = true;
            if (timeoutHandle !== null) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            try {
                if (dec.state !== 'closed') {
                    dec.close();
                }
            } catch (_) {
                // Decoder is already in an unrecoverable state; nothing to do.
            }
            this.offAll();
        };
        let flushed;
        try {
            flushed = dec.flush();
        } catch (_) {
            // flush() rejects/throws if the decoder is already errored;
            // skip straight to teardown.
            finalize();
            return;
        }
        if (flushed && typeof flushed.then === 'function') {
            timeoutHandle = setTimeout(finalize, FLUSH_TIMEOUT_MS);
            flushed.then(finalize, finalize);
        } else {
            finalize();
        }
    }
}

// The helpers below are module-private in the runtime path but exported
// (named) so the unit tests can exercise them directly. They are pure
// functions over plain typed-arrays, with no dependency on WebCodecs,
// the `Event` class, or browser globals.

export function toUint8Array(packet) {
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

export function interleave(planes, numFrames, numChannels) {
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

// Integer-factor downsample via an N-sample block average (boxcar FIR
// followed by decimation). This is the cheapest anti-alias filter that
// still meaningfully outperforms plain "pick every Nth sample"
// decimation, and requires no state across calls. For N=2 the boxcar
// has its first null at the source Nyquist; for larger N the first null
// is at srcRate/N which is exactly the target Nyquist. That's not a
// brickwall, but it's adequate for voice at any of the Opus-supported
// output rates (48k, 24k, 16k, 12k, 8k) and much better than naive
// subsampling for wideband content squeezed into narrowband targets.
export function decimateInterleave(planes, numFrames, numChannels, decim) {
    if (decim === 1) {
        return interleave(planes, numFrames, numChannels);
    }
    const outFrames = Math.floor(numFrames / decim);
    const out = new Float32Array(outFrames * numChannels);
    const inv = 1 / decim;
    for (let i = 0; i < outFrames; i++) {
        const base = i * decim;
        for (let ch = 0; ch < numChannels; ch++) {
            const plane = planes[ch];
            let sum = 0;
            for (let k = 0; k < decim; k++) {
                sum += plane[base + k];
            }
            out[i * numChannels + ch] = sum * inv;
        }
    }
    return out;
}

// Fallback resampler for non-integer ratios. Linear interpolation is fine
// for speech bandwidths; anyone shipping music through this path should
// bring their own resampler.
export function linearResampleInterleave(planes, numFrames, numChannels, srcRate, dstRate) {
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
