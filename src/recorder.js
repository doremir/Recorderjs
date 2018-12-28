import InlineWorker from 'inline-worker';

export class Recorder {
    config = {
        bufferLen: 4096,
        numChannels: 2,
        mimeType: 'audio/wav',
        outputFormat: 's16'
    };

    bufferCount = 0;

    recordingPromise = null;
    resolveRecordingPromise = null;
    rejectRecordingPromise = null;

    fetchingRaw = false;
    exportRawPromise = null;
    resolveExportRawPromise = null;
    rejectExportRawPromise = null;

    recording = false;

    callbacks = {
        getBuffer: [],
        exportWAV: [],
        exportRaw: []
    };

    constructor(source, cfg) {
        Object.assign(this.config, cfg);
        this.context = source.context;
        this.node = (this.context.createScriptProcessor ||
        this.context.createJavaScriptNode).call(this.context,
            this.config.bufferLen, this.config.numChannels, this.config.numChannels);

        this.node.onaudioprocess = (e) => {
            if (!this.recording) return;

            if (this.bufferCount === 0) {
                this.resolveRecordingPromise();
            }

            this.bufferCount++;

            var buffer = [];
            for (var channel = 0; channel < this.config.numChannels; channel++) {
                buffer.push(e.inputBuffer.getChannelData(channel));
            }

            this.worker.postMessage({
                command: 'record',
                buffer: buffer,
                fetchingRaw: this.fetchingRaw,
                fetchingRawType: 'application/octet-stream'
            });

            if (this.fetchingRaw) this.fetchingRaw = false;
        };

        source.connect(this.node);
        this.node.connect(this.context.destination);    //this should not be necessary

        let self = {};
        this.worker = new InlineWorker(function () {
            let recLength = 0,
                recBuffers = [],
                sampleRate,
                numChannels,
                outputFormat;

            self.onmessage = function (e) {
                switch (e.data.command) {
                    case 'init':
                        init(e.data.config);
                        break;
                    case 'record':
                        record(e.data.buffer, e.data.fetchingRaw, e.data.fetchingRawType);
                        break;
                    case 'exportWAV':
                        exportWAV(e.data.type);
                        break;
                    case 'exportRaw':
                        exportRaw(e.data.type);
                        break;
                    case 'getBuffer':
                        getBuffer();
                        break;
                    case 'clear':
                        clear();
                        break;
                }
            };

            function init(config) {
                sampleRate = config.sampleRate;
                numChannels = config.numChannels;
                outputFormat = config.outputFormat;
                initBuffers();
            }

            function record(inputBuffer, fetchingRaw, fetchingRawType) {

                for (var channel = 0; channel < numChannels; channel++) {
                    recBuffers[channel].push(inputBuffer[channel]);
                }
                recLength += inputBuffer[0].length;
                if (fetchingRaw) {
                    exportRaw(fetchingRawType);
                }
            }

            function exportWAV(type) {
                let buffers = [];
                for (let channel = 0; channel < numChannels; channel++) {
                    buffers.push(mergeBuffers(recBuffers[channel], recLength));
                }
                let interleaved;
                if (numChannels === 2) {
                    interleaved = interleave(buffers[0], buffers[1]);
                } else {
                    interleaved = buffers[0];
                }
                let dataview = encodeWAV(interleaved);
                let audioBlob = new Blob([dataview], {type: type});

                self.postMessage({command: 'exportWAV', data: audioBlob});
            }

            function exportRaw(type) {
                console.log('[recorderjs] Calling exportRaw in worker');
                let buffers = [];
                for (let channel = 0; channel < numChannels; channel++) {
                    buffers.push(mergeBuffers(recBuffers[channel], recLength));
                }
                let interleaved;
                if (numChannels === 2) {
                    interleaved = interleave(buffers[0], buffers[1]);
                } else {
                    interleaved = buffers[0];
                }
                console.log('[recorderjs] outputFormat:', outputFormat);
                var dataview = (outputFormat && outputFormat === 'f64') ? float32Tofloat64(interleaved) : encode16BitPCM(interleaved);
                let audioBlob = new Blob([dataview], {type: type});

                self.postMessage({command: 'exportRaw', data: audioBlob});
            }

            function getBuffer() {
                let buffers = [];
                for (let channel = 0; channel < numChannels; channel++) {
                    buffers.push(mergeBuffers(recBuffers[channel], recLength));
                }
                self.postMessage({command: 'getBuffer', data: buffers});
            }

            function clear() {
                recLength = 0;
                recBuffers = [];
                initBuffers();
            }

            function initBuffers() {
                for (let channel = 0; channel < numChannels; channel++) {
                    recBuffers[channel] = [];
                }
            }

            function mergeBuffers(recBuffers, recLength) {
                let result = new Float32Array(recLength);
                let offset = 0;
                for (let i = 0; i < recBuffers.length; i++) {
                    result.set(recBuffers[i], offset);
                    offset += recBuffers[i].length;
                }
                return result;
            }

            function interleave(inputL, inputR) {
                let length = inputL.length + inputR.length;
                let result = new Float32Array(length);

                let index = 0,
                    inputIndex = 0;

                while (index < length) {
                    result[index++] = inputL[inputIndex];
                    result[index++] = inputR[inputIndex];
                    inputIndex++;
                }
                return result;
            }

            function float32Tofloat64(float32Array) {
                var float64Array = new Float64Array(float32Array.length);
                for (var i = 0; i < float32Array.length; i++) {
                    float64Array[i] = float32Array[i];
                }
                return float64Array;
            }

            function floatTo16BitPCM(output, offset, input) {
                for (let i = 0; i < input.length; i++, offset += 2) {
                    let s = Math.max(-1, Math.min(1, input[i]));
                    output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
                }
            }

            function writeString(view, offset, string) {
                for (let i = 0; i < string.length; i++) {
                    view.setUint8(offset + i, string.charCodeAt(i));
                }
            }

            function encode16BitPCM(samples) {
                let buffer = new ArrayBuffer(samples.length * 2);
                let view = new DataView(buffer);

                floatTo16BitPCM(view, 0, samples);

                return view;
            }

            function encodeWAV(samples) {
                let buffer = new ArrayBuffer(44 + samples.length * 2);
                let view = new DataView(buffer);

                /* RIFF identifier */
                writeString(view, 0, 'RIFF');
                /* RIFF chunk length */
                view.setUint32(4, 36 + samples.length * 2, true);
                /* RIFF type */
                writeString(view, 8, 'WAVE');
                /* format chunk identifier */
                writeString(view, 12, 'fmt ');
                /* format chunk length */
                view.setUint32(16, 16, true);
                /* sample format (raw) */
                view.setUint16(20, 1, true);
                /* channel count */
                view.setUint16(22, numChannels, true);
                /* sample rate */
                view.setUint32(24, sampleRate, true);
                /* byte rate (sample rate * block align) */
                view.setUint32(28, sampleRate * 4, true);
                /* block align (channel count * bytes per sample) */
                view.setUint16(32, numChannels * 2, true);
                /* bits per sample */
                view.setUint16(34, 16, true);
                /* data chunk identifier */
                writeString(view, 36, 'data');
                /* data chunk length */
                view.setUint32(40, samples.length * 2, true);

                floatTo16BitPCM(view, 44, samples);

                return view;
            }
        }, self);

        this.worker.postMessage({
            command: 'init',
            config: {
                sampleRate: this.context.sampleRate,
                numChannels: this.config.numChannels,
                outputFormat: this.config.outputFormat
            }
        });

        this.worker.onmessage = (e) => {

            let cb = this.callbacks[e.data.command].pop();
            if (typeof cb == 'function') {
                cb(e.data.data);
            }
            if (e.data.command === 'exportRaw') {
                this.resolveExportRawPromise(e.data.data);
            }
        };
    }


    record() {
        if(this.recording) {
            return this.recordingPromise;
        }
        this.bufferCount = 0;
        this.recording = true;
        this.recordingPromise = new Promise((resolve, reject) => {
            this.resolveRecordingPromise = resolve;
            this.rejectRecordingPromise = reject;
        });
        return this.recordingPromise;
    }

    stop() {
        if (this.fetchingRaw) {
            this.fetchingRaw = false;
            this.worker.postMessage({
                command: 'exportRaw',
                type: 'application/octet-stream'
            });
        }
        this.recording = false;
    }

    clear() {
        this.worker.postMessage({command: 'clear'});
    }

    getBuffer(cb) {
        cb = cb || this.config.callback;
        if (!cb) throw new Error('Callback not set');

        this.callbacks.getBuffer.push(cb);

        this.worker.postMessage({command: 'getBuffer'});
    }

    exportWAV(cb, mimeType) {
        mimeType = mimeType || this.config.mimeType;
        cb = cb || this.config.callback;
        if (!cb) throw new Error('Callback not set');

        this.callbacks.exportWAV.push(cb);

        this.worker.postMessage({
            command: 'exportWAV',
            type: mimeType
        });
    }

    exportRaw(cb) {
        this.exportRawPromise = new Promise((resolve, reject) => {
            this.resolveExportRawPromise = resolve;
            this.rejectExportRawPromise = reject;
            this.fetchingRaw = true;
        });
        if (!this.recording) {
            this.fetchingRaw = false;
            this.worker.postMessage({
                command: 'exportRaw',
                type: 'application/octet-stream'
            });
        }
        return this.exportRawPromise;
    }

    static
    forceDownload(blob, filename) {
        let url = (window.URL || window.webkitURL).createObjectURL(blob);
        let link = window.document.createElement('a');
        link.href = url;
        link.download = filename || 'output.wav';
        let click = document.createEvent("Event");
        click.initEvent("click", true, true);
        link.dispatchEvent(click);
    }
}

export default Recorder;
