const assert = require('node:assert/strict'), vm = require('node:vm');
const { buildSync } = require('../web/node_modules/esbuild');
const code = buildSync({ entryPoints: ['web/src/media-session.js'], bundle: true, format: 'cjs', write: false }).outputFiles[0].text;
const actions = {}, positions = [], session = {
  setActionHandler(name, callback) { if (name === 'stop') throw Error('unsupported'); actions[name] = callback; },
  setPositionState(state) { positions.push(state); },
};
let pos = 30, dur = 120, playing = false, seekCount = 0;
const player = { meta: { name: 'Fixture', artists: 'Artist', pic: 'not a usable image' }, audio: { playbackRate: 1.25 },
  durMs: () => dur * 1000, posMs: () => pos * 1000, isPlaying: () => playing,
  play() { playing = true; }, pause() { playing = false; }, prev() {}, next() {}, seek(value) { pos = value; seekCount++; } };
const context = { module: { exports: {} }, exports: {}, navigator: { mediaSession: session }, URL, WeakMap,
  location: { href: 'https://fixture.invalid/app/' }, MediaMetadata: class {
    constructor(info) { if (info.artwork) throw Error('artwork rejected'); Object.assign(this, info); }
  } };
vm.runInNewContext(code, context);
const { updateBrowserMediaSession, updateBrowserMediaState } = context.module.exports;
updateBrowserMediaSession(player);
assert.equal(session.metadata.title, 'Fixture');
for (const name of ['play','pause','seekto','seekforward','seekbackward','nexttrack','previoustrack']) assert.equal(typeof actions[name], 'function');
actions.play(); updateBrowserMediaState(player); assert.equal(session.playbackState, 'playing');
assert.equal(positions.at(-1).playbackRate, 1.25);
actions.seekto({ seekTime: 200 }); assert.equal(pos, 120);
actions.seekbackward({ seekOffset: 15 }); assert.equal(pos, 105);
actions.seekforward(); assert.equal(pos, 115);
actions.seekto({ seekTime: -10 }); assert.equal(pos, 0);
const before = seekCount; actions.seekto({ seekTime: NaN }); assert.equal(seekCount, before);
actions.pause(); updateBrowserMediaState(player); assert.equal(session.playbackState, 'paused');
dur = 0; updateBrowserMediaState(player); assert.equal(Object.keys(positions.at(-1)).length, 0);
updateBrowserMediaState(player, 'none'); assert.equal(session.playbackState, 'none');
updateBrowserMediaState(player); assert.equal(session.playbackState, 'none');
actions.play(); updateBrowserMediaState(player); assert.equal(session.playbackState, 'playing');
console.log('PASS Media Session: bad artwork/unsupported action isolation, transport/seek controls, clamped position, playback rate, invalid duration and stop/resume');
