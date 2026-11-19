const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const vm = require('node:vm');
const path = require('node:path');
const { buildSync } = require('../web/node_modules/esbuild');

const url = 'https://audio.example.test/track.mp3';
const code = buildSync({
  entryPoints: [path.join(__dirname, '../web/src/song-traffic.js')],
  bundle: true, globalName: 'moduleExports', format: 'iife', write: false,
}).outputFiles[0].text;
const sandbox = { URL, crypto: webcrypto, location: { href: 'https://app.example.test/app/' },
  setTimeout: () => 1, clearTimeout() {} };
vm.runInNewContext(code, sandbox);

class Media extends EventTarget {
  constructor() {
    super();
    this.duration = 100;
    this.currentSrc = url;
  }
  update(ranges) {
    this.buffered = { length: ranges.length, start: i => ranges[i][0], end: i => ranges[i][1] };
    this.dispatchEvent(new Event('progress'));
  }
}

(async () => {
  const reports = [];
  const tracker = sandbox.moduleExports.createSongTraffic(async (report, keepalive) => {
    reports.push({ ...report, keepalive });
  });
  const prefetched = new Media(), playing = new Media();
  const info = { size: 1000000 };
  tracker.attach(prefetched, info, url);
  prefetched.update([[0, 30]]);
  tracker.detach(prefetched);
  tracker.attach(playing, info, url);
  playing.update([[0, 15], [20, 45], [65, 70]]);
  tracker.flush();
  assert.equal(reports[0].bytes, 500000, 'overlap and prefetched data must count once');

  await new Promise(resolve => setImmediate(resolve));
  playing.update([[80, 100]]);
  tracker.flush(true);
  assert.equal(reports[1].session, reports[0].session);
  assert.equal(reports[1].bytes, 700000);
  assert.equal(reports[1].keepalive, true);
  await new Promise(resolve => setImmediate(resolve));

  playing.currentSrc = 'https://app.example.test/cm/cast/1?sig=abc';
  tracker.attach(playing, {}, playing.currentSrc);
  playing.update([[0, 100]]);
  tracker.flush();
  assert.equal(reports.length, 2, 'server relay bytes must not be reported as direct');
  console.log('Song traffic reporting tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
