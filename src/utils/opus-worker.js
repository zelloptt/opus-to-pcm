import Event from './event.js';
// Imported via webpack `asset/source` (or an equivalent raw-string import in
// other bundlers). This gives us the minified worker bundle as a plain JS
// string, so we can manage the Blob URL lifecycle ourselves rather than
// relying on a bundler loader to do it for us.
//
// We used to import this file with the webpack worker-loader convention
// (`import OpusWorkerBin from './opus.min.worker'; new OpusWorkerBin()`),
// which under `workerize-loader@2.0.2` with `inline: true` expanded to a
// generated wrapper that interpolated the build-time `URL.createObjectURL(
// new Blob([src]))` expression twice — once into `new Worker(...)` and once
// into `URL.revokeObjectURL(...)` — so every constructed decoder allocated
// two Blobs, handed the first URL to the Worker, and then revoked a fresh
// second URL that nothing else referenced. That leaked ~918 KB of retained
// Blob storage per decoder in the renderer.
import opusWorkerSource from './opus.min.worker.js';

// Cache a single Blob across all OpusWorker instances. The underlying string
// is already held once in the bundle as a module constant; caching the Blob
// lets us allocate exactly one Blob per process instead of one per decoder.
let cachedWorkerBlob = null;

function getWorkerBlob() {
    if (!cachedWorkerBlob) {
        cachedWorkerBlob = new Blob([opusWorkerSource], {type: 'application/javascript'});
    }
    return cachedWorkerBlob;
}

// Create a Worker from the inlined opus decoder bundle and revoke the backing
// blob: URL synchronously after construction. The Worker latches the
// resource during `new Worker(url)`, so revoking immediately afterwards is
// both safe and what MDN recommends:
//   https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL#memory_management
function createOpusWorker() {
    const url = URL.createObjectURL(getWorkerBlob());
    try {
        return new Worker(url, {name: 'opus.min.worker.js'});
    } finally {
        URL.revokeObjectURL(url);
    }
}

export default class OpusWorker extends Event {
    constructor(channels, config) {
        super('worker');
        this.worker = createOpusWorker();
        this.worker.addEventListener('message', this.onMessage.bind(this));
        this.worker.addEventListener('error', (event) => {
            if (!event.message || !event.message.includes('corrupted stream') || !this.config.handleCorruptedStream) {
                return;
            }
            this.dispatch('corrupted_stream');
            event.preventDefault();
        });
        this.config = Object.assign({
            rate: 24000,
            channels
        }, config, {rate: config.sampleRate});

        let message = {
            type: 'init',
            config: this.config
        };
        this.sampleRate = this.config.rate;
        this.worker.postMessage(message);
    }

    getSampleRate() {
        return this.sampleRate;
    }

    // NOTE: This function transfers the memory ownership of the packet
    // to a web worker.
    decode(packet) {
        let workerData = {
            type: 'decode',
            buffer: packet
        };
        // Passing the buffer with the transfer list prevents the browser
        // from copying the bytes. Same physical memory, but now owned by the worker thread
        this.worker.postMessage(workerData, [packet.buffer]);
    }

    onMessage(event) {
        let data = event.data;
        // The first message from the opus worker does not contain a buffer in event.data
        // Instead, it contains the following object:
        // data: {
        //   method: "ready",
        //   type: "RPC"
        // }
        if (data.type === 'RPC') {
            return;
        }
        this.dispatch('data', data.buffer);
    }

    destroy() {
        this.worker.postMessage({
            type: 'destroy'
        });
        // Ideally we could receive a message from the worker
        // telling us that it's completed processing the "destroy"
        // command, but until that is possible, this is a reasonable
        // workaround.
        setTimeout(() => {
            this.worker.terminate();
            this.worker = null;
        }, 100); // ms
        this.offAll();
    }
}
