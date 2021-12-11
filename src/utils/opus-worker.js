import Event from './event.js';
import OpusWorkerBin from './opus.min.worker'

export default class OpusWorker extends Event {
    constructor(channels, config) {
        super('worker');
        this.worker = new OpusWorkerBin();
        this.worker.addEventListener('message', this.onMessage.bind(this));
        this.config = Object.assign({
          rate: 24000,
          channels:channels
        }, config, {rate: config.sampleRate});

        let message = {
          type: 'init',
          config: this.config
        };
        this.sampleRate = this.config.rate;
        this.worker.postMessage(JSON.parse(JSON.stringify(message)));
    }

    getSampleRate() {
        return this.sampleRate;
    }

    decode(packet) {
        let workerData = {
            type: 'decode',
            buffer: packet
        };
        this.worker.postMessage(workerData);
    }

    onMessage(event) {
        let data = event.data;
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
