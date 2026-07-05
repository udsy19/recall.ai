import fs from 'node:fs';

/** Streaming mono 16-bit WAV writer (header patched on close). */
export class WavWriter {
  constructor(path, sampleRate = 16000) {
    this.fd = fs.openSync(path, 'w');
    this.sampleRate = sampleRate;
    this.dataBytes = 0;
    fs.writeSync(this.fd, Buffer.alloc(44)); // placeholder header
  }

  write(pcm) {
    fs.writeSync(this.fd, pcm);
    this.dataBytes += pcm.length;
  }

  close() {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + this.dataBytes, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(this.sampleRate, 24); h.writeUInt32LE(this.sampleRate * 2, 28);
    h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(this.dataBytes, 40);
    fs.writeSync(this.fd, h, 0, 44, 0);
    fs.closeSync(this.fd);
  }
}
