/* Fire Pulse. Reads docs/data/firepulse.bin.gz (built by scripts/build_data.py) and draws the globe,
   the burning calendar and the checks. No build step: plain script, d3 + topojson from ./vendor.
   AI use: written with Claude (Anthropic), reviewed by the team. */
(async function(){
const $ = id => document.getElementById(id);
const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MON = MONTHS.map(m => m.slice(0,3));
const RAD = Math.PI/180;
const fmt = v => d3.format(',')(Math.round(v));
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const ordinal = n => { const s=['th','st','nd','rd'], v=n%100; return n + (s[(v-20)%10] || s[v] || s[0]); };
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- load ---------- */
let meta, cellId, kTA, kT, ctry, M, V, topo110;
try {
  const [bin, t110] = await Promise.all([
    fetch('data/firepulse.bin.gz').then(r => { if(!r.ok) throw new Error(r.status); return r.arrayBuffer(); }),
    fetch('vendor/countries-110m.json').then(r => r.json())
  ]);
  let bytes = new Uint8Array(bin);
  // some hosts send .gz files already decoded; only gunzip when the gzip magic number is still there
  if(bytes[0] === 0x1f && bytes[1] === 0x8b)
    bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const hl = new DataView(bytes.buffer).getUint32(0, true);
  meta = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + hl)));
  let off = 4 + hl;
  const take = (Type, n) => { const a = new Type(bytes.buffer, off, n); off += n*Type.BYTES_PER_ELEMENT; off += (-off & 3); return a; };
  const U0 = meta.units;
  cellId = take(Uint32Array, U0); kTA = take(Float32Array, U0); kT = take(Float32Array, U0); ctry = take(Uint16Array, U0);
  M = take(Uint16Array, U0*meta.months); V = take(Uint16Array, U0*meta.viirsMonths);
  topo110 = t110;
} catch(err){
  console.error(err); $('loading').hidden = true; $('loadErr').hidden = false; return;
}
$('loading').hidden = true;

const U = meta.units, T = meta.months, NV = meta.viirsMonths, V0 = meta.viirsStart, VFULL = meta.viirsFull, AQUA = meta.aquaStart;
const Y0 = meta.y0, NY = T/12, VIIRS_Y = V0/12, RES = meta.res, NCOL = meta.ncol, NROW = Math.round(180/RES);
const COUNTRIES = meta.countries, NC = COUNTRIES.length;

/* value of one grid unit in one month. Harmonized = everything in VIIRS-equivalent counts. */
function val(u, t, harm){
  if(t >= VFULL) return V[u*NV + t - V0];
  const m = M[u*T + t];
  return harm ? m*(t < AQUA ? kT[u] : kTA[u]) : m;
}

/* ---------- geometry of the grid units ---------- */
const lonD = new Float32Array(U), latD = new Float32Array(U), lam = new Float32Array(U), sp = new Float32Array(U), cp = new Float32Array(U);
const byCountry = Array.from({length:NC}, () => []), cellUnits = new Map();
for(let u=0;u<U;u++){
  const id = cellId[u], lat = (Math.floor(id/NCOL) + .5)*RES - 90, lon = (id % NCOL + .5)*RES - 180;
  lonD[u] = lon; latD[u] = lat; lam[u] = lon*RAD; sp[u] = Math.sin(lat*RAD); cp[u] = Math.cos(lat*RAD);
  byCountry[ctry[u]].push(u);
  const a = cellUnits.get(id); if(a) a.push(u); else cellUnits.set(id, [u]);
}
const allIdx = Int32Array.from({length:U}, (_, i) => i);

/* ---------- world shapes ---------- */
let feats = topojson.feature(topo110, topo110.objects.countries).features.filter(f => f.geometry);
feats.forEach(f => { f._b = d3.geoBounds(f); });
let world = {type:'FeatureCollection', features:feats}, world50 = null, feat50 = new Map();
function countryAt(lon, lat){
  for(let i=0;i<feats.length;i++){
    const b = feats[i]._b;
    if(lat < b[0][1] || lat > b[1][1]) continue;
    if(b[0][0] <= b[1][0] ? (lon < b[0][0] || lon > b[1][0]) : (lon < b[0][0] && lon > b[1][0])) continue;
    if(d3.geoContains(feats[i], [lon, lat])) return i;
  }
  return -1;
}
// FIRMS tags every hot spot with a country name; the map has its own names. Link the two by where the
// cells actually are (majority vote), so no hand-kept name table is needed.
const featOf = new Int16Array(NC).fill(-1), firmsOf = new Map();
for(let c=0;c<NC;c++){
  const us = byCountry[c], step = Math.max(1, Math.floor(us.length/25)), tally = new Map();
  for(let i=0;i<us.length;i+=step){ const f = countryAt(lonD[us[i]], latD[us[i]]); if(f >= 0) tally.set(f, (tally.get(f) || 0) + 1); }
  let best = -1, bn = 0; tally.forEach((n, f) => { if(n > bn){ bn = n; best = f; } });
  featOf[c] = best;
  if(best >= 0 && (!firmsOf.has(best) || us.length > byCountry[firmsOf.get(best)].length)) firmsOf.set(best, c);
}
fetch('vendor/countries-50m.json').then(r => r.json()).then(t => {   // sharper borders once zoomed in
  const f = topojson.feature(t, t.objects.countries).features.filter(x => x.geometry);
  world50 = {type:'FeatureCollection', features:f}; f.forEach(x => feat50.set(x.properties.name, x)); dirty = true;
}).catch(() => {});

/* ---------- colour ---------- */
const C = {};
['bg','ocean','land','land-line','accent','fg','muted','surface','surface-2','fire-lo','fire-mid','fire-hi','cool','neutral','warm','line'].forEach(k => C[k] = cssv('--'+k));
const LUTN = 64;
const lutOf = stops => { const f = d3.interpolateRgbBasis(stops); return d3.range(LUTN).map(i => f(i/(LUTN-1))); };
const seqLUT = lutOf([C['fire-lo'], C['fire-mid'], C['fire-hi']]);
const divLUT = lutOf([C.cool, C.neutral, C.warm]);
const lut = (L, u) => L[clamp(Math.round(u*(LUTN-1)), 0, LUTN-1)];
const anomU = ratio => clamp((Math.log2(ratio) + 2)/4, 0, 1);       // 1/4x .. 4x across the diverging ramp
// brightness scale for the globe: the 99.5th percentile of non-empty VIIRS cell-months
const VMAX = (() => { const s = []; for(let i=0;i<V.length;i+=53) if(V[i]) s.push(V[i]); s.sort((a,b) => a-b); return s[Math.floor(s.length*.995)] || 100; })();

/* ---------- state ---------- */
const state = {t:T-1, harm:true, view:'count', sel:{kind:'world', name:'Earth', idx:allIdx}};
let S = null, ser = null;   // S: the series on screen. ser: {mRaw, mConv, vi} for the selection

// median of each calendar month per unit, for the "how unusual" globe. Built on demand, 65k short sorts.
const medCache = new Map();
function cellMedians(mo, harm){
  const key = mo + (harm ? 'h' : 'r'); let a = medCache.get(key); if(a) return a;
  a = new Float32Array(U); const tmp = new Float64Array(NY);
  for(let u=0;u<U;u++){ for(let y=0;y<NY;y++) tmp[y] = val(u, y*12+mo, harm); tmp.sort(); a[u] = (tmp[(NY-1)>>1] + tmp[NY>>1])/2; }
  medCache.set(key, a); return a;
}

/* ---------- globe ---------- */
const cv = $('cv'), ctx = cv.getContext('2d'), wrap = $('globe');
const projection = d3.geoOrthographic().clipAngle(90).precision(0.6).rotate([100, -20]);
const path = d3.geoPath(projection, ctx);
const graticule = d3.geoGraticule10();
let W = 0, H = 0, dpr = 1, S0 = 100, zoom = 1, dirty = true, spin = !reduced, fly = null, dragging = null, drawMode = false, drawRect = null;
const stars = d3.range(170).map(() => [Math.random(), Math.random(), 0.4 + Math.random()*1.1, 0.25 + Math.random()*0.6]);
const sx = new Float32Array(U), sy = new Float32Array(U), sr = new Float32Array(U), sv = new Float32Array(U).fill(-1);
const sb = new Uint8Array(U), drawn = new Int32Array(U); let nDrawn = 0;
const NB = 12;

function resize(){
  W = wrap.clientWidth; H = wrap.clientHeight; if(!W || !H) return;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(W*dpr); cv.height = Math.round(H*dpr);
  S0 = Math.min(W, H)*0.42;
  projection.translate([W/2, H/2]).scale(S0*zoom);
  draw(); dirty = false;   // resizing clears the canvas, so repaint now instead of waiting for the next frame
}
new ResizeObserver(resize).observe(wrap);

function selOutline(){
  const s = state.sel;
  if(s.kind === 'box') return d3.geoGraticule().extentMajor([[s.box.w, s.box.s], [s.box.e, s.box.n]]).outline();
  if(s.kind === 'country' && featOf[s.c] >= 0){ const f = feats[featOf[s.c]]; return (zoom > 1.8 && feat50.get(f.properties.name)) || f; }
  return null;
}

function draw(){
  if(!W) return;
  const k = projection.scale(), cx = W/2, cy = H/2;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.fg;
  for(const s of stars){ ctx.globalAlpha = s[3]; ctx.fillRect(s[0]*W, s[1]*H, s[2], s[2]); }
  ctx.globalAlpha = 1;
  let g = ctx.createRadialGradient(cx, cy, k*0.96, cx, cy, k*1.16);           // atmosphere
  g.addColorStop(0, 'rgba(120,180,255,.38)'); g.addColorStop(1, 'rgba(120,180,255,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, k*1.16, 0, 7); ctx.fill();
  ctx.beginPath(); path({type:'Sphere'}); ctx.fillStyle = C.ocean; ctx.fill();
  ctx.beginPath(); path(graticule); ctx.strokeStyle = C.line; ctx.globalAlpha = .35; ctx.lineWidth = .5; ctx.stroke(); ctx.globalAlpha = 1;
  ctx.beginPath(); path(zoom > 1.8 && world50 && !fly ? world50 : world); ctx.fillStyle = C.land; ctx.fill(); ctx.strokeStyle = C['land-line']; ctx.lineWidth = .6; ctx.stroke();
  const out = selOutline();
  if(out){ ctx.beginPath(); path(out); ctx.fillStyle = 'rgba(143,201,255,.06)'; ctx.fill(); ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5; ctx.stroke(); }
  g = ctx.createRadialGradient(cx - k*.3, cy - k*.3, k*.2, cx, cy, k);         // shading toward the limb
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.5)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, k, 0, 7); ctx.fill();

  // fire cells: project the visible ones, sort them into colour buckets, fill each bucket in one go
  for(let i=0;i<nDrawn;i++) sv[drawn[i]] = -1;
  nDrawn = 0;
  const rot = projection.rotate(), l0 = -rot[0]*RAD, p0 = -rot[1]*RAD, sp0 = Math.sin(p0), cp0 = Math.cos(p0);
  const zs = 0.75 + 0.3*(k/S0), t = state.t, harm = state.harm, count = state.view === 'count';
  const med = count ? null : cellMedians(t % 12, harm);
  const xmin = -8, xmax = W + 8, ymin = -8, ymax = H + 8;
  for(let u=0;u<U;u++){
    const v = val(u, t, harm);
    if(count ? v < 1 : (v < 3 && med[u] < 3)) continue;
    const dl = lam[u] - l0, cdl = Math.cos(dl), cosc = sp0*sp[u] + cp0*cp[u]*cdl;
    if(cosc < 0.04) continue;
    const x = cx + k*cp[u]*Math.sin(dl), y = cy - k*(cp0*sp[u] - sp0*cp[u]*cdl);
    if(x < xmin || x > xmax || y < ymin || y > ymax) continue;
    if(count){
      const q = Math.sqrt(Math.min(1, v/VMAX));
      sb[u] = Math.min(NB-1, Math.floor(q*NB)); sr[u] = (0.7 + 2.5*q)*zs; sv[u] = v;
    } else {
      const ratio = (v + 1)/(med[u] + 1), w = Math.sqrt(Math.min(1, Math.max(v, med[u])/VMAX));
      sb[u] = Math.min(NB-1, Math.floor(anomU(ratio)*NB)); sr[u] = (1.1 + 2.6*w)*zs; sv[u] = ratio;
    }
    sx[u] = x; sy[u] = y; drawn[nDrawn++] = u;
  }
  ctx.globalCompositeOperation = count ? 'lighter' : 'source-over';
  for(let b=0;b<NB;b++){
    const q = (b + .5)/NB;
    ctx.fillStyle = count ? lut(seqLUT, 0.2 + 0.7*q) : lut(divLUT, q);
    if(count){   // soft halo first
      ctx.globalAlpha = (0.3 + 0.7*q)*0.1; ctx.beginPath();
      for(let i=0;i<nDrawn;i++){ const u = drawn[i]; if(sb[u] !== b) continue; const r = sr[u]*2.2; ctx.moveTo(sx[u] + r, sy[u]); ctx.arc(sx[u], sy[u], r, 0, 7); }
      ctx.fill();
    }
    ctx.globalAlpha = count ? 0.3 + 0.45*q : 0.8; ctx.beginPath();
    for(let i=0;i<nDrawn;i++){ const u = drawn[i]; if(sb[u] !== b) continue; const r = sr[u]; ctx.moveTo(sx[u] + r, sy[u]); ctx.arc(sx[u], sy[u], r, 0, 7); }
    ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  if(drawRect){
    ctx.setLineDash([5, 4]); ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5;
    ctx.strokeRect(drawRect.x0, drawRect.y0, drawRect.x1 - drawRect.x0, drawRect.y1 - drawRect.y0); ctx.setLineDash([]);
  }
}

function flyTo(lon, lat, k1){
  const r = projection.rotate();
  if(reduced){ projection.rotate([lon, lat]); zoom = k1; projection.scale(S0*zoom); dirty = true; return; }
  fly = {t0:performance.now(), dur:1500, l0:r[0], dl:((lon - r[0] + 540) % 360) - 180, p0:r[1], p1:lat, k0:zoom, k1};
}
// centre and angular radius of a set of units, to frame them on the globe
function frame(idx){
  let X = 0, Y = 0, Z = 0;
  for(const u of idx){ X += cp[u]*Math.cos(lam[u]); Y += cp[u]*Math.sin(lam[u]); Z += sp[u]; }
  const n = Math.hypot(X, Y, Z) || 1; X /= n; Y /= n; Z /= n;
  let minDot = 1;
  for(const u of idx){ const d = X*cp[u]*Math.cos(lam[u]) + Y*cp[u]*Math.sin(lam[u]) + Z*sp[u]; if(d < minDot) minDot = d; }
  return {lon:Math.atan2(Y, X)/RAD, lat:Math.asin(Z)/RAD, rad:Math.acos(clamp(minDot, -1, 1))};
}

let last = 0, playing = false, playAcc = 0;
function tick(now){
  const dt = Math.min(100, now - last); last = now;
  if(fly){
    const u = Math.min(1, (now - fly.t0)/fly.dur), e = d3.easeCubicInOut(u);
    projection.rotate([fly.l0 + fly.dl*e, fly.p0 + (fly.p1 - fly.p0)*e]);
    zoom = fly.k0 * Math.pow(fly.k1/fly.k0, e); projection.scale(S0*zoom);
    if(u >= 1) fly = null; dirty = true;
  } else if(spin && !dragging){
    const r = projection.rotate(); projection.rotate([r[0] + dt*0.004, r[1]]); dirty = true;
  }
  if(playing){ playAcc += dt; if(playAcc > 110){ playAcc = 0; if(state.t >= T-1) setPlaying(false); else setT(state.t + 1); } }
  if(dirty){ draw(); dirty = false; }
  requestAnimationFrame(tick);
}

/* globe pointer: drag to spin, wheel to zoom, click to pick a country, hover for a reading, or draw a box */
const tip = $('tip');
function showTip(text, x, y){ tip.textContent = text; tip.hidden = false; tip.style.left = Math.min(x + 12, innerWidth - 250) + 'px'; tip.style.top = (y + 14) + 'px'; }
function local(e){ const b = cv.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; }
cv.addEventListener('pointerdown', e => {
  const [x, y] = local(e); const r = projection.rotate();
  cv.setPointerCapture(e.pointerId); tip.hidden = true;
  if(drawMode){ drawRect = {x0:x, y0:y, x1:x, y1:y}; spin = false; fly = null; return; }
  dragging = {x, y, l:r[0], p:r[1], moved:false}; cv.classList.add('dragging');
});
cv.addEventListener('pointermove', e => {
  const [x, y] = local(e);
  if(drawRect){ drawRect.x1 = x; drawRect.y1 = y; dirty = true; return; }
  if(dragging){
    const dx = x - dragging.x, dy = y - dragging.y;
    if(Math.abs(dx) + Math.abs(dy) > 4){ dragging.moved = true; spin = false; fly = null; }
    if(dragging.moved){ const s = 57.3/projection.scale(); projection.rotate([dragging.l + dx*s, clamp(dragging.p - dy*s, -80, 80)]); dirty = true; }
    return;
  }
  let best = -1, bd = 100;
  for(let i=0;i<nDrawn;i++){ const u = drawn[i], d = (sx[u]-x)**2 + (sy[u]-y)**2; if(d < bd){ bd = d; best = u; } }
  if(best < 0){ tip.hidden = true; return; }
  const name = COUNTRIES[ctry[best]], m = MONTHS[state.t % 12], yr = Y0 + ((state.t/12)|0);
  showTip(state.view === 'count' ? `${name}\n${fmt(sv[best])} hot spots in this ${RES}° cell, ${MON[state.t % 12]} ${yr}`
                                 : `${name}\n${sv[best] >= 10 ? sv[best].toFixed(0) : sv[best].toFixed(1)}× this cell's normal ${m}`, e.clientX, e.clientY);
});
cv.addEventListener('pointerup', e => {
  const [x, y] = local(e);
  if(drawRect){ const r = drawRect; drawRect = null; setDrawMode(false); dirty = true; boxFromRect(r); return; }
  const d = dragging; dragging = null; cv.classList.remove('dragging');
  if(!d || d.moved) return;
  if((x - W/2)**2 + (y - H/2)**2 > projection.scale()**2) return;
  const ll = projection.invert([x, y]); if(!ll || isNaN(ll[0])) return;
  const f = countryAt(ll[0], ll[1]);
  const us = cellUnits.get(Math.min(NROW-1, Math.floor((ll[1] + 90)/RES))*NCOL + Math.min(NCOL-1, Math.floor((ll[0] + 180)/RES)));
  let c = -1;
  if(us) c = ctry[us.find(u => featOf[ctry[u]] === f) ?? us[0]];
  else if(f >= 0 && firmsOf.has(f)) c = firmsOf.get(f);
  if(c >= 0) selectCountry(c);
  else if(f >= 0) toast(`No vegetation-fire hot spots on record for ${feats[f].properties.name}.`);
});
cv.addEventListener('pointerleave', () => { tip.hidden = true; });
cv.addEventListener('wheel', e => {
  e.preventDefault(); fly = null; spin = false;
  zoom = clamp(zoom*Math.exp(-e.deltaY*0.0015), 0.8, 12); projection.scale(S0*zoom); dirty = true;
}, {passive:false});
document.addEventListener('pointermove', e => {
  if(e.target === cv) return;
  const el = e.target.closest && e.target.closest('[data-tip]');
  if(el) showTip(el.dataset.tip, e.clientX, e.clientY); else tip.hidden = true;
});

/* ---------- selection ---------- */
function computeSeries(idx){
  const mRaw = new Float64Array(T), mConv = new Float64Array(T), vi = new Float64Array(T).fill(NaN, 0, V0);
  for(const u of idx){
    const mo = u*T, vo = u*NV, a = kT[u], b = kTA[u];
    for(let t=0;t<AQUA;t++){ const m = M[mo+t]; mRaw[t] += m; mConv[t] += a*m; }
    for(let t=AQUA;t<T;t++){ const m = M[mo+t]; mRaw[t] += m; mConv[t] += b*m; }
    for(let j=0;j<NV;j++) vi[V0+j] += V[vo+j];
  }
  return {mRaw, mConv, vi};
}
function select(sel, where){
  state.sel = sel; ser = computeSeries(sel.idx); spin = false;
  if(where) flyTo(-where.lon, clamp(-where.lat, -75, 75), clamp(0.85/Math.sin(clamp(where.rad, 1.5*RAD, 60*RAD)), 1.2, 10));
  renderStatic(); renderTime();
}
function selectCountry(c){
  $('q').value = COUNTRIES[c]; toast('');
  const idx = Int32Array.from(byCountry[c]);
  select({kind:'country', name:COUNTRIES[c], c, idx}, frame(idx));
}
function selectBox(box, name){
  const w = box.w, e = box.e;
  const idx = allIdx.filter(u => latD[u] >= box.s && latD[u] <= box.n && (w <= e ? lonD[u] >= w && lonD[u] <= e : lonD[u] >= w || lonD[u] <= e));
  $('bN').value = box.n; $('bS').value = box.s; $('bW').value = box.w; $('bE').value = box.e; $('q').value = '';
  const span = ((e - w + 360) % 360) || 360;
  const where = {lon:w + span/2, lat:(box.s + box.n)/2, rad:Math.hypot(span*Math.cos((box.s + box.n)/2*RAD), box.n - box.s)/2*RAD};
  toast(idx.length ? '' : 'No hot spots on record inside that box.');
  select({kind:'box', name:name || `${Math.abs(box.s)}°${box.s < 0 ? 'S' : 'N'} to ${Math.abs(box.n)}°${box.n < 0 ? 'S' : 'N'}, ${Math.abs(box.w)}°${box.w < 0 ? 'W' : 'E'} to ${Math.abs(box.e)}°${box.e < 0 ? 'W' : 'E'}`, box, idx}, where);
}
function clearPlace(){
  $('q').value = ''; toast('');
  state.sel = {kind:'world', name:'Earth', idx:allIdx}; ser = computeSeries(allIdx);
  flyTo(projection.rotate()[0], -20, 1); spin = !reduced;
  renderStatic(); renderTime();
}
function setDrawMode(on){
  drawMode = on; cv.classList.toggle('drawing', on); $('boxDraw').setAttribute('aria-pressed', on);
  $('howto').textContent = on ? 'Drag a rectangle over the area you want.' : 'Drag to spin. Scroll to zoom. Click a country to fly in.';
}
function boxFromRect(r){
  const x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1), y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1);
  if(x1 - x0 < 6 || y1 - y0 < 6) return;
  const k2 = projection.scale()**2, pts = [];
  for(let i=0;i<=8;i++) for(let j=0;j<=8;j++){
    const x = x0 + (x1 - x0)*i/8, y = y0 + (y1 - y0)*j/8;
    if((x - W/2)**2 + (y - H/2)**2 >= k2) continue;
    const ll = projection.invert([x, y]); if(ll && !isNaN(ll[0])) pts.push(ll);
  }
  if(pts.length < 4){ toast('Draw the rectangle over the globe itself.'); return; }
  const c0 = pts[(pts.length/2)|0][0], rel = pts.map(p => ((p[0] - c0 + 540) % 360) - 180), snap = v => Math.round(v/RES)*RES;
  const wrapLon = v => ((v + 540) % 360) - 180;
  selectBox({s:snap(d3.min(pts, p => p[1])), n:snap(d3.max(pts, p => p[1])), w:wrapLon(snap(c0 + d3.min(rel))), e:wrapLon(snap(c0 + d3.max(rel)))});
}

/* ---------- panel ---------- */
const cal = $('cal'), calCells = [], calBars = [], calRows = [], calColor = new Array(T).fill('');
(function buildCalendar(){
  const head = document.createElement('div'); head.className = 'cal-row head';
  head.innerHTML = '<span></span>' + MON.map(m => `<span>${m[0]}</span>`).join('') + '<span>Year</span>';
  cal.appendChild(head);
  for(let y=0;y<NY;y++){
    if(y === VIIRS_Y){ const e = document.createElement('div'); e.className = 'era-mark'; e.textContent = `${Y0 + y}: the VIIRS sensor starts`; cal.appendChild(e); }
    const row = document.createElement('div'); row.className = 'cal-row';
    const lab = document.createElement('span'); lab.className = 'cal-y'; lab.textContent = Y0 + y; row.appendChild(lab);
    for(let m=0;m<12;m++){ const c = document.createElement('div'), t = y*12 + m; c.className = 'cell'; c.dataset.t = t; calCells[t] = c; row.appendChild(c); }
    const bar = document.createElement('div'); bar.className = 'cal-bar'; bar.appendChild(document.createElement('i')); row.appendChild(bar);
    calBars[y] = bar; calRows[y] = row; cal.appendChild(row);
  }
  cal.addEventListener('click', e => { const c = e.target.closest('.cell[data-t]'); if(c) setT(+c.dataset.t); });
  for(const id of ['yFrom','yTo']) for(let y=0;y<NY;y++) $(id).add(new Option(Y0 + y, y));
  $('yTo').value = NY - 1;
  $('tRange').max = T - 1;
  $('eras').innerHTML = `<span class="era e1" style="flex:${VFULL}" data-tip="Terra from 2000, Aqua from July 2002. 1 km pixels.">MODIS only</span>`
    + `<span class="era e2" style="flex:${T - VFULL}" data-tip="Suomi NPP VIIRS, 375 m pixels, full months from February ${Y0 + VIIRS_Y}.">MODIS + VIIRS, from ${Y0 + VIIRS_Y}</span>`;
})();

const monthMed = new Float64Array(12);   // median of each calendar month for the selection, all years
function renderStatic(){
  const harm = state.harm, sel = state.sel, anom = state.view === 'anom';
  S = new Float64Array(T);
  for(let t=0;t<T;t++) S[t] = t >= VFULL ? ser.vi[t] : harm ? ser.mConv[t] : ser.mRaw[t];
  $('pKind').textContent = sel.kind === 'world' ? 'Whole planet' : sel.kind === 'country' ? 'Country' : 'Custom area';
  $('pName').textContent = sel.name;
  $('pSub').textContent = `Jan ${Y0} to Dec ${Y0 + NY - 1}. ` + (harm ? 'All years in VIIRS-equivalent counts.' : 'Raw counts, two sensors mixed.');
  $('rawNote').hidden = harm;
  $('wholeBtn').hidden = sel.kind === 'world';
  for(let m=0;m<12;m++) monthMed[m] = d3.median(d3.range(NY), y => S[y*12 + m]);
  const smax = d3.max(S) || 0, tot = d3.range(NY).map(y => d3.sum(S.subarray(y*12, y*12 + 12))), tmax = d3.max(tot) || 1;
  for(let t=0;t<T;t++){
    const v = S[t], md = monthMed[t % 12], label = `${MON[t%12]} ${Y0 + ((t/12)|0)}`;
    let col = '', txt = `${label}: ${fmt(v)} hot spots`;
    if(anom){
      if(v >= 3 || md >= 3){ const r = (v + 1)/(md + 1); col = lut(divLUT, anomU(r)); txt += `\n${r >= 10 ? r.toFixed(0) : r.toFixed(1)}× a typical ${MONTHS[t%12]} (${fmt(md)})`; }
    } else if(smax > 0 && v/smax > 0.0005) col = lut(seqLUT, Math.sqrt(v/smax));
    calColor[t] = col; calCells[t].style.background = col; calCells[t].dataset.tip = txt;
  }
  calBars.forEach((b, y) => { b.firstChild.style.width = (100*tot[y]/tmax) + '%'; b.dataset.tip = `${Y0+y}: ${fmt(tot[y])} hot spots`; });
  $('calUnit').textContent = anom ? 'each month against its own median' : 'hot spots per month';
  $('calRamp').className = 'ramp ' + (anom ? 'div' : 'seq');
  $('calLo').textContent = anom ? 'Below normal' : 'Fewer'; $('calHi').textContent = anom ? 'Above normal' : 'More';
  renderCheck(); renderRange();
}

let nowCell = null;
function renderTime(){
  const t = state.t, y = (t/12)|0, m = t%12, yr = Y0 + y;
  $('readout').textContent = `${MONTHS[m]} ${yr}`;
  $('tRange').value = t;
  $('sensorNow').textContent = (t < AQUA ? 'Seen by MODIS (Terra only)' : t < VFULL ? 'Seen by MODIS only' : 'Seen by MODIS and VIIRS') + (state.harm ? ', shown as VIIRS-equivalent' : ', shown as reported');
  if(nowCell) nowCell.classList.remove('now'); nowCell = calCells[t]; nowCell.classList.add('now');

  const cur = S[t], same = [], others = [];
  for(let yy=0;yy<NY;yy++){ same.push(S[yy*12 + m]); if(yy !== y) others.push(S[yy*12 + m]); }
  const typical = d3.median(others) || 0, icon = $('vIcon');
  if(!state.sel.idx.length){
    $('vBig').textContent = '–'; icon.textContent = ''; icon.className = 'v-icon';
    $('vStatus').textContent = 'No hot spots here'; $('vLine').textContent = 'Nothing on record in this area since 2001.'; $('vRank').textContent = '';
  } else if(typical < 5 && cur < 5){
    $('vBig').textContent = '–'; icon.textContent = '●'; icon.className = 'v-icon flat';
    $('vStatus').textContent = 'Off season'; $('vLine').textContent = `Hardly any burning in a normal ${MONTHS[m]} here.`; $('vRank').textContent = '';
  } else {
    const ratio = cur/Math.max(typical, 1);
    $('vBig').textContent = (ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1)) + '×';
    const st = ratio >= 1.25 ? ['▲','up','Above normal'] : ratio <= 0.8 ? ['▼','down','Below normal'] : ['●','flat','Near normal'];
    icon.textContent = st[0]; icon.className = 'v-icon ' + st[1]; $('vStatus').textContent = `${st[2]} for ${MONTHS[m]}`;
    $('vLine').textContent = `${fmt(cur)} hot spots. A typical ${MONTHS[m]} has ${fmt(typical)}.`;
    $('vRank').textContent = `${ordinal(1 + same.filter(v => v > cur).length)} highest of ${same.length} ${MONTHS[m]}s on record.`;
  }
  renderSeason(y);
  dirty = true;
}

const Wv = 360, L = 38, R = 10, Tp = 8, B = 20, iw = Wv - L - R, sfmt = d3.format('~s');
function renderSeason(y){
  const Hv = 132, ih = Hv - Tp - B, yr = Y0 + y, cur = [], md = [], q1 = [], q3 = [];
  for(let m=0;m<12;m++){
    const o = []; for(let yy=0;yy<NY;yy++) if(yy !== y) o.push(S[yy*12 + m]);
    o.sort(d3.ascending); md.push(d3.quantileSorted(o, .5) || 0); q1.push(d3.quantileSorted(o, .25) || 0); q3.push(d3.quantileSorted(o, .75) || 0);
    cur.push(S[y*12 + m]);
  }
  const sc = d3.scaleLinear().domain([0, Math.max(1, d3.max(q3), d3.max(cur))]).nice(3).range([Tp + ih, Tp]);
  const x = m => L + iw*m/11;
  const line = d3.line().x((d,i) => x(i)).y(d => sc(d)), area = d3.area().x((d,i) => x(i)).y0((d,i) => sc(q1[i])).y1((d,i) => sc(q3[i]));
  let h = `<svg viewBox="0 0 ${Wv} ${Hv}" role="img" aria-label="Hot spots by month in ${yr} against a typical year">`;
  sc.ticks(3).forEach(v => { h += `<line class="grid" x1="${L}" x2="${Wv-R}" y1="${sc(v)}" y2="${sc(v)}"/><text class="axis" x="${L-6}" y="${sc(v)+4}" text-anchor="end">${sfmt(v)}</text>`; });
  MON.forEach((mn, m) => { h += `<text class="axis" x="${x(m)}" y="${Hv-5}" text-anchor="middle">${mn[0]}</text>`; });
  h += `<path class="band" d="${area(md)}"/><path class="med" d="${line(md)}"/><path class="cur" d="${line(cur)}"/>`;
  h += `<circle class="dot" cx="${x(state.t % 12)}" cy="${sc(cur[state.t % 12])}" r="4.5"/>`;
  MON.forEach((mn, m) => { h += `<rect class="hit" x="${x(m)-iw/22}" y="${Tp}" width="${iw/11}" height="${ih}" data-tip="${mn} ${yr}: ${fmt(cur[m])}&#10;Typical: ${fmt(md[m])}"/>`; });
  $('season').innerHTML = h + '</svg>';
  $('seasonTitle').textContent = `${yr} against a typical year`;
  $('keyYear').textContent = yr;
}

// Sensor check: in the years both sensors flew, converted MODIS should land on top of VIIRS.
function renderCheck(){
  const Hv = 120, ih = Hv - Tp - B, y0 = VIIRS_Y + 1, n = NY - y0;
  const yearly = a => d3.range(y0, NY).map(y => d3.sum(a.subarray(y*12, y*12 + 12)));
  const vi = yearly(ser.vi), conv = yearly(ser.mConv), raw = yearly(ser.mRaw);
  const sc = d3.scaleLinear().domain([0, Math.max(1, d3.max(vi), d3.max(conv))]).nice(3).range([Tp + ih, Tp]);
  const x = i => L + iw*i/(n - 1), line = d3.line().x((d,i) => x(i)).y(d => sc(d));
  let h = `<svg viewBox="0 0 ${Wv} ${Hv}" role="img" aria-label="Yearly hot spots: VIIRS observed, MODIS converted and MODIS raw">`;
  sc.ticks(3).forEach(v => { h += `<line class="grid" x1="${L}" x2="${Wv-R}" y1="${sc(v)}" y2="${sc(v)}"/><text class="axis" x="${L-6}" y="${sc(v)+4}" text-anchor="end">${sfmt(v)}</text>`; });
  for(let i=0;i<n;i+=2) h += `<text class="axis" x="${x(i)}" y="${Hv-5}" text-anchor="middle">${String(Y0 + y0 + i).slice(2)}</text>`;
  h += `<path class="rawm" d="${line(raw)}"/><path class="cur" d="${line(vi)}"/><path class="conv" d="${line(conv)}"/>`;
  for(let i=0;i<n;i++) h += `<rect class="hit" x="${x(i)-iw/(2*(n-1))}" y="${Tp}" width="${iw/(n-1)}" height="${ih}" data-tip="${Y0+y0+i}&#10;VIIRS observed: ${fmt(vi[i])}&#10;MODIS converted: ${fmt(conv[i])}&#10;MODIS raw: ${fmt(raw[i])}"/>`;
  $('check').innerHTML = h + '</svg>';
  const errs = vi.map((v, i) => v >= 20 ? Math.abs(conv[i] - v)/v : NaN).filter(isFinite);
  $('checkLine').textContent = errs.length
    ? `Here, converted MODIS lands within ${Math.round(100*d3.median(errs))}% of VIIRS in a typical year. Raw MODIS counts ${(d3.sum(vi)/Math.max(1, d3.sum(raw))).toFixed(1)}× fewer.`
    : 'Too few hot spots here to compare the sensors.';
}

function yearRange(){ const a = +$('yFrom').value, b = +$('yTo').value; return [Math.min(a, b), Math.max(a, b)]; }
function renderRange(){ const [a, b] = yearRange(); calRows.forEach((r, y) => r.classList.toggle('out', y < a || y > b)); }

/* ---------- actions ---------- */
function setT(t){ state.t = clamp(t, 0, T-1); renderTime(); }
function setPlaying(p){
  if(p && state.t >= T-1) setT(0);
  playing = p; playAcc = 0; $('play').textContent = p ? '❚❚ Pause' : `▶ Play ${Y0}–${Y0 + NY - 1}`;
}
function setMode(harm){
  state.harm = harm; $('mHarm').setAttribute('aria-pressed', harm); $('mRaw').setAttribute('aria-pressed', !harm);
  renderStatic(); renderTime();
}
function setView(view){
  state.view = view; $('vCount').setAttribute('aria-pressed', view === 'count'); $('vAnom').setAttribute('aria-pressed', view === 'anom');
  const a = view === 'anom';
  $('legRamp').className = 'ramp ' + (a ? 'div' : 'seq');
  $('legLo').textContent = a ? 'Below normal' : 'Fewer hot spots'; $('legHi').textContent = a ? 'Above normal' : 'More';
  renderStatic(); dirty = true;
}
function toast(msg){ $('toast').textContent = msg; }
function save(blob, name){ const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
const slug = () => state.sel.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function downloadCsv(){
  const [a, b] = yearRange(), rows = ['area,year,month,harmonized_viirs_equivalent,source,modis_filtered,viirs_snpp_filtered,median_same_month,ratio_to_median'];
  const hs = computeSeriesShown(true), med = d3.range(12).map(m => d3.median(d3.range(NY), y => hs[y*12 + m]));
  for(let t=a*12; t<(b+1)*12; t++){
    const m = t % 12, src = t >= VFULL ? 'VIIRS observed' : t < AQUA ? 'MODIS Terra converted' : 'MODIS Terra+Aqua converted';
    rows.push([`"${state.sel.name}"`, Y0 + ((t/12)|0), m + 1, hs[t].toFixed(1), src, ser.mRaw[t], t >= V0 ? ser.vi[t] : '', med[m].toFixed(1), med[m] >= 1 ? (hs[t]/med[m]).toFixed(3) : ''].join(','));
  }
  save(new Blob([rows.join('\n') + '\n'], {type:'text/csv'}), `firepulse_${slug()}_${Y0+a}-${Y0+b}.csv`);
  toast(`Saved ${rows.length - 1} monthly rows. Single detections are in the FIRMS archive (see How it works).`);
}
function computeSeriesShown(harm){ const o = new Float64Array(T); for(let t=0;t<T;t++) o[t] = t >= VFULL ? ser.vi[t] : harm ? ser.mConv[t] : ser.mRaw[t]; return o; }

function downloadPng(){
  const [a, b] = yearRange(), n = b - a + 1, cw = 34, ch = 20, gx = 64, gy = 96, Wp = gx + 12*cw + 40, Hp = gy + n*ch + 64, sc = 2;
  const c = document.createElement('canvas'); c.width = Wp*sc; c.height = Hp*sc;
  const g = c.getContext('2d'); g.scale(sc, sc);
  g.fillStyle = C.bg; g.fillRect(0, 0, Wp, Hp);
  g.fillStyle = C.fg; g.font = '600 20px "Space Grotesk", system-ui, sans-serif'; g.fillText(`Burning calendar: ${state.sel.name}`, 24, 38);
  g.fillStyle = C.muted; g.font = '12px Inter, system-ui, sans-serif';
  g.fillText((state.view === 'anom' ? 'Each month against its own median. ' : 'Hot spots per month. ') + (state.harm ? 'MODIS + VIIRS harmonized to VIIRS-equivalent counts.' : 'Raw counts, two sensors mixed.'), 24, 58);
  g.textAlign = 'center'; MON.forEach((m, i) => g.fillText(m, gx + i*cw + cw/2, gy - 8));
  for(let y=a; y<=b; y++){
    const yy = gy + (y - a)*ch;
    g.textAlign = 'right'; g.fillStyle = C.muted; g.fillText(Y0 + y, gx - 10, yy + ch/2 + 4);
    for(let m=0;m<12;m++){ g.fillStyle = calColor[y*12 + m] || C['surface-2']; g.fillRect(gx + m*cw + 1, yy + 1, cw - 2, ch - 2); }
  }
  const ly = gy + n*ch + 22, anom = state.view === 'anom', grad = g.createLinearGradient(gx, 0, gx + 120, 0);
  (anom ? [C.cool, C.neutral, C.warm] : [C['fire-lo'], C['fire-mid'], C['fire-hi']]).forEach((col, i) => grad.addColorStop(i/2, col));
  g.fillStyle = grad; g.fillRect(gx, ly, 120, 8);
  g.fillStyle = C.muted; g.textAlign = 'right'; g.fillText(anom ? 'Below normal' : 'Fewer', gx - 8, ly + 8);
  g.textAlign = 'left'; g.fillText(anom ? 'Above normal' : 'More', gx + 128, ly + 8);
  g.fillText('Data: NASA FIRMS (MODIS C6.1, VIIRS S-NPP 375 m). Fire Pulse.', 24, Hp - 14);
  c.toBlob(blob => { save(blob, `firepulse_${slug()}_${Y0+a}-${Y0+b}.png`); toast('Saved the calendar as an image.'); });
}

function buildAbout(){
  const v = meta.validation, pick = `per cell, shrinkage ${meta.shrinkage}`;
  const tally = suffix => d3.sum(Object.entries(meta.rows), ([k, n]) => k.endsWith(suffix) ? n : 0);
  const read = tally('_rows'), kept = read - tally('_static') - tally('_lowconf'), x1 = n => n.toFixed(1);
  const row = (k, label) => `<tr class="${k === pick ? 'pick' : ''}"><td>${label}</td><td>${v[k].country_year[0]}%</td><td>${v[k].country_month[0]}%</td><td>${v[k].cell_year[0]}%</td></tr>`;
  $('aboutBody').innerHTML = `
  <h2>How Fire Pulse works</h2>
  <p>Satellites have logged fire hot spots since 2000, but the record is split. MODIS (Terra and Aqua, 1 km pixels) is the long series and is close to retirement. VIIRS (Suomi NPP, 375 m pixels) took over in 2012 and sees many small fires MODIS misses. Put side by side, the raw counts jump ${meta.step2012.raw}× across 2012 for no physical reason.</p>
  <h3>The method</h3>
  <ol>
    <li><b>Same fires only.</b> Keep detections flagged as presumed vegetation fire (drops gas flares, volcanoes, offshore). Drop MODIS confidence below ${meta.filters.modisMinConfidence}% and VIIRS "low" confidence.</li>
    <li><b>Same grid.</b> Count hot spots per month in ${RES}° cells (about 55 km), kept separate per country.</li>
    <li><b>Learn the exchange rate.</b> For the years both sensors flew (Feb 2012 to Dec ${Y0 + NY - 1}), compute for every cell how many VIIRS hot spots match one MODIS hot spot. Cells with little data lean on their country's rate, and countries on the global rate (${x1(meta.globalFactor.terraAqua)}×).</li>
    <li><b>Convert the past.</b> Multiply the MODIS-only years by that local rate. Before July 2002 only Terra was flying, so those months use a separate Terra-only rate (global ${x1(meta.globalFactor.terraOnly)}×).</li>
    <li><b>From 2012 on, use VIIRS as observed.</b> Every year is now in the same unit: VIIRS-equivalent hot spots.</li>
  </ol>
  <h3>Does it work?</h3>
  <p>After harmonizing, the step across 2012 is ${meta.step2012.harmonized}× instead of ${meta.step2012.raw}× (global mean of 2013–${Y0 + NY - 1} over 2003–2011). MODIS on its own, which flew the whole time, shows ${meta.step2012.modisOnly}×: the false jump is gone and the real, slightly declining trend is kept. As a blind test, rates were fitted on even years only and used to predict VIIRS in the odd years. Median error of the prediction:</p>
  <table><tr><th>Conversion</th><th>Country, per year</th><th>Country, per month</th><th>Cell, per year</th></tr>
    ${row('none (raw MODIS)', 'None (raw MODIS)')}${row('one global factor', 'One global rate')}${row('one factor per country', 'One rate per country')}${row(pick, 'One rate per cell (used)')}
  </table>
  <h3>What to keep in mind</h3>
  <ul>
    <li>A hot spot is a satellite pixel with a thermal anomaly, not one fire. A large fire is many hot spots.</li>
    <li>One fixed rate per cell cannot follow changes in fire size or season. Treat single cells with few hot spots as rough.</li>
    <li>Fires MODIS never saw cannot be recovered by multiplying. Places with only small burns are under-counted before 2012.</li>
    <li>Sensor outages show up as dips, for example VIIRS in late July and August 2022.</li>
    <li>The record ends in December ${Y0 + NY - 1}, the last complete yearly archive.</li>
  </ul>
  <h3>Data</h3>
  <p>NASA FIRMS country archives: MODIS Collection 6.1 and VIIRS S-NPP 375 m. ${fmt(read)} detections read, ${fmt(kept)} kept. Single detections for any area: <a href="https://firms.modaps.eosdis.nasa.gov/download/" target="_blank" rel="noopener">FIRMS archive download</a>. Built ${meta.generated}.</p>`;
}

$('mHarm').onclick = () => setMode(true); $('mRaw').onclick = () => setMode(false);
$('vCount').onclick = () => setView('count'); $('vAnom').onclick = () => setView('anom');
$('wholeBtn').onclick = clearPlace;
$('play').onclick = () => setPlaying(!playing);
$('tRange').addEventListener('input', e => { setPlaying(false); setT(+e.target.value); });
$('dlCsv').onclick = downloadCsv; $('dlPng').onclick = downloadPng;
$('yFrom').onchange = $('yTo').onchange = renderRange;
$('aboutBtn').onclick = () => $('about').showModal();
$('boxDraw').onclick = () => setDrawMode(!drawMode);
$('boxApply').onclick = () => {
  const b = {n:+$('bN').value, s:+$('bS').value, w:+$('bW').value, e:+$('bE').value};
  if(['bN','bS','bW','bE'].some(id => $(id).value === '') || !(b.n > b.s) || Math.abs(b.n) > 90 || Math.abs(b.s) > 90 || Math.abs(b.w) > 180 || Math.abs(b.e) > 180){
    toast('Enter four numbers, with North above South. Example: 31.8, 25.5, -109.1, -103.3.'); return;
  }
  selectBox(b);
};

const names = COUNTRIES.map((n, i) => [n, i]);
names.forEach(([n]) => $('places').appendChild(new Option(n)));
$('searchForm').addEventListener('submit', e => {
  e.preventDefault();
  const q = $('q').value.trim().toLowerCase(); if(!q) return;
  const hit = names.find(n => n[0].toLowerCase() === q) || names.find(n => n[0].toLowerCase().startsWith(q)) || names.find(n => n[0].toLowerCase().includes(q));
  if(hit) selectCountry(hit[1]); else toast(`No country matches "${$('q').value.trim()}".`);
});
const chip = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = label; b.onclick = fn; $('chips').appendChild(b); };
['Mexico','Brazil','Zambia','Indonesia','Australia','Canada'].forEach(n => { const hit = names.find(x => x[0] === n); if(hit) chip(n, () => selectCountry(hit[1])); });
chip('Chihuahua', () => { $('area').open = true; selectBox({n:32, s:25.5, w:-109, e:-103}, 'Chihuahua, Mexico (box)'); });

buildAbout();
ser = computeSeries(allIdx);
resize(); setPlaying(false); setView('count'); renderTime();
requestAnimationFrame(tick);
})();
