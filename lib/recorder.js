'use strict';

Object.defineProperty(exports, "__esModule", {
    value: true
});
exports.Recorder = undefined;

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

var _inlineWorker = require('inline-worker');

var _inlineWorker2 = _interopRequireDefault(_inlineWorker);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var Recorder = exports.Recorder = function () {
    function Recorder(source, cfg) {
        var _this = this;

        _classCallCheck(this, Recorder);

        this.config = {
            bufferLen: 4096,
            numChannels: 2,
            mimeType: 'audio/wav',
            outputFormat: 's16'
        };
        this.bufferCount = 0;
        this.recordingPromise = null;
        this.resolveRecordingPromise = null;
        this.rejectRecordingPromise = null;
        this.fetchingRaw = false;
        this.exportRawPromise = null;
        this.resolveExportRawPromise = null;
        this.rejectExportRawPromise = null;
        this.recording = false;
        this.callbacks = {
            getBuffer: [],
            exportWAV: [],
            exportRaw: []
        };

        Object.assign(this.config, cfg);
        this.context = source.context;
        this.node = (this.context.createScriptProcessor || this.context.createJavaScriptNode).call(this.context, this.config.bufferLen, this.config.numChannels, this.config.numChannels);

        this.node.onaudioprocess = function (e) {
            if (!_this.recording) return;

            if (_this.bufferCount === 0) {
                _this.resolveRecordingPromise();
            }

            _this.bufferCount++;

            var buffer = [];
            for (var channel = 0; channel < _this.config.numChannels; channel++) {
                buffer.push(e.inputBuffer.getChannelData(channel));
            }

            _this.worker.postMessage({
                command: 'record',
                buffer: buffer,
                fetchingRaw: _this.fetchingRaw,
                fetchingRawType: 'application/octet-stream'
            });

            if (_this.fetchingRaw) _this.fetchingRaw = false;
        };

        source.connect(this.node);
        this.node.connect(this.context.destination); //this should not be necessary

        var self = {};
        this.worker = new _inlineWorker2.default(function () {
            var recLength = 0,
                recBuffers = [],
                sampleRate = void 0,
                numChannels = void 0,
                outputFormat = void 0;

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
                var buffers = [];
                for (var channel = 0; channel < numChannels; channel++) {
                    buffers.push(mergeBuffers(recBuffers[channel], recLength));
                }
                var interleaved = void 0;
                if (numChannels === 2) {
                    interleaved = interleave(buffers[0], buffers[1]);
                } else {
                    interleaved = buffers[0];
                }
                var dataview = encodeWAV(interleaved);
                var audioBlob = new Blob([dataview], { type: type });

                self.postMessage({ command: 'exportWAV', data: audioBlob });
            }

            function exportRaw(type) {
                console.log('[recorderjs] Calling exportRaw in worker');
                var buffers = [];
                for (var channel = 0; channel < numChannels; channel++) {
                    buffers.push(mergeBuffers(recBuffers[channel], recLength));
                }
                var interleaved = void 0;
                if (numChannels === 2) {
                    interleaved = interleave(buffers[0], buffers[1]);
                } else {
                    interleaved = buffers[0];
                }
                console.log('[recorderjs] outputFormat:', outputFormat);
                var dataview = outputFormat && outputFormat === 'f64' ? float32Tofloat64(interleaved) : encode16BitPCM(interleaved);
                var audioBlob = new Blob([dataview], { type: type });

                self.postMessage({ command: 'exportRaw', data: audioBlob });
            }

            function getBuffer() {
                var buffers = [];
                for (var channel = 0; channel < numChannels; channel++) {
                    buffers.push(mergeBuffers(recBuffers[channel], recLength));
                }
                self.postMessage({ command: 'getBuffer', data: buffers });
            }

            function clear() {
                recLength = 0;
                recBuffers = [];
                initBuffers();
            }

            function initBuffers() {
                for (var channel = 0; channel < numChannels; channel++) {
                    recBuffers[channel] = [];
                }
            }

            function mergeBuffers(recBuffers, recLength) {
                var result = new Float32Array(recLength);
                var offset = 0;
                for (var i = 0; i < recBuffers.length; i++) {
                    result.set(recBuffers[i], offset);
                    offset += recBuffers[i].length;
                }
                return result;
            }

            function interleave(inputL, inputR) {
                var length = inputL.length + inputR.length;
                var result = new Float32Array(length);

                var index = 0,
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
                for (var i = 0; i < input.length; i++, offset += 2) {
                    var s = Math.max(-1, Math.min(1, input[i]));
                    output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
                }
            }

            function writeString(view, offset, string) {
                for (var i = 0; i < string.length; i++) {
                    view.setUint8(offset + i, string.charCodeAt(i));
                }
            }

            function encode16BitPCM(samples) {
                var buffer = new ArrayBuffer(samples.length * 2);
                var view = new DataView(buffer);

                floatTo16BitPCM(view, 0, samples);

                return view;
            }

            function encodeWAV(samples) {
                var buffer = new ArrayBuffer(44 + samples.length * 2);
                var view = new DataView(buffer);

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

        this.worker.onmessage = function (e) {

            var cb = _this.callbacks[e.data.command].pop();
            if (typeof cb == 'function') {
                cb(e.data.data);
            }
            if (e.data.command === 'exportRaw') {
                _this.resolveExportRawPromise(e.data.data);
            }
        };
    }

    _createClass(Recorder, [{
        key: 'record',
        value: function record() {
            var _this2 = this;

            if (this.recording) {
                return this.recordingPromise;
            }
            this.bufferCount = 0;
            this.recording = true;
            this.recordingPromise = new Promise(function (resolve, reject) {
                _this2.resolveRecordingPromise = resolve;
                _this2.rejectRecordingPromise = reject;
            });
            return this.recordingPromise;
        }
    }, {
        key: 'stop',
        value: function stop() {
            if (this.fetchingRaw) {
                this.fetchingRaw = false;
                this.worker.postMessage({
                    command: 'exportRaw',
                    type: 'application/octet-stream'
                });
            }
            this.recording = false;
        }
    }, {
        key: 'clear',
        value: function clear() {
            this.worker.postMessage({ command: 'clear' });
        }
    }, {
        key: 'getBuffer',
        value: function getBuffer(cb) {
            cb = cb || this.config.callback;
            if (!cb) throw new Error('Callback not set');

            this.callbacks.getBuffer.push(cb);

            this.worker.postMessage({ command: 'getBuffer' });
        }
    }, {
        key: 'exportWAV',
        value: function exportWAV(cb, mimeType) {
            mimeType = mimeType || this.config.mimeType;
            cb = cb || this.config.callback;
            if (!cb) throw new Error('Callback not set');

            this.callbacks.exportWAV.push(cb);

            this.worker.postMessage({
                command: 'exportWAV',
                type: mimeType
            });
        }
    }, {
        key: 'exportRaw',
        value: function exportRaw(cb) {
            var _this3 = this;

            this.exportRawPromise = new Promise(function (resolve, reject) {
                _this3.resolveExportRawPromise = resolve;
                _this3.rejectExportRawPromise = reject;
                _this3.fetchingRaw = true;
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
    }], [{
        key: 'forceDownload',
        value: function forceDownload(blob, filename) {
            var url = (window.URL || window.webkitURL).createObjectURL(blob);
            var link = window.document.createElement('a');
            link.href = url;
            link.download = filename || 'output.wav';
            var click = document.createEvent("Event");
            click.initEvent("click", true, true);
            link.dispatchEvent(click);
        }
    }]);

    return Recorder;
}();

exports.default = Recorder;