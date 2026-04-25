import {equal, ok, strictEqual, deepEqual} from 'assert';
import WebCodecsOpus, {FLUSH_TIMEOUT_MS} from '../src/utils/webcodecs-opus.js';

// Lifecycle tests for WebCodecsOpus. Real `AudioDecoder` is replaced
// with a controllable fake so we can:
//
//   - drive `output` and `error` callbacks deterministically,
//   - decide when (and whether) `flush()` resolves,
//   - assert close()/state behavior without depending on a real
//     media-process backend.
//
// The fakes are installed in `beforeEach` and torn down in
// `afterEach`. The integration suite uses the real WebCodecs API.

let originalAudioDecoder;
let originalEncodedAudioChunk;

class FakeAudioData {
    // Minimal stand-in for the parts of WebCodecs.AudioData we touch.
    // `fillPlanes(planeIndex, dst)` lets each test inject whatever
    // sample values it wants into the typed-array dst.
    constructor({frames, channels, rate, fillPlanes}) {
        this.numberOfFrames = frames;
        this.numberOfChannels = channels;
        this.sampleRate = rate;
        this.format = 'f32-planar';
        this._fillPlanes = fillPlanes || function() {};
        this.closeCount = 0;
    }
    copyTo(dst, opts) {
        this._fillPlanes(opts.planeIndex, dst);
    }
    close() {
        this.closeCount++;
    }
}

class FakeEncodedAudioChunk {
    constructor(opts) {
        this.type = opts.type;
        this.timestamp = opts.timestamp;
        this.data = opts.data;
    }
}

// Per-test set of created fakes; lets a test inspect every instance,
// not just the most recent.
let fakes;

class FakeAudioDecoder {
    constructor({output, error}) {
        this._output = output;
        this._error = error;
        this.state = 'unconfigured';
        this.configureCount = 0;
        this.decodeCount = 0;
        this.closeCount = 0;
        this.flushCount = 0;
        // Pending flush deferred. Tests reach in to resolve/reject.
        this._pendingFlush = null;
        // Knobs the test can set before triggering behavior.
        this.configureThrows = null;
        this.decodeThrows = null;
        this.flushThrowsSync = null;
        // If true, fireError() leaves state untouched -- simulates a
        // hypothetically non-spec-compliant implementation. Lets us
        // verify that closeDecoder() actually closes such a decoder
        // rather than relying on the spec to have transitioned for us.
        this.errorLeavesStateOpen = false;
        fakes.push(this);
    }
    configure() {
        this.configureCount++;
        if (this.configureThrows) {
            throw this.configureThrows;
        }
        this.state = 'configured';
    }
    decode() {
        this.decodeCount++;
        if (this.decodeThrows) {
            throw this.decodeThrows;
        }
    }
    close() {
        this.closeCount++;
        this.state = 'closed';
    }
    flush() {
        this.flushCount++;
        if (this.flushThrowsSync) {
            throw this.flushThrowsSync;
        }
        const d = {};
        d.promise = new Promise(function(resolve, reject) {
            d.resolve = resolve;
            d.reject = reject;
        });
        this._pendingFlush = d;
        return d.promise;
    }

    // Helpers the tests call to drive the decoder.
    fireOutput(audioData) {
        this._output(audioData);
    }
    fireError(err) {
        this._error(err);
        if (!this.errorLeavesStateOpen) {
            this.state = 'closed';
        }
    }
}

function installFakes() {
    fakes = [];
    originalAudioDecoder = window.AudioDecoder;
    originalEncodedAudioChunk = window.EncodedAudioChunk;
    window.AudioDecoder = FakeAudioDecoder;
    window.EncodedAudioChunk = FakeEncodedAudioChunk;
}

function restoreFakes() {
    window.AudioDecoder = originalAudioDecoder;
    window.EncodedAudioChunk = originalEncodedAudioChunk;
}

// Build a FakeAudioData prefilled with the values of `samples` on
// every plane. Convenience for the simple "1 channel, ramp" tests.
function makeFakeAudioData(samples, opts) {
    opts = opts || {};
    const channels = opts.channels || 1;
    const rate = opts.rate || 48000;
    return new FakeAudioData({
        frames: samples.length,
        channels: channels,
        rate: rate,
        fillPlanes: function(planeIndex, dst) {
            for (let i = 0; i < samples.length; i++) {
                dst[i] = samples[i];
            }
        }
    });
}

describe('WebCodecsOpus lifecycle --', function() {
    beforeEach(installFakes);
    afterEach(restoreFakes);

    describe('construction', function() {
        it('creates and configures an AudioDecoder', function() {
            const dec = new WebCodecsOpus(1, {sampleRate: 48000});
            equal(fakes.length, 1, 'one decoder instance was constructed');
            equal(fakes[0].configureCount, 1);
            equal(fakes[0].state, 'configured');
            ok(dec.decoder === fakes[0]);
        });

        it('reports the requested output sample rate', function() {
            const dec = new WebCodecsOpus(1, {sampleRate: 24000});
            equal(dec.getSampleRate(), 24000);
        });

        it('defaults to 48000 when no sampleRate is provided', function() {
            const dec = new WebCodecsOpus(1, {});
            equal(dec.getSampleRate(), 48000);
        });

        it('survives a configure() that throws synchronously', function() {
            // Simulates "browser refuses our config" (e.g. a future
            // Chrome that drops Opus support, or a misconfigured
            // numberOfChannels). The constructor must not propagate;
            // it should null the decoder and leave the instance in a
            // safe no-op state.
            const realConfigure = FakeAudioDecoder.prototype.configure;
            FakeAudioDecoder.prototype.configure = function() {
                throw new Error('not supported');
            };
            try {
                const dec = new WebCodecsOpus(1, {sampleRate: 48000});
                equal(dec.decoder, null);
                // decode() on a null decoder is a no-op (no throw).
                dec.decode(new Uint8Array([1, 2, 3]));
                dec.destroy();
            } finally {
                FakeAudioDecoder.prototype.configure = realConfigure;
            }
        });
    });

    describe('decode()', function() {
        it('forwards an EncodedAudioChunk into the underlying decoder', function() {
            const dec = new WebCodecsOpus(1, {sampleRate: 48000});
            dec.decode(new Uint8Array([1, 2, 3, 4]));
            equal(fakes[0].decodeCount, 1);
        });

        it('is a no-op once destroyed', function() {
            const dec = new WebCodecsOpus(1, {sampleRate: 48000});
            const fake = fakes[0];
            dec.destroy();
            const before = fake.decodeCount;
            dec.decode(new Uint8Array([1, 2, 3]));
            equal(fake.decodeCount, before, 'no decode after destroy');
        });

        it('is a no-op when the underlying decoder is in closed state', function() {
            const dec = new WebCodecsOpus(1, {sampleRate: 48000});
            fakes[0].state = 'closed';
            dec.decode(new Uint8Array([1, 2, 3]));
            equal(fakes[0].decodeCount, 0);
        });

        it('drops empty packets without calling decode', function() {
            const dec = new WebCodecsOpus(1, {sampleRate: 48000});
            dec.decode(new Uint8Array(0));
            dec.decode(null);
            dec.decode(undefined);
            equal(fakes[0].decodeCount, 0);
        });

        it('treats a synchronous decode() throw as a decoder error and rebuilds', function() {
            const dec = new WebCodecsOpus(1, {sampleRate: 48000, handleCorruptedStream: true});
            const errs = [];
            dec.on('corrupted_stream', function(e) { errs.push(e); });
            const first = fakes[0];
            first.decodeThrows = new Error('synthetic decode failure');
            dec.decode(new Uint8Array([1, 2, 3]));
            equal(errs.length, 1, 'corrupted_stream dispatched');
            equal(fakes.length, 2, 'rebuilt to a fresh decoder');
            ok(dec.decoder === fakes[1]);
        });
    });

    describe('onAudioData()', function() {
        it('dispatches a Float32Array of PCM at the source rate when src==dst', function() {
            const dec = new WebCodecsOpus(1, {sampleRate: 48000});
            const received = [];
            dec.on('data', function(buf) { received.push(buf); });

            fakes[0].fireOutput(makeFakeAudioData([0.1, 0.2, 0.3, 0.4]));

            equal(received.length, 1);
            ok(received[0] instanceof Float32Array);
            deepEqual(Array.from(received[0]), [0.1, 0.2, 0.3, 0.4].map(function(v) {
                // Float32Array round-trip is lossy for these values; accept the
                // round-tripped form rather than the literal.
                return Math.fround(v);
            }));
        });

        it('decimates from 48k to 24k via block average', function() {
            // Verifies the resample path actually wires through to
            // decimateInterleave (the math itself is unit-tested
            // separately).
            const dec = new WebCodecsOpus(1, {sampleRate: 24000});
            const received = [];
            dec.on('data', function(buf) { received.push(buf); });

            fakes[0].fireOutput(makeFakeAudioData([0, 1, 2, 3], {rate: 48000}));

            equal(received.length, 1);
            deepEqual(Array.from(received[0]), [0.5, 2.5]);
        });

        it('closes the AudioData even when listeners throw', function() {
            // Critical for memory: AudioData wraps a native buffer
            // that's only released on close(). Skipping close() on a
            // listener exception would leak one buffer per output
            // callback for the rest of the stream.
            const dec = new WebCodecsOpus(1, {sampleRate: 48000});
            dec.on('data', function() { throw new Error('listener bug'); });
            const data = makeFakeAudioData([0.1, 0.2]);
            fakes[0].fireOutput(data);
            equal(data.closeCount, 1);
        });

        it('listener throw does NOT trigger a decoder rebuild', function() {
            // Without safeDispatch this would burn through the
            // rebuild budget on a downstream consumer bug. With
            // safeDispatch, the throw is swallowed and the decoder
            // stays alive.
            const dec = new WebCodecsOpus(1, {sampleRate: 48000});
            dec.on('data', function() { throw new Error('listener bug'); });
            fakes[0].fireOutput(makeFakeAudioData([0.1, 0.2]));
            equal(fakes.length, 1, 'no rebuild');
        });

        it('skips dispatch when the decoder produced zero frames', function() {
            const dec = new WebCodecsOpus(1, {sampleRate: 48000});
            const received = [];
            dec.on('data', function(buf) { received.push(buf); });

            fakes[0].fireOutput(new FakeAudioData({
                frames: 0, channels: 1, rate: 48000,
                fillPlanes: function() {}
            }));

            equal(received.length, 0);
        });

        it('resets rebuild budget on a successful output', function() {
            // If a stream produces a single bad packet early on, we
            // should burn one rebuild attempt and then NOT keep that
            // attempt counted against later in the stream.
            const dec = new WebCodecsOpus(1, {sampleRate: 48000, handleCorruptedStream: true});
            fakes[0].fireError(new Error('bad packet')); // burns 1
            equal(dec.rebuildAttempts, 1);
            const second = fakes[1];
            second.fireOutput(makeFakeAudioData([0.1])); // good packet
            equal(dec.rebuildAttempts, 0, 'budget reset');
        });
    });

    describe('onError()', function() {
        it('dispatches corrupted_stream when handleCorruptedStream=true', function() {
            const dec = new WebCodecsOpus(1, {sampleRate: 48000, handleCorruptedStream: true});
            const errs = [];
            dec.on('corrupted_stream', function(e) { errs.push(e); });
            fakes[0].fireError(new Error('boom'));
            equal(errs.length, 1);
            equal(errs[0].message, 'boom');
        });

        it('does NOT dispatch corrupted_stream when the option is unset', function() {
            // Default behavior -- consumer didn't opt in to seeing
            // bad-frame events.
            const dec = new WebCodecsOpus(1, {sampleRate: 48000});
            const errs = [];
            dec.on('corrupted_stream', function(e) { errs.push(e); });
            fakes[0].fireError(new Error('boom'));
            equal(errs.length, 0);
        });

        it('rebuilds the underlying AudioDecoder on each error', function() {
            const dec = new WebCodecsOpus(1, {sampleRate: 48000});
            fakes[0].fireError(new Error('first'));
            equal(fakes.length, 2, 'one rebuild');
            ok(dec.decoder === fakes[1]);
            equal(fakes[1].state, 'configured');
        });

        it('keeps timestamps monotonic across rebuilds', function() {
            // WebCodecs requires strictly increasing input timestamps
            // even across decoder.configure() boundaries. Verify our
            // counter doesn't reset on rebuild.
            const dec = new WebCodecsOpus(1, {sampleRate: 48000});
            const before = dec.nextTimestamp;
            dec.decode(new Uint8Array([1])); // bumps to 60000
            fakes[0].fireError(new Error('boom')); // rebuild
            ok(dec.nextTimestamp > before);
        });

        it('continues rebuilding up to MAX_REBUILD_ATTEMPTS, then gives up', function() {
            const dec = new WebCodecsOpus(1, {sampleRate: 48000, handleCorruptedStream: true});
            const errs = [];
            dec.on('corrupted_stream', function(e) { errs.push(e); });

            // Fire 5 errors -> 5 rebuilds. After each, fakes[i+1]
            // is the freshly-built decoder.
            for (let i = 0; i < 5; i++) {
                fakes[fakes.length - 1].fireError(new Error('e' + i));
            }
            equal(fakes.length, 6, '5 rebuilds (6 total decoders)');
            ok(dec.decoder === fakes[5]);

            // 6th error: budget exhausted. No new decoder.
            fakes[5].fireError(new Error('e5'));
            equal(fakes.length, 6, 'no rebuild after budget exhausted');
            equal(dec.decoder, null);
        });

        it('dispatches a terminal corrupted_stream when budget exhausted', function() {
            const dec = new WebCodecsOpus(1, {sampleRate: 48000, handleCorruptedStream: true});
            const errs = [];
            dec.on('corrupted_stream', function(e) { errs.push(e); });

            for (let i = 0; i < 6; i++) {
                fakes[fakes.length - 1].fireError(new Error('e' + i));
            }
            // 6 raw errors + 1 terminal "budget exhausted" = 7
            equal(errs.length, 7);
            equal(errs[6].message, 'WebCodecs decoder rebuild budget exhausted');
        });

        it('explicitly closes the budget-exhausted decoder when the runtime didn\'t auto-close it', function() {
            // The bug-review fix: even if a buggy/non-spec
            // implementation doesn't transition the decoder to
            // 'closed' on error, we must close it ourselves so its
            // native handle isn't leaked to GC. Simulated by setting
            // errorLeavesStateOpen on the fakes.
            const dec = new WebCodecsOpus(1, {sampleRate: 48000, handleCorruptedStream: true});
            // First make all subsequent fakes non-spec.
            const origCtor = window.AudioDecoder;
            window.AudioDecoder = function(opts) {
                const f = new origCtor(opts);
                f.errorLeavesStateOpen = true;
                return f;
            };
            // Mark the already-created first decoder too.
            fakes[0].errorLeavesStateOpen = true;

            try {
                for (let i = 0; i < 6; i++) {
                    fakes[fakes.length - 1].fireError(new Error('e' + i));
                }
                // Last decoder (fakes[5]) is the budget-exhausted one.
                // closeDecoder() must have called close() on it
                // because the fake never auto-transitioned to 'closed'.
                equal(fakes[5].closeCount, 1, 'last decoder explicitly closed');
            } finally {
                window.AudioDecoder = origCtor;
            }
        });

        it('skips the rebuild path when fired during destroy()', function() {
            // The flush window can produce error callbacks for
            // packets that were already in flight. We dispatch the
            // event so the consumer sees it, but must not rebuild
            // (we're tearing down).
            const dec = new WebCodecsOpus(1, {sampleRate: 48000, handleCorruptedStream: true});
            const errs = [];
            dec.on('corrupted_stream', function(e) { errs.push(e); });

            const fakeBeforeDestroy = fakes[0];
            dec.destroy();
            const fakesBefore = fakes.length;
            fakeBeforeDestroy.fireError(new Error('late'));
            equal(fakes.length, fakesBefore, 'no rebuild during destroy');
        });

        it('listener throw on corrupted_stream does NOT skip the rebuild', function() {
            // Without safeDispatch, a throwing listener would unwind
            // out of onError before reaching the rebuild logic,
            // leaving the stream silently dead.
            const dec = new WebCodecsOpus(1, {sampleRate: 48000, handleCorruptedStream: true});
            dec.on('corrupted_stream', function() { throw new Error('listener bug'); });
            fakes[0].fireError(new Error('boom'));
            equal(fakes.length, 2, 'rebuild still happened');
        });
    });

    describe('destroy()', function() {
        it('is idempotent', function() {
            const dec = new WebCodecsOpus(1, {sampleRate: 48000});
            dec.destroy();
            // Second call must not call flush() again.
            const flushBefore = fakes[0].flushCount;
            dec.destroy();
            equal(fakes[0].flushCount, flushBefore);
        });

        it('clears listeners synchronously when there is no decoder to flush', function() {
            // Path: the constructor's buildDecoder() failed and
            // returned null. destroy() should clear listeners
            // immediately without trying to flush.
            const realConfigure = FakeAudioDecoder.prototype.configure;
            FakeAudioDecoder.prototype.configure = function() {
                throw new Error('not supported');
            };
            try {
                const dec = new WebCodecsOpus(1, {sampleRate: 48000});
                let fired = 0;
                dec.on('data', function() { fired++; });
                dec.destroy();
                deepEqual(dec.listener, {}, 'listeners cleared');
            } finally {
                FakeAudioDecoder.prototype.configure = realConfigure;
            }
        });

        it('flushes before close so tail PCM still reaches listeners', function(done) {
            // The whole reason destroy() became async. Tail packets
            // delivered between destroy() and the flush settling must
            // still dispatch to consumers.
            const dec = new WebCodecsOpus(1, {sampleRate: 48000});
            const received = [];
            dec.on('data', function(buf) { received.push(buf); });

            const fake = fakes[0];
            dec.destroy();

            // Decoder isn't closed yet, listeners still alive.
            equal(fake.closeCount, 0);
            fake.fireOutput(makeFakeAudioData([0.1, 0.2]));
            equal(received.length, 1, 'tail PCM dispatched');

            // Now resolve the flush.
            fake._pendingFlush.resolve();
            // Wait a microtask for the .then handler to run.
            Promise.resolve().then(function() {
                equal(fake.closeCount, 1, 'closed after flush');
                deepEqual(dec.listener, {}, 'listeners cleared');
                done();
            }).catch(done);
        });

        it('falls through to close() if flush() throws synchronously', function() {
            const dec = new WebCodecsOpus(1, {sampleRate: 48000});
            const fake = fakes[0];
            fake.flushThrowsSync = new Error('flush sync throw');
            dec.destroy();
            equal(fake.closeCount, 1);
            deepEqual(dec.listener, {});
        });

        it('falls through to close() if flush() promise rejects', function(done) {
            const dec = new WebCodecsOpus(1, {sampleRate: 48000});
            const fake = fakes[0];
            dec.destroy();
            fake._pendingFlush.reject(new Error('flush rejected'));
            Promise.resolve().then(function() {
                // Microtask for .then handler.
                return Promise.resolve();
            }).then(function() {
                equal(fake.closeCount, 1);
                deepEqual(dec.listener, {});
                done();
            }).catch(done);
        });

        it('finalizes on timeout if flush() never settles', function(done) {
            // The backstop. A real-world frozen flush would otherwise
            // retain `dec` and the listener list forever. Wait
            // FLUSH_TIMEOUT_MS + a small buffer for the timer to fire.
            this.timeout(FLUSH_TIMEOUT_MS + 1500);
            const dec = new WebCodecsOpus(1, {sampleRate: 48000});
            const fake = fakes[0];
            dec.destroy();
            equal(fake.closeCount, 0, 'not yet closed');

            setTimeout(function() {
                try {
                    equal(fake.closeCount, 1, 'closed after timeout');
                    deepEqual(dec.listener, {}, 'listeners cleared');
                    done();
                } catch (e) {
                    done(e);
                }
            }, FLUSH_TIMEOUT_MS + 200);
        });

        it('does not double-close when flush settles after timeout fired', function(done) {
            // The `finalized` guard. Both timeout and flush-resolve
            // call finalize; only the first should take effect.
            this.timeout(FLUSH_TIMEOUT_MS + 1500);
            const dec = new WebCodecsOpus(1, {sampleRate: 48000});
            const fake = fakes[0];
            dec.destroy();

            setTimeout(function() {
                // Timeout has fired by now -> closeCount === 1.
                // Resolving the deferred should NOT trigger a second
                // close.
                fake._pendingFlush.resolve();
                Promise.resolve().then(function() {
                    try {
                        equal(fake.closeCount, 1, 'still only one close');
                        done();
                    } catch (e) {
                        done(e);
                    }
                });
            }, FLUSH_TIMEOUT_MS + 200);
        });

        it('does not fire timeout if flush resolves first', function(done) {
            // The other half of the `finalized` guard: timeout
            // shouldn't double-finalize after a fast flush. Hard to
            // observe directly; we resolve the flush and then wait
            // past the timeout to make sure closeCount is still 1.
            this.timeout(FLUSH_TIMEOUT_MS + 1500);
            const dec = new WebCodecsOpus(1, {sampleRate: 48000});
            const fake = fakes[0];
            dec.destroy();
            fake._pendingFlush.resolve();

            // Wait past FLUSH_TIMEOUT_MS to see if a stray timeout
            // somehow fires a second close.
            setTimeout(function() {
                try {
                    equal(fake.closeCount, 1, 'no double-close from late timeout');
                    done();
                } catch (e) {
                    done(e);
                }
            }, FLUSH_TIMEOUT_MS + 200);
        });
    });
});
