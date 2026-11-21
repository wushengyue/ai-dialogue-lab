import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeWav, VoiceInput} from '../static/voice.mjs';

test('WAV preserves sample rate, clips PCM, and declares the exact payload length', () => {
  const buffer = encodeWav([new Float32Array([-2, 0, 2])], 48000);
  const view = new DataView(buffer);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint32(40, true), 6);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(48, true), 32767);
});

test('continuous capture starts on sustained speech and submits after silence', () => {
  let starts = 0; const segments = [];
  const input = new VoiceInput({onStart: () => starts++, onSegment: (b, final) => segments.push({b, final}), onLevel: () => {}});
  Object.assign(input, {active: true, context: {sampleRate: 16000}, preRoll: [], current: [], loudMs: 0, quietMs: 0, duration: 0, voicedMs: 0});
  for (let i=0; i<40; i++) input.consume(new Float32Array(160).fill(.08));
  assert.equal(starts, 1); assert.equal(input.speaking, true);
  for (let i=0; i<90; i++) input.consume(new Float32Array(160));
  assert.equal(input.speaking, false); assert.equal(segments.length, 1); assert.equal(segments[0].final, true);
  assert.ok(segments[0].b.byteLength > 44);
});
