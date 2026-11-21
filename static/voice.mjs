export function encodeWav(chunks, sampleRate) {
  const count = chunks.reduce((n, a) => n + a.length, 0);
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  const string = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  string(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); string(8, 'WAVE'); string(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); string(36, 'data'); view.setUint32(40, count * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (const value of chunk) { const x = Math.max(-1, Math.min(1, value)); view.setInt16(offset, x < 0 ? x * 32768 : x * 32767, true); offset += 2; }
  return buffer;
}

export class VoiceInput {
  constructor({onStart, onSegment, onLevel, onDiscard}) {
    Object.assign(this, {onStart, onSegment, onLevel, onDiscard, threshold: .018, endSilenceMs:650, active: false, speaking: false});
  }
  async start({manual = false} = {}) {
    this.manual = manual;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前页面无法使用麦克风，请使用 Chrome 打开本地地址。');
    this.stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true}});
    try {
      this.context = new AudioContext();
      await this.context.audioWorklet.addModule('/capture-worklet.js');
      this.source = this.context.createMediaStreamSource(this.stream);
      this.processor = new AudioWorkletNode(this.context, 'voice-capture');
      this.mute = this.context.createGain(); this.mute.gain.value = 0;
      this.source.connect(this.processor); this.processor.connect(this.mute); this.mute.connect(this.context.destination);
      this.preRoll = []; this.current = []; this.loudMs = 0; this.quietMs = 0; this.duration = 0; this.voicedMs = 0;
      this.processor.port.onmessage = e => this.consume(e.data);
      this.active = true; await this.context.resume();
      if (manual) { this.speaking = true; this.onStart(); }
    } catch (e) { await this.stop(); throw e; }
  }
  consume(samples) {
    if (!this.active) return;
    const ms = samples.length / this.context.sampleRate * 1000;
    const rms = Math.sqrt(samples.reduce((n, x) => n + x * x, 0) / samples.length);
    this.onLevel(Math.min(1, rms / .12));
    if (this.manual) {
      this.current.push(samples); this.duration += ms;
      if (rms > this.threshold) this.voicedMs += ms;
      return;
    }
    this.preRoll.push(samples);
    while (this.preRoll.length * ms > 350) this.preRoll.shift();
    const loud = rms > this.threshold;
    if (!this.speaking) {
      this.loudMs = loud ? this.loudMs + ms : Math.max(0, this.loudMs - ms * 2);
      if (this.loudMs < 110) return;
      this.speaking = true; this.current = [...this.preRoll]; this.quietMs = 0; this.duration = 350; this.voicedMs = this.loudMs;
      this.onStart(); return;
    }
    this.current.push(samples); this.duration += ms;
    this.quietMs = loud ? 0 : this.quietMs + ms;
    if (loud) this.voicedMs += ms;
    if (this.duration > 35000) {
      this.onSegment(encodeWav(this.current, this.context.sampleRate), false);
      this.current = []; this.duration = 0;
    }
    if (this.quietMs > this.endSilenceMs) {
      const data = this.current; const valid = this.voicedMs >= 200;
      const endedAt=performance.now()-this.quietMs;
      this.speaking = false; this.current = []; this.preRoll = []; this.loudMs = 0; this.quietMs = 0; this.voicedMs = 0;
      if (valid) this.onSegment(encodeWav(data, this.context.sampleRate), true, {endedAt});
      else this.onDiscard?.();
    }
  }
  async finishManual() {
    if (!this.active || !this.manual) return;
    const valid = this.voicedMs >= 160, data = encodeWav(this.current, this.context.sampleRate), endedAt=performance.now();
    await this.stop();
    if (valid) this.onSegment(data, true, {endedAt}); else this.onDiscard?.();
  }
  async stop() {
    this.active = false; this.speaking = false;
    this.stream?.getTracks().forEach(t => t.stop());
    this.processor?.disconnect(); this.source?.disconnect(); this.mute?.disconnect();
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.onLevel(0);
  }
}
