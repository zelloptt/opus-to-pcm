import {equal, deepEqual, ok, strictEqual} from 'assert';
import {
    toUint8Array,
    interleave,
    decimateInterleave,
    linearResampleInterleave
} from '../src/utils/webcodecs-opus.js';

// These tests cover the pure helpers behind the WebCodecs path. Most
// were tier-1 in the bug-review write-up: easy to test, no browser
// features required, and the place where the most subtle behavior
// lives (the resampling math is what made the first cut of the
// decoder play back at half speed and an octave low).

function f32(values) {
    return Float32Array.from(values);
}

// Compare two Float32Arrays sample-by-sample within a tolerance. We
// don't use `deepEqual` because it would require bit-exact equality
// even for arithmetic that involves division.
function approx(actual, expected, eps) {
    eps = eps == null ? 1e-6 : eps;
    equal(actual.length, expected.length, 'length mismatch');
    for (let i = 0; i < actual.length; i++) {
        const diff = Math.abs(actual[i] - expected[i]);
        ok(diff <= eps,
            'sample ' + i + ': expected ' + expected[i] +
            ', got ' + actual[i] + ' (diff ' + diff + ' > eps ' + eps + ')');
    }
}

describe('toUint8Array --', function() {
    it('returns null for null/undefined', function() {
        equal(toUint8Array(null), null);
        equal(toUint8Array(undefined), null);
    });

    it('returns the same instance when given a Uint8Array', function() {
        const buf = new Uint8Array([1, 2, 3]);
        // Identity is intentional: avoids an unnecessary copy on the
        // hot path. Callers that care must clone themselves.
        strictEqual(toUint8Array(buf), buf);
    });

    it('wraps a raw ArrayBuffer in a Uint8Array view', function() {
        const ab = new ArrayBuffer(4);
        new Uint8Array(ab).set([10, 20, 30, 40]);
        const out = toUint8Array(ab);
        ok(out instanceof Uint8Array);
        deepEqual(Array.from(out), [10, 20, 30, 40]);
    });

    it('wraps non-Uint8 typed arrays sharing the underlying buffer', function() {
        // Critical: must respect byteOffset and byteLength so a
        // sub-view of a larger ArrayBuffer doesn't get re-interpreted
        // from offset 0 (which would silently send the wrong bytes
        // into the decoder).
        const big = new Uint8Array([0xAA, 0xBB, 1, 2, 3, 4, 0xCC]);
        const view = new Uint8Array(big.buffer, 2, 4); // [1,2,3,4]
        const i16 = new Int16Array(view.buffer, view.byteOffset, 2);
        const out = toUint8Array(i16);
        ok(out instanceof Uint8Array);
        equal(out.byteOffset, 2);
        equal(out.byteLength, 4);
        deepEqual(Array.from(out), [1, 2, 3, 4]);
    });

    it('returns null for unsupported types', function() {
        equal(toUint8Array('string'), null);
        equal(toUint8Array(42), null);
        equal(toUint8Array({}), null);
        equal(toUint8Array([1, 2, 3]), null);
    });
});

describe('interleave --', function() {
    it('returns the single plane unchanged for mono', function() {
        // Identity for mono is an explicit perf optimization; not just
        // an incidental property. Locking it in so it doesn't silently
        // regress to "always allocate and copy".
        const plane = f32([1, 2, 3, 4]);
        strictEqual(interleave([plane], 4, 1), plane);
    });

    it('interleaves stereo as [L0,R0,L1,R1,...]', function() {
        const left = f32([1, 2, 3]);
        const right = f32([10, 20, 30]);
        const out = interleave([left, right], 3, 2);
        deepEqual(Array.from(out), [1, 10, 2, 20, 3, 30]);
    });

    it('handles empty input', function() {
        const out = interleave([f32([]), f32([])], 0, 2);
        equal(out.length, 0);
    });
});

describe('decimateInterleave --', function() {
    it('decim=1 is identity (delegates to interleave)', function() {
        const plane = f32([1, 2, 3]);
        strictEqual(decimateInterleave([plane], 3, 1, 1), plane);
    });

    it('mono decim=2 averages adjacent pairs', function() {
        // 48k -> 24k path. The most common production case for the
        // SDK (narrowband/mediumband Opus streams).
        const plane = f32([1, 2, 3, 4, 5, 6]);
        const out = decimateInterleave([plane], 6, 1, 2);
        approx(out, f32([1.5, 3.5, 5.5]));
    });

    it('drops trailing samples that don\'t fill a full block', function() {
        // Documents the explicit floor() in the implementation.
        // 5 samples / 2 = 2 output frames, last sample discarded.
        const plane = f32([1, 2, 3, 4, 5]);
        const out = decimateInterleave([plane], 5, 1, 2);
        approx(out, f32([1.5, 3.5]));
    });

    it('mono decim=6 averages 6-sample blocks (48k -> 8k)', function() {
        // Sanity check the largest production decimation factor.
        const plane = f32([1, 1, 1, 1, 1, 1, 7, 7, 7, 7, 7, 7]);
        const out = decimateInterleave([plane], 12, 1, 6);
        approx(out, f32([1, 7]));
    });

    it('stereo decim=2 decimates each channel independently', function() {
        const left = f32([1, 2, 3, 4]);
        const right = f32([10, 20, 30, 40]);
        const out = decimateInterleave([left, right], 4, 2, 2);
        // [L0avg, R0avg, L1avg, R1avg] = [1.5, 15, 3.5, 35]
        approx(out, f32([1.5, 15, 3.5, 35]));
    });

    it('preserves DC: constant input produces the same constant output', function() {
        // Critical property of any anti-alias filter that's a unity-DC
        // FIR: the boxcar's coefficients are 1/N each, so for any
        // constant input the output equals that same constant. If a
        // future change accidentally drops the 1/N normalization (or
        // rescales it), this test catches it instantly.
        const N = 12;
        const plane = new Float32Array(N);
        plane.fill(0.42);
        const out = decimateInterleave([plane], N, 1, 4);
        approx(out, f32([0.42, 0.42, 0.42]));
    });

    it('attenuates the source-Nyquist sinusoid (anti-aliasing sanity)', function() {
        // The boxcar's first null is at srcRate/N. For decim=2 that's
        // exactly the source Nyquist, which means a +/-1 alternating
        // signal (the worst-case alias source) collapses to ~0. Test
        // that we get strong attenuation, not the +/-1 you'd see from
        // naive subsampling.
        const N = 16;
        const plane = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            plane[i] = (i % 2 === 0) ? 1 : -1;
        }
        const out = decimateInterleave([plane], N, 1, 2);
        // Block average of [1,-1] = 0.
        for (let i = 0; i < out.length; i++) {
            ok(Math.abs(out[i]) < 1e-9,
                'expected near-zero at index ' + i + ', got ' + out[i]);
        }
    });
});

describe('linearResampleInterleave --', function() {
    it('mono identity-rate resample reproduces the input', function() {
        // Linear interp at i=0 picks i0=0, frac=0 -> exactly src[0].
        // At other integer src positions, frac=0 again. So sampling
        // at the same rate is a no-op modulo float math.
        const plane = f32([1, 2, 3, 4]);
        const out = linearResampleInterleave([plane], 4, 1, 48000, 48000);
        approx(out, plane);
    });

    it('mono 2:1 down via linear interp gives mid-point of pairs', function() {
        // ratio=2, so output sample i is src[2i]; not interpolated.
        // (linear interp degenerates to nearest when frac is exactly
        // 0.) That's fine for non-integer ratios where this branch
        // actually runs; this case just documents the math.
        const plane = f32([0, 10, 20, 30, 40, 50]);
        const out = linearResampleInterleave([plane], 6, 1, 48000, 24000);
        approx(out, f32([0, 20, 40]));
    });

    it('mono 3:2 fractional resample interpolates between samples', function() {
        // ratio = 1.5. Output positions in src: 0, 1.5, 3.0, ...
        //   i=0: src[0]                              = 0
        //   i=1: src[1] + 0.5 * (src[2] - src[1])    = 10 + 5  = 15
        //   i=2: src[3]                              = 30
        //   i=3: src[4] + 0.5 * (src[5] - src[4])    = 40 + 5  = 45
        const plane = f32([0, 10, 20, 30, 40, 50]);
        // outFrames = floor(6 * 2/3) = 4
        const out = linearResampleInterleave([plane], 6, 1, 48000, 32000);
        approx(out, f32([0, 15, 30, 45]));
    });

    it('clamps the upper interpolation index to the last frame', function() {
        // The implementation uses Math.min(i0+1, numFrames-1). Without
        // that clamp, the very last output sample reads past the end
        // of the source plane and grabs whatever sentinel zero the
        // typed-array allocator left there. This test forces the
        // clamp to matter by making the last output sample land
        // exactly on the last source sample.
        const plane = f32([1, 2, 3, 4]);
        // outFrames = floor(4 * 4/4) = 4. ratio = 1.
        const out = linearResampleInterleave([plane], 4, 1, 4, 4);
        approx(out, plane);
    });

    it('stereo resamples each channel independently', function() {
        const left = f32([0, 10, 20, 30, 40, 50]);
        const right = f32([0, 100, 200, 300, 400, 500]);
        const out = linearResampleInterleave([left, right], 6, 2, 48000, 32000);
        // Same positions as the mono 3:2 case, x10 on the right.
        approx(out, f32([0, 0, 15, 150, 30, 300, 45, 450]));
    });
});
