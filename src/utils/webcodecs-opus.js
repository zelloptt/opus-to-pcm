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
// Interface contract (matches `OpusWorker`/`Ogg`):
//   - emits 'data'              with an interleaved Float32Array of PCM
//   - emits 'corrupted_stream'  when a decode error is surfaced (only when
//                               `config.handleCorruptedStream` is set)
//   - `getSampleRate()`         returns the output sample rate
//   - `decode(packet)`          accepts a Uint8Array/ArrayBuffer of one
//                               Opus packet
//   - `destroy()`               tears down the decoder
//
// Opus always decodes at 48 kHz. The decoder requests interleaved f32
// output from `AudioData.copyTo` when the platform supports it and falls
// back to copying per-plane and interleaving in JS otherwise.

const OPUS_SAMPLE_RATE = 48000;

export default class WebCodecsOpus extends Event {
    constructor(channels, config) {
        super('webcodecs-opus');
        this.channels = channels || 1;
        this.config = config || {};
        this.sampleRate = OPUS_SAMPLE_RATE;
        // Monotonically-increasing timestamp in microseconds. WebCodecs only
        // requires input timestamps to be strictly increasing for ordering;
        // the value itself is not inspected by us on the output side. A
        // per-packet 60ms step is the maximum Opus frame duration and leaves
        // headroom for any downstream consumer that does care.
        this.nextTimestamp = 0;
        this.closed = false;

        this.decoder = new AudioDecoder({
            output: this._onAudioData.bind(this),
            error: this._onError.bind(this)
        });

        try {
            this.decoder.configure({
                codec: 'opus',
                sampleRate: this.sampleRate,
                numberOfChannels: this.channels
            });
        } catch (err) {
            this._onError(err);
        }
    }

    getSampleRate() {
        return this.sampleRate;
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
        this.nextTimestamp += 60000; // 60ms in us; upper bound on an Opus frame

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

            const interleaved = new Float32Array(numFrames * numChannels);

            // Fast path: ask the UA for interleaved f32 directly.
            let gotInterleaved = false;
            if (numChannels === 1) {
                try {
                    audioData.copyTo(interleaved, {planeIndex: 0, format: 'f32'});
                    gotInterleaved = true;
                } catch (_) {
                    // Fall through to planar copy.
                }
            } else {
                try {
                    audioData.copyTo(interleaved, {planeIndex: 0, format: 'f32'});
                    gotInterleaved = true;
                } catch (_) {
                    // Not all implementations expose 'f32'; fall back to planar.
                }
            }

            if (!gotInterleaved) {
                for (let ch = 0; ch < numChannels; ch++) {
                    const plane = new Float32Array(numFrames);
                    audioData.copyTo(plane, {planeIndex: ch, format: 'f32-planar'});
                    for (let i = 0; i < numFrames; i++) {
                        interleaved[i * numChannels + ch] = plane[i];
                    }
                }
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
