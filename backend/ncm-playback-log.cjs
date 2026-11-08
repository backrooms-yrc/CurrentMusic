const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const { cookie, id, kind, seconds, total } = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!cookie?.MUSIC_U || !Number.isSafeInteger(id) || id <= 0 ||
      !Number.isSafeInteger(seconds) || seconds <= 0 || !['plv', 'pld'].includes(kind)) {
    throw new Error('invalid playback log');
  }
  const ncbl = require(path.join(process.argv[2], 'util', 'ncbl.js'));
  const context = ncbl.extractContext(cookie);
  const song = { id, bitrate: 320, level: 'exhigh', time: total };
  const source = { id: String(id), type: 'track', name: 'list' };
  const data = kind === 'plv'
    ? ncbl.buildPlv(context, song, source)
    : ncbl.buildPld(context, song, source, seconds);
  const log = ncbl.buildRecords([{ time: Math.floor(Date.now() / 1000), action: '_' + kind, data }]);
  const receipt = await ncbl.doUpload(context, ncbl.buildMetaJson(context), log, ncbl.buildCookieStr(context),
    kind.toUpperCase());
  if (!receipt.success) throw new Error('playback log rejected');
}

main().catch(() => { process.exitCode = 1; });
