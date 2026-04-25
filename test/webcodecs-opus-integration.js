import {equal, ok} from 'assert';
import WebCodecsOpus from '../src/utils/webcodecs-opus.js';

// End-to-end integration tests against the real WebCodecs API.
//
// These verify that the assumptions baked into WebCodecsOpus actually
// hold against a real `AudioDecoder` (not just a fake): the codec
// string we ship, the channel count, the timestamp scheme, the
// flush-then-close lifecycle, and the bit format we ask for in copyTo.
// Most lifecycle/state-machine concerns are covered by the unit suite
// using fakes, so this file stays small and deliberately doesn't try
// to re-test things that don't depend on the real implementation.
//
// Suites are skipped (rather than failing) on browsers that don't
// expose AudioDecoder/AudioEncoder. Karma is currently configured for
// Chrome which ships both, but if anyone points karma at Firefox the
// suite shouldn't break; it should just no-op.

const HAS_DECODER = typeof window.AudioDecoder !== 'undefined';
const HAS_ENCODER = typeof window.AudioEncoder !== 'undefined' &&
                    typeof window.AudioData !== 'undefined';

(HAS_DECODER ? describe : describe.skip)(
    'WebCodecsOpus integration -- real AudioDecoder', function() {
        it('configures successfully with codec=opus, sr=48000, channels=1', function() {
            // The whole point of the native path: this combo is
            // mandatory by spec on every WebCodecs implementation.
            // If a future Chromium build changes that, we want to
            // know in CI rather than at runtime in Dispatch Hub.
            const dec = new WebCodecsOpus(1, {sampleRate: 48000});
            ok(dec.decoder, 'decoder constructed');
            equal(dec.decoder.state, 'configured');
            dec.destroy();
        });

        it('supports stereo configuration', function() {
            const dec = new WebCodecsOpus(2, {sampleRate: 48000});
            equal(dec.decoder.state, 'configured');
            dec.destroy();
        });

        it('reports the requested output sample rate even when WebCodecs always emits 48k', function() {
            const dec = new WebCodecsOpus(1, {sampleRate: 24000});
            equal(dec.getSampleRate(), 24000);
            dec.destroy();
        });

        it('destroy() completes (flush settles) on an empty decoder', function(done) {
            this.timeout(2000);
            const dec = new WebCodecsOpus(1, {sampleRate: 48000});
            const fakeDecoder = dec.decoder;
            dec.destroy();
            // Poll until the real decoder is closed. Should be ~ms.
            const start = Date.now();
            (function check() {
                if (fakeDecoder.state === 'closed') {
                    done();
                    return;
                }
                if (Date.now() - start > 1500) {
                    done(new Error('decoder did not close within 1500ms; state=' + fakeDecoder.state));
                    return;
                }
                setTimeout(check, 10);
            })();
        });

        // Note: we deliberately don't have an integration test that
        // hands "garbage" bytes to the real decoder and asserts a
        // corrupted_stream event. Opus is designed to be extremely
        // tolerant of bad input (it's part of the spec), so what
        // counts as "garbage enough to error" is fragile and
        // implementation-specific. The error/rebuild/budget pathway
        // is exercised deterministically by the lifecycle suite
        // against the fake decoder, which is the right place for
        // those assertions.
    });

(HAS_DECODER && HAS_ENCODER ? describe : describe.skip)(
    'WebCodecsOpus integration -- end-to-end encode/decode roundtrip', function() {

        function makeAudioData(samples, sampleRate, timestamp) {
            // Build a single-channel f32-planar AudioData from a
            // Float32Array. WebCodecs requires a full copy of `data`
            // here, so the typed-array can be reused.
            return new AudioData({
                format: 'f32-planar',
                sampleRate: sampleRate,
                numberOfFrames: samples.length,
                numberOfChannels: 1,
                timestamp: timestamp,
                data: samples
            });
        }

        function rms(arr) {
            let s = 0;
            for (let i = 0; i < arr.length; i++) {
                s += arr[i] * arr[i];
            }
            return Math.sqrt(s / arr.length);
        }

        it('decodes Opus packets produced by the same browser\'s AudioEncoder', function(done) {
            // Ground-truth integration. We encode a 1 kHz sine via
            // AudioEncoder, hand the encoded packets to WebCodecsOpus,
            // and verify we get out PCM with non-trivial energy at
            // roughly the right total length. We don't compare
            // sample-by-sample because Opus is lossy and inserts
            // codec lookahead; we'd just be testing libopus.
            this.timeout(5000);

            const SR = 48000;
            const FRAME_MS = 20; // 20ms frame, 960 samples at 48k
            const FRAME_SAMPLES = (SR / 1000) * FRAME_MS;
            const NUM_FRAMES = 10; // 200 ms of audio

            const encodedChunks = [];
            let encodeError = null;

            const encoder = new AudioEncoder({
                output: function(chunk) {
                    encodedChunks.push(chunk);
                },
                error: function(err) { encodeError = err; }
            });
            encoder.configure({
                codec: 'opus',
                sampleRate: SR,
                numberOfChannels: 1,
                bitrate: 32000
            });

            // Synthesize and encode NUM_FRAMES of 1kHz sine.
            const tone = new Float32Array(FRAME_SAMPLES);
            const frequency = 1000;
            for (let f = 0; f < NUM_FRAMES; f++) {
                for (let i = 0; i < FRAME_SAMPLES; i++) {
                    const t = (f * FRAME_SAMPLES + i) / SR;
                    tone[i] = Math.sin(2 * Math.PI * frequency * t) * 0.5;
                }
                const data = makeAudioData(tone.slice(), SR, (f * FRAME_MS * 1000));
                encoder.encode(data);
                data.close();
            }

            encoder.flush().then(function() {
                // Release the encoder's native resource as soon as we
                // have all the chunks. WebCodecs encoders are not
                // garbage-collected aggressively across Karma runs, so
                // leaving them open across tests can exhaust the
                // browser's media-process slots.
                try { encoder.close(); } catch (_) {}
                if (encodeError) {
                    return done(encodeError);
                }
                ok(encodedChunks.length >= NUM_FRAMES,
                    'encoder produced at least one chunk per input frame (got '
                        + encodedChunks.length + ')');

                // Now decode through WebCodecsOpus.
                const dec = new WebCodecsOpus(1, {sampleRate: SR});
                const pcmChunks = [];
                dec.on('data', function(buf) { pcmChunks.push(buf); });

                for (let i = 0; i < encodedChunks.length; i++) {
                    const chunk = encodedChunks[i];
                    const bytes = new Uint8Array(chunk.byteLength);
                    chunk.copyTo(bytes);
                    dec.decode(bytes);
                }

                // The real AudioDecoder pipelines its work; destroy()
                // flushes and waits for tail PCM, so we await it.
                // destroy() doesn't return a promise so we poll via
                // a 'data' settle window.
                const settleStart = Date.now();
                (function awaitTail() {
                    const before = pcmChunks.length;
                    setTimeout(function() {
                        if (pcmChunks.length === before || Date.now() - settleStart > 2000) {
                            try {
                                let totalSamples = 0;
                                for (let i = 0; i < pcmChunks.length; i++) {
                                    totalSamples += pcmChunks[i].length;
                                }
                                ok(totalSamples > 0, 'got PCM out (samples=' + totalSamples + ')');
                                ok(totalSamples >= FRAME_SAMPLES * NUM_FRAMES * 0.8,
                                    'PCM count is roughly the expected length (got '
                                        + totalSamples + ', expected ~'
                                        + FRAME_SAMPLES * NUM_FRAMES + ')');

                                // Verify the decoded audio actually
                                // carries energy. A silent decoder bug
                                // would drop this to ~0.
                                const all = new Float32Array(totalSamples);
                                let off = 0;
                                for (let i = 0; i < pcmChunks.length; i++) {
                                    all.set(pcmChunks[i], off);
                                    off += pcmChunks[i].length;
                                }
                                const energy = rms(all);
                                ok(energy > 0.05,
                                    'decoded RMS resembles a sine (got ' + energy + ')');

                                dec.destroy();
                                done();
                            } catch (e) {
                                done(e);
                            }
                        } else {
                            awaitTail();
                        }
                    }, 50);
                })();
            }).catch(done);
        });

        it('roundtrips with downsampled output (24 kHz target)', function(done) {
            // Regression test for the original "low pitched and slow"
            // bug: encoder produces 48 kHz data, decoder is asked to
            // emit at 24 kHz, and the resample step has to halve the
            // sample count and keep RMS energy intact.
            this.timeout(5000);

            const SR_IN = 48000;
            const SR_OUT = 24000;
            const FRAME_SAMPLES = 960; // 20ms at 48k
            const NUM_FRAMES = 10;

            const encodedChunks = [];
            const encoder = new AudioEncoder({
                output: function(c) { encodedChunks.push(c); },
                error: function(err) {
                    try { encoder.close(); } catch (_) {}
                    done(err);
                }
            });
            encoder.configure({
                codec: 'opus',
                sampleRate: SR_IN,
                numberOfChannels: 1,
                bitrate: 32000
            });

            const tone = new Float32Array(FRAME_SAMPLES);
            for (let f = 0; f < NUM_FRAMES; f++) {
                for (let i = 0; i < FRAME_SAMPLES; i++) {
                    const t = (f * FRAME_SAMPLES + i) / SR_IN;
                    tone[i] = Math.sin(2 * Math.PI * 1000 * t) * 0.5;
                }
                const data = makeAudioData(tone.slice(), SR_IN, f * 20000);
                encoder.encode(data);
                data.close();
            }

            encoder.flush().then(function() {
                try { encoder.close(); } catch (_) {}
                const dec = new WebCodecsOpus(1, {sampleRate: SR_OUT});
                const pcmChunks = [];
                dec.on('data', function(buf) { pcmChunks.push(buf); });

                for (let i = 0; i < encodedChunks.length; i++) {
                    const c = encodedChunks[i];
                    const bytes = new Uint8Array(c.byteLength);
                    c.copyTo(bytes);
                    dec.decode(bytes);
                }

                setTimeout(function() {
                    try {
                        let total = 0;
                        for (let i = 0; i < pcmChunks.length; i++) {
                            total += pcmChunks[i].length;
                        }
                        // Output should be roughly half the 48k frame
                        // count -- not exactly, because Opus lookahead
                        // and any tail PCM also passes through the
                        // resampler.
                        const expected48k = FRAME_SAMPLES * NUM_FRAMES;
                        ok(total > expected48k * 0.4 && total < expected48k * 0.7,
                            'output is roughly half the source samples ('
                                + total + ' vs expected ~' + expected48k / 2 + ')');

                        // Must still carry energy: the decimation
                        // would zero this out only if the boxcar
                        // lost its 1/N normalization or we dropped
                        // every sample.
                        const all = new Float32Array(total);
                        let off = 0;
                        for (let i = 0; i < pcmChunks.length; i++) {
                            all.set(pcmChunks[i], off);
                            off += pcmChunks[i].length;
                        }
                        ok(rms(all) > 0.05, 'decimated output still has energy');

                        dec.destroy();
                        done();
                    } catch (e) {
                        done(e);
                    }
                }, 500);
            }).catch(done);
        });
    });
