const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TIME = 7 * 24 * 60 * 60 * 1000;
const MAX_OFFSET = 60000;
const LRC_CLOCK = '(\\d{1,4}):(\\d{2})(?:[.:](\\d{1,3}))?';

function lrcMs(match) {
  return Number(match[1]) * 60000 + Number(match[2]) * 1000 + Number((match[3] || '').padEnd(3, '0'));
}

function validTime(value) {
  return Number.isFinite(value) && value >= 0 && value <= MAX_TIME;
}

function line(t, txt, words = [], extras = {}) {
  const timings = words.every(({ start, end, text }, index) =>
    validTime(start) && validTime(end) && end > start && start >= t &&
    typeof text === 'string' && (!index || start > words[index - 1].start));
  const timed = timings && words.length && words.map(word => word.text).join('') === txt;
  return { t, txt, ...extras, ...(timed ? { words, w: words.map(word => [word.start, word.text]) } : {}) };
}

function parseLrc(text) {
  const stamps = new RegExp('\\[' + LRC_CLOCK + '\\]', 'g');
  const markers = new RegExp('<' + LRC_CLOCK + '>', 'g');
  return text.split(/\r?\n/).flatMap(input => {
    const row = input.trimStart();
    const starts = Array.from(row.matchAll(stamps));
    if (!starts.length || starts[0].index !== 0) return [];
    let cursor = 0;
    const headers = starts.filter(stamp => {
      if (stamp.index !== cursor) return false;
      cursor += stamp[0].length;
      return true;
    });
    const body = row.slice(cursor);
    const tags = Array.from(body.matchAll(markers));
    const txt = body.replace(markers, '');
    return headers.map((stamp, i) => {
      const t = lrcMs(stamp);
      if (i || headers.length !== 1) return line(t, txt);
      const words = tags.slice(0, -1).flatMap((tag, index) => {
        const next = tags[index + 1];
        const word = body.slice(tag.index + tag[0].length, next.index);
        return word ? [{ start: lrcMs(tag), end: lrcMs(next), text: word }] : [];
      });
      return line(t, txt, words);
    });
  });
}

function parseTimedRows(text, extension) {
  const lyricXML = extension === 'qrc' && text.trim().startsWith('<') ? parseXML(text) : null;
  const source = lyricXML
    ? (lyricXML.querySelector('[LyricContent]')?.getAttribute('LyricContent') || '').replace(/\s+(?=\[\d+,\d+\])/g, '\n')
    : text;
  return source.split(/\r?\n/).flatMap(row => {
    const match = /^\[(\d+),(\d+)\](.*)$/.exec(row.trim());
    if (!match) return [];
    const [, start, duration, body] = match;
    const t = Number(start), end = t + Number(duration);
    const pattern = extension === 'yrc' ? /\((\d+),(\d+),\d+\)([^()]*)/g
      : extension === 'krc' ? /<(\d+),(\d+),\d+>([^<]*)/g
      : /([^()]*)\((\d+),(\d+)\)/g;
    const marker = extension === 'qrc' ? /\(\d+,\d+\)/g
      : extension === 'yrc' ? /\(\d+,\d+,\d+\)/g : /<\d+,\d+,\d+>/g;
    const words = Array.from(body.matchAll(pattern)).map(token => {
      const [position, size, word] = extension === 'qrc' ? [token[2], token[3], token[1]] : token.slice(1);
      const from = Number(position) + (extension === 'krc' ? t : 0);
      return { start: from, end: from + Number(size), text: word };
    }).filter(word => word.text);
    return [line(t, body.replace(marker, ''), words, { end })];
  });
}

function parseXML(text) {
  if (/<!DOCTYPE/i.test(text)) throw new Error('歌词 XML 不支持文档类型声明');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('歌词 XML 文件格式无效');
  return doc;
}

function clockMs(clock) {
  if (!clock) return NaN;
  const units = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(clock);
  if (units) return Math.round(Number(units[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[units[2]]);
  if (/^(?:\d+:)?\d{2}:\d{2}(?:\.\d+)?$/.test(clock)) {
    return Math.round(clock.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0) * 1000);
  }
  return NaN;
}

function parseTtml(text) {
  const doc = parseXML(text);
  const role = node => Array.from(node.attributes).find(attr => attr.localName === 'role')?.value;
  return Array.from(doc.getElementsByTagNameNS('*', 'p')).flatMap(row => {
    const t = clockMs(row.getAttribute('begin'));
    const end = clockMs(row.getAttribute('end'));
    const auxiliary = Array.from(row.getElementsByTagNameNS('*', 'span')).filter(node => /^(x-translation|x-roman)$/.test(role(node)));
    const trans = auxiliary.find(node => role(node) === 'x-translation')?.textContent;
    const roma = auxiliary.find(node => role(node) === 'x-roman')?.textContent;
    auxiliary.forEach(node => node.remove());
    const words = Array.from(row.querySelectorAll('[begin][end]')).filter(node => !node.querySelector('[begin][end]'))
      .map(node => ({ start: clockMs(node.getAttribute('begin')), end: clockMs(node.getAttribute('end')), text: node.textContent }));
    return [line(t, row.textContent.trim(), words, { end, trans, roma })];
  });
}

function parseVtt(text) {
  return text.split(/(?:\r?\n){2,}/).flatMap(block => {
    const rows = block.split(/\r?\n/);
    const index = rows.findIndex(row => row.includes(' --> '));
    if (index < 0 || /^(NOTE|STYLE|REGION)(?:\s|$)/.test(rows[0])) return [];
    const [begin, finish] = rows[index].trim().split(/\s+-->\s+/);
    const txt = rows.slice(index + 1).join(' ').replace(/<[^>]*>/g, '').trim();
    return [line(clockMs(begin), txt, [], { end: clockMs(finish?.split(/\s+/)[0]) })];
  });
}

function ms(value) { return typeof value === 'number' ? Math.round(value * 1000) : NaN; }

function parseFia(text) {
  const data = JSON.parse(text);
  if (data?.format !== 'folia-lyricdata' || data.version !== 1 || !Array.isArray(data.lyrics?.lines)) {
    throw new Error('不支持的 FIA 歌词文件');
  }
  const lines = data.lyrics.lines.map(row => {
    const alternate = role => Array.isArray(row.alternateTexts) ? row.alternateTexts.find(item => item?.role === role)?.text : '';
    const words = data.lyrics.isWordByWord && Array.isArray(row.words)
      ? row.words.map(word => ({ start: ms(word.startTime), end: ms(word.endTime), text: word.text })) : [];
    return line(ms(row.startTime), row.fullText, words, {
      end: ms(row.endTime),
      trans: row.translation || alternate('translation'),
      roma: row.romanization || alternate('romanization'),
    });
  });
  return { lines, offsetMs: lyricOffset(data.offsetMs) };
}

export function lyricOffset(input) {
  return Number.isFinite(input) ? Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, Math.round(input))) : 0;
}

export async function importLyricFile(file) {
  if (!file.size || file.size > MAX_BYTES) throw new Error('请选择不超过 2 MB 的歌词文件');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 107 && bytes[1] === 114 && bytes[2] === 99 && bytes[3] === 49) {
    throw new Error('当前支持明文 KRC，请先导出为明文歌词');
  }
  let text;
  if (bytes[0] === 255 && bytes[1] === 254) text = new TextDecoder('utf-16le').decode(bytes);
  else if (bytes[0] === 254 && bytes[1] === 255) text = new TextDecoder('utf-16be').decode(bytes);
  else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { text = new TextDecoder('gb18030').decode(bytes); }
  }
  const type = file.name.split('.').pop().toLowerCase();
  const parsers = { lrc: parseLrc, ttml: parseTtml, vtt: parseVtt, yrc: parseTimedRows, qrc: parseTimedRows, krc: parseTimedRows };
  const parse = Object.prototype.hasOwnProperty.call(parsers, type) && parsers[type];
  const parsed = type === 'fia' ? parseFia(text) : parse && { lines: parse(text, type) };
  if (!parsed) throw new Error('不支持此歌词文件格式');
  const lines = parsed.lines.filter(row => validTime(row.t) && typeof row.txt === 'string' && row.txt.trim())
    .sort((a, b) => a.t - b.t);
  if (!lines.length || lines.length > 20000) throw new Error('歌词中没有可用的时间轴，或歌词行过多');
  return {
    data: { lines, source: 'local:' + type, wordLevel: lines.some(row => row.w), instrumental: false },
    offsetMs: parsed.offsetMs ?? lyricOffset(Number(/\[offset:([+-]?\d+)\]/i.exec(text)?.[1] || 0)),
  };
}

export function shiftLyricRows(rows, offsetMs) {
  if (!offsetMs) return rows;
  const shift = time => Math.max(0, time + offsetMs);
  return rows.map(row => ({
    ...row, t: shift(row.t),
    end: validTime(row.end) ? shift(row.end) : row.end,
    w: row.w?.map(([start, text]) => [shift(start), text]),
    words: row.words?.map(word => ({ ...word, start: shift(word.start), end: shift(word.end) })),
  }));
}

function stamp(time) {
  const ms = Math.max(0, Math.round(time));
  const minutes = String(Math.floor(ms / 60000)).padStart(2, '0');
  const seconds = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return minutes + ':' + seconds + '.' + String(ms % 1000).padStart(3, '0');
}

function lyricsForExport(lines) {
  return lines.flatMap((row, i) => {
    if (!validTime(row.t) || typeof row.txt !== 'string' || !row.txt.trim()) return [];
    const words = row.wSynth || !Array.isArray(row.words) ? [] : row.words.filter(word =>
      validTime(word.start) && validTime(word.end) && word.end > word.start && typeof word.text === 'string');
    const matched = words.map(word => word.text).join('') === row.txt ? words : [];
    const next = lines[i + 1]?.t;
    const naturalEnd = validTime(row.end) && row.end > row.t ? row.end : validTime(next) ? next : 0;
    const end = Math.max(row.t + 1, naturalEnd, matched[matched.length - 1]?.end || 0);
    return [{ ...row, end, words: matched }];
  });
}

export function exportLyric(type, rows, song, offsetMs) {
  const lines = lyricsForExport(rows);
  if (!lines.length) throw new Error('没有可导出的歌词');
  const singleLine = value => value.replace(/[\r\n]+/g, ' ');
  if (type === 'lrc') {
    return lines.map(row => {
      const words = row.words;
      const content = words.length ? words.map((word, i) => {
        const start = i && words[i - 1].end === word.start ? '' : '<' + stamp(word.start) + '>';
        return start + singleLine(word.text) + '<' + stamp(word.end) + '>';
      }).join('') : singleLine(row.txt);
      return '[' + stamp(row.t) + ']' + content;
    }).join('\n') + '\n';
  }
  return JSON.stringify({
    format: 'folia-lyricdata', version: 1, offsetMs: lyricOffset(offsetMs),
    song: { key: 'netease:' + song.ncm_id, title: song.name, artist: song.artists, album: song.album, durationMs: song.duration },
    lyrics: {
      title: song.name, artist: song.artists, isWordByWord: lines.some(row => row.words.length),
      lines: lines.map(row => ({
        fullText: row.txt, startTime: row.t / 1000, endTime: row.end / 1000, translation: row.trans, romanization: row.roma,
        words: row.words.map(word => ({ text: word.text, startTime: word.start / 1000, endTime: word.end / 1000 })),
      })),
    },
  }) + '\n';
}
