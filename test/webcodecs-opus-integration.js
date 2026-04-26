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
            // know in CI rather than at runtime.
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

// Helpers for the frame-size coverage suite below. Kept module-level
// so individual tests stay readable.

function makeMonoSine(samples, sampleRate, frequency, gain, frameOffset) {
    // Phase-continuous so concatenating clips doesn't introduce
    // discontinuities that leak energy into other bands. Tests don't
    // strictly need that but it's nicer for energy assertions.
    const out = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
        const t = (frameOffset + i) / sampleRate;
        out[i] = Math.sin(2 * Math.PI * frequency * t) * gain;
    }
    return out;
}

function rmsFlat(arr) {
    let s = 0;
    for (let i = 0; i < arr.length; i++) {
        s += arr[i] * arr[i];
    }
    return Math.sqrt(s / arr.length);
}

// Encode `numFrames` of a 1 kHz sine at the requested Opus frame
// duration, then call back with the EncodedAudioChunk array. Hides
// the AudioEncoder dance so each test reads as one assertion.
function encodeSineToOpus(opts, cb) {
    const sampleRate = opts.sampleRate;
    const frameDurationUs = opts.frameDurationUs;
    const numFrames = opts.numFrames;
    const frameSamples = (sampleRate * frameDurationUs) / 1000000;
    const chunks = [];
    let encodeError = null;

    const encoder = new AudioEncoder({
        output: function(c) { chunks.push(c); },
        error: function(err) { encodeError = err; }
    });
    try {
        encoder.configure({
            codec: 'opus',
            sampleRate: sampleRate,
            numberOfChannels: 1,
            bitrate: 32000,
            opus: {frameDuration: frameDurationUs}
        });
    } catch (err) {
        return cb(err);
    }

    for (let f = 0; f < numFrames; f++) {
        const tone = makeMonoSine(frameSamples, sampleRate, 1000, 0.5,
            f * frameSamples);
        const ad = new AudioData({
            format: 'f32-planar',
            sampleRate: sampleRate,
            numberOfFrames: frameSamples,
            numberOfChannels: 1,
            timestamp: f * frameDurationUs,
            data: tone
        });
        encoder.encode(ad);
        ad.close();
    }

    encoder.flush().then(function() {
        try { encoder.close(); } catch (_) {}
        if (encodeError) {
            return cb(encodeError);
        }
        cb(null, chunks, frameSamples * numFrames);
    }).catch(cb);
}

// Construct a code-2 (two-frame VBR) Opus packet by splicing two
// existing single-frame packets under a shared TOC. Per RFC 6716
// sec 3.1, all frames in a multi-frame packet must share config,
// which is guaranteed when both inputs came from the same encoder
// configuration. The body bytes after the TOC carry the raw Opus
// frame payload, which can be concatenated under a new TOC.
function packTwoFrameOpus(p1, p2) {
    // p1, p2 are Uint8Arrays representing single-frame packets.
    const toc = (p1[0] & 0xFC) | 0x02; // c=2 (two frames, VBR)
    const body1 = p1.subarray(1);
    const body2 = p2.subarray(1);
    const len1 = body1.length;
    if (len1 >= 252) {
        // Two-byte length encoding exists in the spec but our
        // synthetic test uses small sine clips that always fit in
        // the one-byte form. Bail loudly if that assumption breaks
        // (e.g. someone bumps the bitrate above ~250 kbps in a
        // 60 ms frame and these get bigger).
        throw new Error('packTwoFrameOpus: frame body too large for 1-byte len prefix');
    }
    const out = new Uint8Array(2 + len1 + body2.length);
    out[0] = toc;
    out[1] = len1;
    out.set(body1, 2);
    out.set(body2, 2 + len1);
    return out;
}

// Drain `decoder` until it stops emitting `data` events for `quietMs`
// or until `timeoutMs` elapses, then call cb with the accumulated
// PCM array. Mirrors the settle-window pattern used in the older
// roundtrip tests so multi-test files stay consistent.
function drainDecoder(decoder, quietMs, timeoutMs, cb) {
    const pcmChunks = [];
    decoder.on('data', function(buf) { pcmChunks.push(buf); });
    const start = Date.now();
    let lastSize = -1;
    (function poll() {
        const now = Date.now();
        if (pcmChunks.length === lastSize) {
            // Haven't received anything new since last poll; give it
            // a quiet window before declaring drain complete.
            return cb(null, pcmChunks);
        }
        if (now - start > timeoutMs) {
            return cb(new Error('drain timed out (' + timeoutMs + 'ms); chunks=' + pcmChunks.length));
        }
        lastSize = pcmChunks.length;
        setTimeout(poll, quietMs);
    })();
}

(HAS_DECODER && HAS_ENCODER ? describe : describe.skip)(
    'WebCodecsOpus integration -- frame size coverage', function() {
        // RFC 6716 sec 2.1.4 lets Opus packets carry frames of 2.5,
        // 5, 10, 20, 40, or 60 ms, and sec 3.1 lets a single packet
        // chain 1..48 frames totaling up to 120 ms. Our existing
        // roundtrip tests only exercise the 20 ms single-frame case,
        // which is the most common but not the only valid input.
        // These tests confirm that the decoder pipeline keeps PCM
        // flowing for every spec-legal frame duration and for the
        // multi-frame packing modes -- i.e. nothing in our timestamp
        // accounting or settle logic stalls when the actual packet
        // duration differs from a single 20 ms frame.

        // AudioEncoder doesn't expose 2.5 ms in the OpusEncoderConfig
        // (it's CELT-only and most engines refuse to configure it),
        // so the smallest duration we can roundtrip is 5 ms.
        const FRAME_DURATIONS_US = [5000, 10000, 20000, 40000, 60000];

        FRAME_DURATIONS_US.forEach(function(frameDurationUs) {
            const frameMs = frameDurationUs / 1000;
            it('roundtrips ' + frameMs + 'ms-frame packets without stalling',
                function(done) {
                    this.timeout(5000);
                    const SR = 48000;
                    // Aim for ~240 ms of audio at every duration so
                    // 60 ms gets enough packets to be meaningful and
                    // 5 ms doesn't take forever.
                    const numFrames = Math.max(4, Math.floor(240 / frameMs));
                    encodeSineToOpus({
                        sampleRate: SR,
                        frameDurationUs: frameDurationUs,
                        numFrames: numFrames
                    }, function(err, chunks, expectedSamples) {
                        if (err) return done(err);
                        ok(chunks.length >= numFrames,
                            'encoder produced one chunk per input frame');

                        const dec = new WebCodecsOpus(1, {sampleRate: SR});
                        for (let i = 0; i < chunks.length; i++) {
                            const bytes = new Uint8Array(chunks[i].byteLength);
                            chunks[i].copyTo(bytes);
                            dec.decode(bytes);
                        }

                        drainDecoder(dec, 200, 3000, function(drainErr, pcm) {
                            if (drainErr) {
                                dec.destroy();
                                return done(drainErr);
                            }
                            try {
                                let total = 0;
                                for (let i = 0; i < pcm.length; i++) {
                                    total += pcm[i].length;
                                }
                                // Allow 30% slack: Opus inserts codec
                                // delay/lookahead and the tail flush
                                // pulls a partial frame at the end.
                                ok(total >= expectedSamples * 0.7,
                                    frameMs + 'ms frames produced enough PCM (got '
                                        + total + ', expected ~' + expectedSamples + ')');

                                const all = new Float32Array(total);
                                let off = 0;
                                for (let i = 0; i < pcm.length; i++) {
                                    all.set(pcm[i], off);
                                    off += pcm[i].length;
                                }
                                ok(rmsFlat(all) > 0.05,
                                    frameMs + 'ms frames produced energy');

                                dec.destroy();
                                done();
                            } catch (e) {
                                dec.destroy();
                                done(e);
                            }
                        });
                    });
                });
        });

        it('keeps PCM flowing across mixed frame durations in one stream',
            function(done) {
                // A real sender or repackager may emit a stream whose
                // packets vary in frame duration, e.g. an adaptive
                // encoder that uses 60 ms during low-activity periods
                // and 20 ms during speech. The decoder should never
                // stall regardless of the previous or next packet's
                // duration. We can't easily reconfigure AudioEncoder
                // mid-stream, so we encode each duration into its own
                // clip and concatenate the chunk lists.
                this.timeout(8000);
                const SR = 48000;
                const durationsMs = [10, 60, 20, 40, 5];
                const allChunks = [];
                let expectedTotal = 0;

                (function next(i) {
                    if (i >= durationsMs.length) {
                        return decodeSequence();
                    }
                    encodeSineToOpus({
                        sampleRate: SR,
                        frameDurationUs: durationsMs[i] * 1000,
                        numFrames: 4
                    }, function(err, chunks, expected) {
                        if (err) return done(err);
                        for (let k = 0; k < chunks.length; k++) {
                            allChunks.push(chunks[k]);
                        }
                        expectedTotal += expected;
                        next(i + 1);
                    });
                })(0);

                function decodeSequence() {
                    const dec = new WebCodecsOpus(1, {sampleRate: SR});
                    for (let i = 0; i < allChunks.length; i++) {
                        const bytes = new Uint8Array(allChunks[i].byteLength);
                        allChunks[i].copyTo(bytes);
                        dec.decode(bytes);
                    }
                    drainDecoder(dec, 200, 4000, function(err, pcm) {
                        if (err) {
                            dec.destroy();
                            return done(err);
                        }
                        try {
                            let total = 0;
                            for (let i = 0; i < pcm.length; i++) {
                                total += pcm[i].length;
                            }
                            // Each duration adds its own codec delay, so
                            // mixed-stream slack is wider than the
                            // per-duration test.
                            ok(total >= expectedTotal * 0.6,
                                'mixed-duration stream produced enough PCM (got '
                                    + total + ', expected ~' + expectedTotal + ')');
                            dec.destroy();
                            done();
                        } catch (e) {
                            dec.destroy();
                            done(e);
                        }
                    });
                }
            });

        it('decodes a hand-crafted code-2 (two-frame) Opus packet',
            function(done) {
                // RFC 6716 sec 3.1 lets one packet carry up to 48
                // frames totaling up to 120 ms. AudioEncoder always
                // emits code-0 (one-frame) packets, so to exercise
                // the multi-frame path we splice two single-frame
                // packets into one code-2 packet by hand. If the
                // decoder pipeline silently dropped the second frame
                // (or stalled waiting for a "real" packet boundary),
                // the asserted PCM count would land near a single-
                // frame's worth instead of two.
                this.timeout(5000);
                const SR = 48000;
                const FRAME_MS = 20;
                encodeSineToOpus({
                    sampleRate: SR,
                    frameDurationUs: FRAME_MS * 1000,
                    numFrames: 2
                }, function(err, chunks) {
                    if (err) return done(err);
                    if (chunks.length < 2) {
                        return done(new Error('encoder produced fewer chunks than expected'));
                    }

                    const p1 = new Uint8Array(chunks[0].byteLength);
                    chunks[0].copyTo(p1);
                    const p2 = new Uint8Array(chunks[1].byteLength);
                    chunks[1].copyTo(p2);

                    let packed;
                    try {
                        packed = packTwoFrameOpus(p1, p2);
                    } catch (e) {
                        return done(e);
                    }

                    const dec = new WebCodecsOpus(1, {sampleRate: SR});
                    dec.decode(packed);

                    drainDecoder(dec, 200, 3000, function(drainErr, pcm) {
                        if (drainErr) {
                            dec.destroy();
                            return done(drainErr);
                        }
                        try {
                            let total = 0;
                            for (let i = 0; i < pcm.length; i++) {
                                total += pcm[i].length;
                            }
                            const oneFrameSamples = (SR * FRAME_MS) / 1000;
                            // Two frames packed into one packet ought
                            // to produce ~2x the PCM of a single
                            // frame. Codec delay still applies once
                            // for the packet, so assert >= 1.4x as a
                            // generous floor; a "stuck after first
                            // frame" bug would land near 1.0x.
                            ok(total >= oneFrameSamples * 1.4,
                                'code-2 packet produced ~2 frames worth of PCM (got '
                                    + total + ', expected >= ' + (oneFrameSamples * 1.4) + ')');

                            const all = new Float32Array(total);
                            let off = 0;
                            for (let i = 0; i < pcm.length; i++) {
                                all.set(pcm[i], off);
                                off += pcm[i].length;
                            }
                            ok(rmsFlat(all) > 0.05,
                                'code-2 packet produced energy');

                            dec.destroy();
                            done();
                        } catch (e) {
                            dec.destroy();
                            done(e);
                        }
                    });
                });
            });
    });
