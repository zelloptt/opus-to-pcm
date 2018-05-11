import Event from './event.js';
import OpusWorkerBin from './opus.min.worker'

export default class OpusWorker extends Event {
    constructor(channels) {
        super('worker');
        this.worker = new OpusWorkerBin();
        this.worker.addEventListener('message', this.onMessage.bind(this));
        this.worker.postMessage({
            type: 'init',
            config: {
                rate:24000,
                channels:channels
            }
        });
    }

    getSampleRate() {
        return 24000;
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
        this.worker = null;
        this.offAll();
    }
}
