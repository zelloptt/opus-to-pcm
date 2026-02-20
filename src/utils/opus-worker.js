import Event from './event.js';
import OpusWorkerBin from './opus.min.worker';

export default class OpusWorker extends Event {
    constructor(channels, config) {
        super('worker');
        this.worker = new OpusWorkerBin();
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
        // The first message from OpusWorkerBin does not contain a buffer in event.data
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
