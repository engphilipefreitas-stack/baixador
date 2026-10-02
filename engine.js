/* ============================================================
   Baixador de Aulas — motor HLS (roda 100% no navegador)
   - Lê playlists .m3u8 (master ou media)
   - Baixa segmentos fMP4 em paralelo, com nova tentativa
   - Junta a faixa de vídeo e a de áudio num único .mp4
     (MP4 fragmentado, sem recodificar — mesmo efeito do
     "ffmpeg -c copy" da versão do Terminal)
   Não lida com conteúdo criptografado/DRM: recusa e avisa.
   ============================================================ */
(function (root) {
  'use strict';

  class EngineError extends Error {
    constructor(code, detail, extra) {
      super(detail || code);
      this.code = code;
      this.detail = detail || '';
      Object.assign(this, extra || {});
    }
  }

  const sleep = (ms, signal) => new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new EngineError('ABORTED')); }, { once: true });
  });

  // ---------------------------------------------------------- rede
  async function fetchRaw(url, { range, signal } = {}) {
    const headers = {};
    if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
    let res;
    try {
      res = await fetch(url, { headers, signal, credentials: 'omit', cache: 'no-store' });
    } catch (e) {
      if (signal && signal.aborted) throw new EngineError('ABORTED');
      throw new EngineError('NETWORK', String(e && e.message || e), { url });
    }
    if (!res.ok) {
      const code = [401, 403, 404, 410].includes(res.status) ? 'HTTP_' + res.status : 'HTTP_OTHER';
      throw new EngineError(code, `HTTP ${res.status} ${res.statusText || ''}`.trim(), { status: res.status, url });
    }
    return res;
  }

  async function withRetry(fn, { signal, tries = 4 } = {}) {
    let last;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); } catch (e) {
        last = e;
        if (e.code === 'ABORTED') throw e;
        const retriable = e.code === 'NETWORK' || (e.code === 'HTTP_OTHER' && (e.status >= 500 || e.status === 429));
        if (!retriable || i === tries - 1) throw e;
        await sleep(800 * Math.pow(2, i), signal);
      }
    }
    throw last;
  }

  async function fetchText(url, opts) {
    return withRetry(async () => (await fetchRaw(url, opts)).text(), opts);
  }

  async function fetchBytes(url, opts) {
    return withRetry(async () => {
      const res = await fetchRaw(url, opts);
      let u8 = new Uint8Array(await res.arrayBuffer());
      // servidor ignorou o Range e mandou o arquivo inteiro
      if (opts && opts.range && res.status === 200 && u8.length > opts.range.length) {
        u8 = u8.subarray(opts.range.offset, opts.range.offset + opts.range.length);
      }
      return u8;
    }, opts);
  }

  // ---------------------------------------------------------- m3u8
  function parseAttrs(s) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
    return out;
  }

  function parseByteRange(s, prevEnd) {
    const [len, off] = s.split('@');
    const length = parseInt(len, 10);
    const offset = off !== undefined ? parseInt(off, 10) : (prevEnd || 0);
    return { length, offset };
  }

  function parsePlaylist(text, baseUrl) {
    if (!/^\uFEFF?#EXTM3U/.test(text.trim())) throw new EngineError('NOT_PLAYLIST', 'O conteúdo não começa com #EXTM3U');
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const abs = u => new URL(u, baseUrl).href;

    if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) {
      const variants = [], media = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith('#EXT-X-STREAM-INF:')) {
          const a = parseAttrs(l.slice(18));
          let j = i + 1;
          while (j < lines.length && lines[j].startsWith('#')) j++;
          if (lines[j]) {
            const [w, h] = (a.RESOLUTION || '0x0').split('x').map(Number);
            variants.push({ uri: abs(lines[j]), bandwidth: +a.BANDWIDTH || 0, width: w, height: h, audio: a.AUDIO || null, codecs: a.CODECS || '' });
          }
          i = j;
        } else if (l.startsWith('#EXT-X-MEDIA:')) {
          const a = parseAttrs(l.slice(13));
          media.push({ type: a.TYPE, group: a['GROUP-ID'], name: a.NAME, isDefault: a.DEFAULT === 'YES', uri: a.URI ? abs(a.URI) : null });
        }
      }
      return { kind: 'master', variants, media };
    }

    const segments = [];
    let map = null, dur = 0, pendingDur = null, pendingRange = null, prevEnd = {}, t = 0, endList = false;
    for (const l of lines) {
      if (l.startsWith('#EXT-X-KEY:')) {
        const a = parseAttrs(l.slice(11));
        if (a.METHOD && a.METHOD !== 'NONE') throw new EngineError('ENCRYPTED', 'METHOD=' + a.METHOD);
      } else if (l.startsWith('#EXT-X-MAP:')) {
        const a = parseAttrs(l.slice(11));
        map = { uri: abs(a.URI), range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
      } else if (l.startsWith('#EXTINF:')) {
        pendingDur = parseFloat(l.slice(8)) || 0;
      } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
        pendingRange = l.slice(17);
      } else if (l === '#EXT-X-ENDLIST') {
        endList = true;
      } else if (!l.startsWith('#')) {
        const uri = abs(l);
        let range = null;
        if (pendingRange) {
          range = parseByteRange(pendingRange, prevEnd[uri]);
          prevEnd[uri] = range.offset + range.length;
        }
        const d = pendingDur || 0;
        segments.push({ uri, range, start: t, duration: d });
        t += d; dur += d;
        pendingDur = null; pendingRange = null;
      }
    }
    if (!segments.length) throw new EngineError('NOT_PLAYLIST', 'Playlist sem segmentos');
    return { kind: 'media', segments, map, duration: dur, endList };
  }

  function pickVariant(master) {
    const v = [...master.variants].sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
    return v[0];
  }

  function pickAudio(master, group) {
    const list = master.media.filter(m => m.type === 'AUDIO' && m.uri && (!group || m.group === group));
    return list.find(m => m.isDefault) || list[0] || null;
  }

  // Resolve os dois links até chegar em playlists de mídia
  async function resolve(videoUrl, audioUrl, { signal, log = () => {} } = {}) {
    const notes = [];
    videoUrl = (videoUrl || '').trim();
    audioUrl = (audioUrl || '').trim();
    if (!videoUrl) throw new EngineError('EMPTY_VIDEO');

    let vText = await fetchText(videoUrl, { signal });
    let video = parsePlaylist(vText, videoUrl);
    let videoInfo = {};
    if (video.kind === 'master') {
      const best = pickVariant(video);
      if (!best) throw new EngineError('NOT_PLAYLIST', 'Master sem variantes');
      videoInfo = { width: best.width, height: best.height };
      notes.push(`Link master detectado: usando ${best.width}x${best.height}.`);
      if (!audioUrl) {
        const a = pickAudio(video, best.audio);
        if (a) { audioUrl = a.uri; notes.push('Áudio encontrado automaticamente no master.'); }
      }
      videoUrl = best.uri;
      video = parsePlaylist(await fetchText(videoUrl, { signal }), videoUrl);
    }

    let audio = null;
    if (audioUrl) {
      let a = parsePlaylist(await fetchText(audioUrl, { signal }), audioUrl);
      if (a.kind === 'master') {
        const m = pickAudio(a);
        if (!m) throw new EngineError('NO_AUDIO_TRACK', 'Master de áudio sem faixa de áudio');
        audioUrl = m.uri;
        a = parsePlaylist(await fetchText(audioUrl, { signal }), audioUrl);
      }
      audio = a;
    }
    notes.forEach(n => log(n));
    return { video, audio, videoUrl, audioUrl, videoInfo, notes };
  }

  // ---------------------------------------------------------- MP4
  const td = new TextDecoder('latin1');
  const typeOf = (u8, p) => td.decode(u8.subarray(p + 4, p + 8));
  const u32 = (u8, p) => ((u8[p] << 24) >>> 0) + (u8[p + 1] << 16) + (u8[p + 2] << 8) + u8[p + 3];
  const setU32 = (u8, p, v) => { u8[p] = (v >>> 24) & 255; u8[p + 1] = (v >>> 16) & 255; u8[p + 2] = (v >>> 8) & 255; u8[p + 3] = v & 255; };
  const u64 = (u8, p) => u32(u8, p) * 4294967296 + u32(u8, p + 4);
  const setU64 = (u8, p, v) => { setU32(u8, p, Math.floor(v / 4294967296)); setU32(u8, p + 4, v >>> 0); };

  function boxes(u8, start = 0, end = u8.length) {
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = u32(u8, p), hdr = 8;
      const type = typeOf(u8, p);
      if (size === 1) { size = u64(u8, p + 8); hdr = 16; }
      else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) throw new EngineError('BAD_MP4', `Caixa ${type} corrompida`);
      out.push({ type, start: p, size, hdr, end: p + size, data: u8.subarray(p, p + size) });
      p += size;
    }
    return out;
  }
  const kids = (b) => boxes(b.data, b.hdr, b.size);
  const find = (list, type) => list.find(b => b.type === type);
  const findPath = (b, path) => {
    let cur = b;
    for (const t of path) { cur = find(kids(cur), t); if (!cur) return null; }
    return cur;
  };

  function makeBox(type, parts) {
    const len = 8 + parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(len);
    setU32(out, 0, len);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let p = 8;
    for (const part of parts) { out.set(part, p); p += part.length; }
    return out;
  }

  const handlerOf = (trak) => {
    const h = findPath(trak, ['mdia', 'hdlr']);
    return h ? typeOf(h.data, 12) : '';
  };
  const tkhdIdOffset = (tkhd) => tkhd.data[8] === 1 ? 28 : 20;
  const trackIdOf = (trak) => { const t = find(kids(trak), 'tkhd'); return u32(t.data, tkhdIdOffset(t)); };
  const mvhdTimescale = (mvhd) => u32(mvhd.data, mvhd.data[8] === 1 ? 28 : 20);

  function readInit(u8, label) {
    if (u8[0] === 0x47) throw new EngineError('TS_FORMAT');
    const top = boxes(u8);
    const moov = find(top, 'moov');
    if (!moov) throw new EngineError('NO_INIT', `${label}: sem cabeçalho MP4 (moov)`);
    const mk = kids(moov);
    const traks = mk.filter(b => b.type === 'trak').map(t => ({ box: t, handler: handlerOf(t), id: trackIdOf(t) }));
    const mvex = find(mk, 'mvex');
    const trex = mvex ? kids(mvex).filter(b => b.type === 'trex') : [];
    return { ftyp: find(top, 'ftyp'), mvhd: find(mk, 'mvhd'), traks, trex };
  }

  function retargetTrak(trakBox, newId, fromScale, toScale) {
    const out = trakBox.data.slice();
    const view = { data: out, hdr: 8, size: out.length };
    const t = find(kids(view), 'tkhd');
    setU32(out, t.start + tkhdIdOffset(t), newId);
    if (fromScale && toScale && fromScale !== toScale) {
      const elst = findPath(view, ['edts', 'elst']);
      if (elst) {
        const e = find(kids(view), 'edts').start + elst.start; // posição absoluta do elst
        const v1 = out[e + 8] === 1;
        const n = u32(out, e + 12);
        for (let i = 0; i < n; i++) {
          const p = e + 16 + i * (v1 ? 20 : 12);
          if (v1) setU64(out, p, Math.round(u64(out, p) * toScale / fromScale));
          else setU32(out, p, Math.round(u32(out, p) * toScale / fromScale));
        }
      }
    }
    return out;
  }

  function retargetTrex(trex, newId) {
    if (!trex) {
      const b = new Uint8Array(32); setU32(b, 0, 32); b.set([116, 114, 101, 120], 4);
      setU32(b, 12, newId); setU32(b, 16, 1); return b;
    }
    const b = trex.data.slice(); setU32(b, 12, newId); return b;
  }

  // Monta ftyp+moov com faixa 1 = vídeo e faixa 2 = áudio
  function buildInit(vInitU8, aInitU8, durationSec) {
    let V = readInit(vInitU8, 'Vídeo');
    let A = aInitU8 ? readInit(aInitU8, 'Áudio') : null;
    let swapped = false;

    let vt = V.traks.find(t => t.handler === 'vide');
    let at = A ? A.traks.find(t => t.handler === 'soun') : null;
    if (A && !vt && !at && A.traks.some(t => t.handler === 'vide') && V.traks.some(t => t.handler === 'soun')) {
      [V, A] = [A, V]; swapped = true;
      vt = V.traks.find(t => t.handler === 'vide');
      at = A.traks.find(t => t.handler === 'soun');
    }
    if (!vt) throw new EngineError('NO_VIDEO_TRACK');
    if (A && !at) throw new EngineError('NO_AUDIO_TRACK');

    const scale = mvhdTimescale(V.mvhd);
    const mvhd = V.mvhd.data.slice();
    setU32(mvhd, mvhd.length - 4, A ? 3 : 2); // next_track_ID

    const mehdBody = new Uint8Array(12); mehdBody[0] = 1; setU64(mehdBody, 4, Math.round(durationSec * scale));
    const mehd = makeBox('mehd', [mehdBody]);

    const parts = [mvhd, retargetTrak(vt.box, 1)];
    const trexes = [mehd, retargetTrex(V.trex.find(x => u32(x.data, 12) === vt.id), 1)];
    if (A) {
      parts.push(retargetTrak(at.box, 2, mvhdTimescale(A.mvhd), scale));
      trexes.push(retargetTrex(A.trex.find(x => u32(x.data, 12) === at.id), 2));
    }
    parts.push(makeBox('mvex', trexes));
    const moov = makeBox('moov', parts);
    const ftyp = V.ftyp ? V.ftyp.data : makeBox('ftyp', [new Uint8Array([105, 115, 111, 109, 0, 0, 2, 0, 105, 115, 111, 109, 105, 115, 111, 54])]);

    const out = new Uint8Array(ftyp.length + moov.length);
    out.set(ftyp, 0); out.set(moov, ftyp.length);
    return { bytes: out, map: { v: vt.id, a: at ? at.id : null }, swapped };
  }

  // Ajusta moof/mdat de um segmento para a faixa de destino
  function rewriteSegment(u8, fromId, toId, seq) {
    if (u8[0] === 0x47) throw new EngineError('TS_FORMAT');
    const out = [];
    for (const b of boxes(u8)) {
      if (b.type === 'moof') {
        for (const k of kids(b)) {            // k.data compartilha memória com u8
          if (k.type === 'mfhd') setU32(k.data, 12, seq.next++);
          if (k.type === 'traf') {
            const tfhd = find(kids(k), 'tfhd');
            if (!tfhd) continue;
            const flags = u32(tfhd.data, 8) & 0xffffff;
            if (flags & 1) throw new EngineError('BAD_MP4', 'tfhd com base-data-offset absoluto');
            if (toId != null && (fromId == null || u32(tfhd.data, 12) === fromId)) setU32(tfhd.data, 12, toId);
          }
        }
        out.push(b.data);
      } else if (b.type === 'mdat') {
        out.push(b.data);
      }
      // styp, sidx, prft, emsg, ftyp, moov: descartados
    }
    return out;
  }

  // ---------------------------------------------------------- download
  async function download(job, { signal, sink, onProgress = () => {}, log = () => {}, concurrency = 6 } = {}) {
    onProgress({ phase: 'Lendo links', percent: 0 });
    const r = await resolve(job.video, job.audio, { signal, log });
    const { video, audio } = r;
    if (!audio) log('Sem link de áudio: o arquivo terá apenas o que vier no link de vídeo.');
    if (!video.endList) log('Aviso: playlist de vídeo sem #EXT-X-ENDLIST (pode estar incompleta).');

    const getInit = async (pl) => pl.map
      ? fetchBytes(pl.map.uri, { range: pl.map.range, signal })
      : fetchBytes(pl.segments[0].uri, { range: pl.segments[0].range, signal });

    onProgress({ phase: 'Preparando', percent: 0 });
    const duration = Math.max(video.duration, audio ? audio.duration : 0);
    const vInit = await getInit(video);
    const aInit = audio ? await getInit(audio) : null;

    let tracks;
    let initBytes;
    if (audio) {
      const init = buildInit(vInit, aInit, duration);
      initBytes = init.bytes;
      if (init.swapped) log('Os links estavam trocados (vídeo ↔ áudio). Corrigido automaticamente.');
      const vPl = init.swapped ? audio : video, aPl = init.swapped ? video : audio;
      tracks = [
        { pl: vPl, from: init.map.v, to: 1 },
        { pl: aPl, from: init.map.a, to: 2 },
      ];
    } else {
      const V = readInit(vInit, 'Vídeo');
      if (!V.traks.some(t => t.handler === 'soun')) log('Atenção: o link de vídeo não tem áudio.');
      initBytes = vInit.slice(0, find(boxes(vInit), 'moov').end);
      tracks = [{ pl: video, from: null, to: null }];
    }

    const plan = [];
    tracks.forEach((t, ti) => t.pl.segments.forEach(s => plan.push({ ...s, ti })));
    plan.sort((a, b) => (a.start - b.start) || (a.ti - b.ti));

    await sink.write(initBytes);
    const seq = { next: 1 };
    const t0 = Date.now();
    let bytes = initBytes.length, done = 0, media = 0;

    for (let i = 0; i < plan.length; i += concurrency) {
      if (signal && signal.aborted) throw new EngineError('ABORTED');
      const win = plan.slice(i, i + concurrency);
      const got = await Promise.all(win.map(s => fetchBytes(s.uri, { range: s.range, signal })));
      for (let k = 0; k < win.length; k++) {
        const t = tracks[win[k].ti];
        const parts = rewriteSegment(got[k], t.from, t.to, seq);
        for (const p of parts) { await sink.write(p); bytes += p.length; }
        done++;
        media = Math.max(media, win[k].start + win[k].duration);
      }
      const el = (Date.now() - t0) / 1000;
      const speed = bytes / Math.max(el, 0.5);
      const pct = done / plan.length;
      onProgress({
        phase: 'Baixando', percent: Math.min(99.5, pct * 100), done, total: plan.length,
        bytes, speed, mediaSec: Math.min(media, duration), durationSec: duration,
        etaSec: pct > 0.01 ? el * (1 - pct) / pct : null,
      });
    }
    onProgress({ phase: 'Finalizando', percent: 99.8, bytes, durationSec: duration });
    await sink.close();
    return { bytes, duration, segments: plan.length, notes: r.notes };
  }

  // Teste rápido: lê playlists e o cabeçalho de cada faixa
  async function probe(videoUrl, audioUrl, { signal } = {}) {
    const r = await resolve(videoUrl, audioUrl, { signal });
    const init = async (pl) => pl.map ? fetchBytes(pl.map.uri, { range: pl.map.range, signal }) : fetchBytes(pl.segments[0].uri, { range: pl.segments[0].range, signal });
    const vI = await init(r.video);
    const aI = r.audio ? await init(r.audio) : null;
    const built = aI ? buildInit(vI, aI, r.video.duration) : null;
    return {
      duration: Math.max(r.video.duration, r.audio ? r.audio.duration : 0),
      videoSegments: r.video.segments.length,
      audioSegments: r.audio ? r.audio.segments.length : 0,
      hasAudio: !!r.audio, swapped: built ? built.swapped : false,
      videoInfo: r.videoInfo, notes: r.notes,
    };
  }

  const api = { EngineError, parsePlaylist, resolve, buildInit, rewriteSegment, download, probe };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof self !== 'undefined' ? self : this);
