// AudioWorklet: hands raw mic samples to the page in ~21 ms frames
// (1024 samples at 48 kHz). Loaded by web/src/lib/voiceInput.ts.
// Plain JS in public/ because worklets load as separate files.
class LunaCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(1024);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.frame[this.filled++] = channel[i];
        if (this.filled === this.frame.length) {
          this.port.postMessage(this.frame.slice(0));
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("luna-capture", LunaCapture);
