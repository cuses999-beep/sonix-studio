// ===== BeatCraft – Music Studio v2 =====
const PX = 50;      // pixels per second
const LEFT = 60;    // lane label width

const AC = window.AudioContext || window.webkitAudioContext;
const ctx = new AC();

let tracks = 3;
let clips = [];     // {id,name,artist,buffer,track,start,offset,duration,volume}
let selected = new Set();
let nextId = 1;
let playhead = 0, playing = false, playStartPos = 0, playStartCtx = 0, sources = [];
let lanes = [], playheadEl = null;

const $ = id => document.getElementById(id);
const timeline = $('timeline');

// ---------- helpers ----------
const fmt = t => {
  const m = Math.floor(t / 60), s = (t % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
};
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('show'), 2200);
}
const timelineEnd = () => clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
const trackEnd = t => clips.filter(c => c.track === t).reduce((m, c) => Math.max(m, c.start + c.duration), 0);
const clipLabel = c => c.artist ? `${c.artist} – ${c.name}` : c.name;

// ---------- lanes (unlimited tracks) ----------
function buildLanes() {
  timeline.innerHTML = '';
  lanes = [];
  for (let i = 0; i < tracks; i++) {
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.innerHTML = `<span class="lane-label">T${i + 1}</span>`;
    lane.addEventListener('pointerdown', e => {
      if (e.target === lane || e.target.classList.contains('lane-label')) {
        const r = timeline.getBoundingClientRect();
        setPlayhead((e.clientX - r.left - LEFT) / PX);
      }
    });
    lanes.push(lane);
    timeline.appendChild(lane);
  }
  playheadEl = document.createElement('div');
  playheadEl.id = 'playhead';
  timeline.appendChild(playheadEl);
}

// ---------- waveform ----------
const peakCache = new WeakMap();
function getPeaks(buf) {
  let p = peakCache.get(buf);
  if (p) return p;
  const data = buf.getChannelData(0);
  const bs = Math.max(1, Math.floor(buf.sampleRate / 100));
  p = new Float32Array(Math.floor(data.length / bs));
  for (let i = 0; i < p.length; i++) {
    let m = 0; const s = i * bs;
    for (let j = 0; j < bs; j++) { const v = Math.abs(data[s + j]); if (v > m) m = v; }
    p[i] = m;
  }
  peakCache.set(buf, p);
  return p;
}
function drawWave(cv, c) {
  const g = cv.getContext('2d'), peaks = getPeaks(c.buffer);
  const w = cv.width, h = cv.height;
  g.fillStyle = 'rgba(255,255,255,0.8)';
  for (let x = 0; x < w; x++) {
    const idx = Math.floor((c.offset + (x / w) * c.duration) * 100);
    const bh = Math.max(1, (peaks[idx] || 0) * h);
    g.fillRect(x, (h - bh) / 2, 1, bh);
  }
}

// ---------- render ----------
function render() {
  lanes.forEach(l => l.querySelectorAll('.clip').forEach(n => n.remove()));
  clips.forEach(c => {
    if (c.track >= lanes.length) c.track = lanes.length - 1;
    const el = document.createElement('div');
    el.className = 'clip' + (selected.has(c.id) ? ' sel' : '');
    const hue = (c.track * 57) % 360;
    el.style.background = `linear-gradient(135deg, hsl(${hue},70%,50%), hsl(${hue},70%,32%))`;
    const w = Math.max(10, Math.round(c.duration * PX));
    el.style.left = (LEFT + c.start * PX) + 'px';
    el.style.width = w + 'px';
    const cv = document.createElement('canvas');
    cv.className = 'wave';
    cv.width = Math.min(w, 1500); cv.height = 68;
    drawWave(cv, c);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = clipLabel(c);
    el.append(cv, name);
    bindClip(el, c);
    lanes[c.track].appendChild(el);
  });
  timeline.style.width = (LEFT + (Math.max(timelineEnd(), 60) + 20) * PX) + 'px';
  updatePlayhead();
  updateInfo();
}

function updateInfo() {
  const n = selected.size;
  $('selInfo').textContent = n ? `${n} clip selected` : 'Clip tap karke select karein';
  const first = clips.find(c => selected.has(c.id));
  if (first) $('volume').value = first.volume;
}

// ---------- select / drag ----------
function toggleSelect(id) {
  selected.has(id) ? selected.delete(id) : selected.add(id);
  render();
}
let drag = null;
function bindClip(el, c) {
  el.addEventListener('pointerdown', e => {
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    drag = { clip: c, x: e.clientX, y: e.clientY, orig: c.start, moved: false };
  });
  el.addEventListener('pointermove', e => {
    if (!drag || drag.clip !== c) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.hypot(dx, e.clientY - drag.y) > 6) drag.moved = true;
    if (drag.moved) {
      c.start = Math.max(0, drag.orig + dx / PX);
      el.style.left = (LEFT + c.start * PX) + 'px';
    }
  });
  const end = e => {
    if (!drag || drag.clip !== c) return;
    const d = drag; drag = null;
    if (!d.moved) { toggleSelect(c.id); return; }
    c.start = Math.round(c.start * 100) / 100;
    const idx = lanes.findIndex(l => {
      const r = l.getBoundingClientRect();
      return e.clientY >= r.top && e.clientY < r.bottom;
    });
    if (idx >= 0) c.track = idx;
    render();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

$('volume').addEventListener('input', e => {
  clips.forEach(c => { if (selected.has(c.id)) c.volume = +e.target.value; });
});

// ---------- playback ----------
function currentPos() {
  return playing ? playStartPos + (ctx.currentTime - playStartCtx) : playhead;
}
function updatePlayhead() {
  playheadEl.style.left = (LEFT + playhead * PX) + 'px';
  $('time').textContent = fmt(playhead);
}
function setPlayhead(t) {
  if (playing) stop(false);
  playhead = Math.max(0, t);
  updatePlayhead();
}
async function play() {
  if (playing) return;
  if (!clips.length) return toast('Pehle audio import karein');
  if (ctx.state === 'suspended') await ctx.resume();
  playing = true;
  playStartPos = playhead;
  playStartCtx = ctx.currentTime;
  sources = [];
  for (const c of clips) {
    const end = c.start + c.duration;
    if (end <= playhead) continue;
    const g = ctx.createGain();
    g.gain.value = c.volume;
    g.connect(ctx.destination);
    const s = ctx.createBufferSource();
    s.buffer = c.buffer;
    s.connect(g);
    if (playhead > c.start) {
      const into = playhead - c.start;
      s.start(ctx.currentTime, c.offset + into, c.duration - into);
    } else {
      s.start(ctx.currentTime + (c.start - playhead), c.offset, c.duration);
    }
    sources.push(s);
  }
  tick();
}
function tick() {
  if (!playing) return;
  playhead = currentPos();
  if (playhead >= timelineEnd()) return stop(true);
  updatePlayhead();
  requestAnimationFrame(tick);
}
function stop(toStart = false) {
  if (playing) playhead = currentPos();
  sources.forEach(s => { try { s.stop(); } catch (_) {} });
  sources = [];
  playing = false;
  if (toStart) playhead = 0;
  updatePlayhead();
}
$('btnPlay').onclick = () => (playing ? stop(false) : play());
$('btnStop').onclick = () => stop(true);

// ---------- import ----------
$('btnImport').onclick = () => $('fileInput').click();
$('fileInput').addEventListener('change', async e => {
  for (const f of e.target.files) {
    try {
      const buffer = await ctx.decodeAudioData(await f.arrayBuffer());
      let track = 0, best = Infinity;
      for (let t = 0; t < lanes.length; t++) {
        const en = trackEnd(t);
        if (en < best) { best = en; track = t; }
      }
      clips.push({
        id: nextId++, name: f.name.replace(/\.[^.]+$/, ''), artist: '',
        buffer, track, start: best, offset: 0, duration: buffer.duration, volume: 1
      });
    } catch (err) {
      toast(`${f.name} load nahi hua`);
    }
  }
  e.target.value = '';
  render();
  toast('Import ho gaya ✔');
});

// ---------- tracks ----------
$('btnTrack').onclick = () => {
  tracks++;
  buildLanes();
  render();
  toast(`Track ${tracks} add ho gaya`);
};

// ---------- edit name / artist ----------
$('btnEdit').onclick = () => {
  const c = clips.find(x => selected.has(x.id));
  if (!c) return toast('Pehle ek clip select karein');
  const title = prompt('Track ka naam:', c.name);
  if (title === null) return;
  const artist = prompt('Artist ka naam:', c.artist || '');
  if (artist === null) return;
  c.name = title.trim() || c.name;
  c.artist = artist.trim();
  render();
  toast('Save ho gaya ✔');
};

// ---------- split / delete ----------
$('btnSplit').onclick = () => {
  const t = playhead;
  const targets = clips.filter(c =>
    t > c.start + 0.01 && t < c.start + c.duration - 0.01 &&
    (selected.size === 0 || selected.has(c.id)));
  if (!targets.length) return toast('Playhead ko clip ke beech mein rakhein');
  for (const c of targets) {
    const cut = t - c.start;
    clips.push({ ...c, id: nextId++, start: t, offset: c.offset + cut, duration: c.duration - cut });
    c.duration = cut;
  }
  selected.clear(); render(); toast('Split ✂');
};
$('btnDelete').onclick = () => {
  if (!selected.size) return toast('Pehle clip select karein');
  clips = clips.filter(c => !selected.has(c.id));
  selected.clear(); render();
};

// ---------- offline mixing ----------
async function bounce(items, dur) {
  const off = new OfflineAudioContext(2, Math.max(1, Math.ceil(dur * ctx.sampleRate)), ctx.sampleRate);
  for (const it of items) {
    const g = off.createGain(); g.gain.value = it.volume; g.connect(off.destination);
    const s = off.createBufferSource(); s.buffer = it.buffer; s.connect(g);
    s.start(it.at, it.offset, it.duration);
  }
  return off.startRendering();
}
function replaceWithNew(buffer, start, track, name, artist) {
  clips = clips.filter(c => !selected.has(c.id));
  clips.push({ id: nextId++, name, artist, buffer, track, start, offset: 0, duration: buffer.duration, volume: 1 });
  selected.clear(); render(); toast(`${name} ho gaya ✔`);
}

// Overlay: sab selected clips ek saath mix
$('btnOverlay').onclick = async () => {
  const sel = clips.filter(c => selected.has(c.id));
  if (sel.length < 2) return toast('Overlay ke liye 2+ clips select karein');
  const base = Math.min(...sel.map(c => c.start));
  const dur = Math.max(...sel.map(c => c.start + c.duration)) - base;
  toast('Mixing...');
  const buf = await bounce(sel.map(c => ({
    buffer: c.buffer, offset: c.offset, duration: c.duration, volume: c.volume, at: c.start - base
  })), dur);
  replaceWithNew(buf, base, Math.min(...sel.map(c => c.track)), 'Overlay', sel[0].artist);
};

// Merge: ek ke baad ek jodo
$('btnMerge').onclick = async () => {
  const sel = clips.filter(c => selected.has(c.id)).sort((a, b) => a.start - b.start);
  if (sel.length < 2) return toast('Merge ke liye 2+ clips select karein');
  let pos = 0;
  const items = sel.map(c => {
    const it = { buffer: c.buffer, offset: c.offset, duration: c.duration, volume: c.volume, at: pos };
    pos += c.duration;
    return it;
  });
  toast('Merging...');
  const buf = await bounce(items, pos);
  replaceWithNew(buf, sel[0].start, sel[0].track, 'Merged', sel[0].artist);
};

// ---------- encoders ----------
function encodeWAV(buf) {
  const ch = buf.numberOfChannels, sr = buf.sampleRate, len = buf.length;
  const bytes = 44 + len * ch * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); view.setUint32(4, bytes - 8, true); w(8, 'WAVE');
  w(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, ch, true); view.setUint32(24, sr, true);
  view.setUint32(28, sr * ch * 2, true); view.setUint16(32, ch * 2, true);
  view.setUint16(34, 16, true); w(36, 'data'); view.setUint32(40, len * ch * 2, true);
  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      o += 2;
    }
  }
  return new Blob([view], { type: 'audio/wav' });
}

// ID3v1 tag (ASCII only, 128 bytes): artist + title ke liye
function id3v1(title, artist) {
  const t = new Uint8Array(128);
  const put = (s, off, len = 30) => {
    for (let i = 0; i < len && i < s.length; i++) {
      const c = s.charCodeAt(i); t[off + i] = c < 128 ? c : 63;
    }
  };
  put('TAG', 0, 3);
  put(title || '', 3);
  put(artist || '', 33);
  put('BeatCraft', 63);
  t[127] = 255;
  return t;
}

function encodeMP3(buf, title, artist) {
  const ch = Math.min(2, buf.numberOfChannels);
  const enc = new lamejs.Mp3Encoder(ch, buf.sampleRate, 128);
  const toI16 = f => {
    const o = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const s = Math.max(-1, Math.min(1, f[i]));
      o[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return o;
  };
  const L = toI16(buf.getChannelData(0));
  const R = ch > 1 ? toI16(buf.getChannelData(1)) : null;
  const parts = [], B = 1152;
  for (let i = 0; i < L.length; i += B) {
    const d = R ? enc.encodeBuffer(L.subarray(i, i + B), R.subarray(i, i + B))
                : enc.encodeBuffer(L.subarray(i, i + B));
    if (d.length) parts.push(new Uint8Array(d));
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  parts.push(id3v1(title, artist));
  return new Blob(parts, { type: 'audio/mpeg' });
}

// ---------- export ----------
async function exportMix(format) {
  if (!clips.length) return toast('Export ke liye kuch nahi hai');
  if (format === 'mp3' && typeof lamejs === 'undefined')
    return toast('MP3 library load nahi hui, internet check karein');

  const sel = clips.find(c => selected.has(c.id)) || clips[0];
  const title = prompt('Final file ka naam:', sel.name);
  if (title === null) return;
  const artist = prompt('Artist ka naam:', sel.artist || '');
  if (artist === null) return;

  toast('Export ho raha hai... ⏳');
  const items = clips.map(c => ({
    buffer: c.buffer, offset: c.offset, duration: c.duration, volume: c.volume, at: c.start
  }));
  const buf = await bounce(items, timelineEnd());
  const blob = format === 'mp3'
    ? encodeMP3(buf, title.trim(), artist.trim())
    : encodeWAV(buf);

  const base = (artist.trim() ? `${artist.trim()} - ${title.trim()}` : title.trim())
    .replace(/[\\/:*?"<>|]/g, '_') || 'beatcraft';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${base}.${format}`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  toast('Export ho gaya ✔');
}
$('btnMP3').onclick = () => exportMix('mp3');
$('btnWAV').onclick = () => exportMix('wav');

// ---------- start ----------
buildLanes();
render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
