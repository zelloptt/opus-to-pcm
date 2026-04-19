import Event from './utils/event.js';
import OpusWorker from './utils/opus-worker.js';
import WebCodecsOpus from './utils/webcodecs-opus.js';
export class OpusToPCM extends Event {

    constructor(options) {
        super('decoder');
        let defaults = {
            channels: 1,
            fallback: true,
            useNative: false,
            handleCorruptedStream: false
        };
        options = Object.assign({}, defaults, options);

        // Opt-in native Opus decoding via the browser's WebCodecs
        // `AudioDecoder`. Disabled by default; existing consumers that
        // don't pass `useNative` keep the `OpusWorker` (libopus-in-worker)
        // path they've always used.
        //
        // When `useNative: true` is requested but the environment can't
        // provide `AudioDecoder`, fall through to the worker path iff
        // `fallback: true` (the default). Chromium-based environments
        // (Electron / Dispatch Hub) ship `AudioDecoder` and are required
        // by spec to support `codec: 'opus'`.
        let nativeSupport = options.useNative && typeof AudioDecoder !== 'undefined';

        if (nativeSupport) {
            this.decoder = new WebCodecsOpus(options.channels, options);
        } else if (options.fallback) {
            this.decoder = new OpusWorker(options.channels, options);
        } else {
            this.decoder = null;
        }

        if (this.decoder) {
            this.decoder.on('data', (data) => {
                this.dispatch('decode', data);
                this.ondata(data);
            });
            this.decoder.on('corrupted_stream', (data) => {
                this.dispatch('corrupted_stream', data);
            });
        }
    }

    getSampleRate() {
        return this.decoder.getSampleRate();
    }

    ondata() {}

    decode(packet) {
        if (!this.decoder) {
            throw ('oops! no decoder is found to decode');
        }
        this.decoder.decode(packet);
    }

    destroy() {
        this.decoder.destroy();
        this.offAll();
    }
}
