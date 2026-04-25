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

        let nativeSupport = options.useNative &&
            typeof AudioDecoder !== 'undefined' &&
            typeof EncodedAudioChunk !== 'undefined';

        this.decoder = null;
        if (nativeSupport) {
            const native = new WebCodecsOpus(options.channels, options);
            if (native.isSupported) {
                this.decoder = native;
            } else {
                // WebCodecs claimed support at the global level but
                // `AudioDecoder.configure()` rejected our config (e.g.
                // a build that exposes the API but ships no opus
                // decoder). Tear the dead instance down and fall
                // through to the worker path under the same `fallback`
                // policy as the no-native-at-all case.
                native.destroy();
            }
        }
        if (!this.decoder && options.fallback) {
            this.decoder = new OpusWorker(options.channels, options);
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
