/* Fire Pulse. The look and the globe come from the team's first prototype (fire-pulse). The numbers come
   from the API in app.py: fire detections adjusted to what Aqua MODIS would have reported, with tables tested on held-out years.
   No build step: plain script, d3 + topojson from ./vendor. */
(async function(){
const $ = id => document.getElementById(id);
const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MON = MONTHS.map(m => m.slice(0,3));
const RAD = Math.PI/180;
const fmt = v => v == null || isNaN(v) ? '–' : d3.format(',')(Math.round(v));
const pct = v => Math.round(100*v) + ' %';
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const ordinal = n => { const s=['th','st','nd','rd'], v=n%100; return n + (s[(v-20)%10] || s[v] || s[0]); };
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const api = (path, opts) => fetch(path, opts).then(r => r.ok ? r.json() : r.json().catch(() => ({})).then(e => {
  const x = new Error(typeof e.detail === 'string' ? e.detail : r.statusText || String(r.status)); x.status = r.status; throw x; }));

/* ---------- load ---------- */
let G, meta, VAL, cellId, ctry, Hm, Rw, Nt = null, topo110;
try {
  const [bin, t110, m, v] = await Promise.all([
    fetch('api/globe.bin').then(r => { if(!r.ok) throw new Error(r.status); return r.arrayBuffer(); }),
    fetch('vendor/countries-110m.json').then(r => r.json()), api('api/meta'), api('api/validation')]);
  let bytes = new Uint8Array(bin);
  if(bytes[0] === 0x1f && bytes[1] === 0x8b)   // gunzip unless the server already did
    bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const hl = new DataView(bytes.buffer).getUint32(0, true);
  G = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + hl)));
  let off = 4 + hl; off += (-off & 3);
  const take = (Type, n) => { const a = new Type(bytes.buffer, off, n); off += n*Type.BYTES_PER_ELEMENT; off += (-off & 3); return a; };
  cellId = take(Uint32Array, G.units); ctry = take(Uint16Array, G.units);
  const gr = {}; for(const k of (G.grids || ['harm', 'raw'])) gr[k] = take(Uint16Array, G.units*G.months);   // old files: no "grids" key
  Hm = gr.harm; Rw = gr.raw; Nt = gr.night || null;
  topo110 = t110; meta = m; VAL = v;
} catch(err){
  console.error(err); $('loading').hidden = true; $('loadErr').hidden = false; return;
}
$('loading').hidden = true;
// optional parts of the server; each one switches off quietly when its data or endpoint is missing
const HAS = {night:meta.night === true, states:meta.states === true, places:meta.places === true, live:!!meta.live, trust:meta.trust === true};

/* time: t = 0 is November 2000 */
const U = G.units, T = G.months, RES = G.res, NCOL = G.ncol, NROW = Math.round(180/RES), Y0 = 2000, M0 = 10;
const yearOf = t => Y0 + ((t + M0)/12 | 0), monOf = t => (t + M0) % 12, tOf = (y, m) => (y - Y0)*12 + m - M0;
const tAt = ym => tOf(+ym.slice(0,4), +ym.slice(5,7) - 1);
const ymOf = t => `${yearOf(t)}-${String(monOf(t) + 1).padStart(2, '0')}`;
const firstOf = mo => ((mo - M0) % 12 + 12) % 12;   // first t of a calendar month
const YEARS = d3.range(Y0, yearOf(T-1) + 1), AQUA = tAt(meta.aqua_start), MODEL = tAt(meta.model_start);
const PRIMARY = VAL.primary, PKEY = PRIMARY.toLowerCase(), SAT = VAL.satellites[PRIMARY];
const SENSOR = {terra:'MODIS Terra', aqua:'MODIS Aqua', n20:'VIIRS NOAA-20', snpp:'VIIRS Suomi NPP'};
const PLAIN = {terra:'Older satellite', aqua:'Reference satellite', snpp:'Newer satellite (first)', n20:'Newer satellite (second)'};
const COUNTRIES = G.countries, NC = COUNTRIES.length, NONE = 65535;
const dShort = d => { const x = new Date(d + 'T00:00:00Z'); return isNaN(x) ? String(d) : `${x.getUTCDate()} ${MON[x.getUTCMonth()]}`; };
const coord = (lon, lat) => `${Math.abs(lat).toFixed(2)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(2)}° ${lon < 0 ? 'W' : 'E'}`;

/* ---------- geometry of the grid cells ---------- */
const lonD = new Float32Array(U), latD = new Float32Array(U), lam = new Float32Array(U), sp = new Float32Array(U), cp = new Float32Array(U);
const byCountry = Array.from({length:NC}, () => []), cellUnit = new Map();
for(let u=0;u<U;u++){
  const id = cellId[u], lat = (Math.floor(id/NCOL) + .5)*RES - 90, lon = (id % NCOL + .5)*RES - 180;
  lonD[u] = lon; latD[u] = lat; lam[u] = lon*RAD; sp[u] = Math.sin(lat*RAD); cp[u] = Math.cos(lat*RAD);
  if(ctry[u] !== NONE) byCountry[ctry[u]].push(u);
  cellUnit.set(id, u);
}

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
// FIRMS names every detection's country; the map has its own names. Link the two by where the cells are.
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
  f.forEach(x => { x._b = d3.geoBounds(x); feat50.set(x.properties.name, x); });   // bounds once, for culling
  world50 = {type:'FeatureCollection', features:f}; baseVer++; dirty = true;
}).catch(() => {});

/* states and provinces: kept as plain rings, because the API's winding order is not what d3's sphere expects */
const ringsOf = g => !g ? [] : g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.flat() : [];
const stateMap = new Map(), ctryStates = new Map();
function addState(s){
  if(!s || !s.geometry || !s.bbox) return;
  const k = s.country + '|' + s.name; if(stateMap.has(k)) return;
  s._rings = ringsOf(s.geometry); s._ml = {type:'MultiLineString', coordinates:s._rings}; stateMap.set(k, s);
}
function inRings(rings, x, y){   // even-odd rule, so holes work
  let inside = false;
  for(const r of rings) for(let i=0, j=r.length-1; i<r.length; j=i++){
    const a = r[i], b = r[j];
    if((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0])*(y - a[1])/(b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function stateAt(lon, lat){
  for(const s of stateMap.values()){ const b = s.bbox; if(lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3] && inRings(s._rings, lon, lat)) return s; }
  return null;
}
const hits = (b, v) => b[0] <= v[2] && b[2] >= v[0] && b[1] <= v[3] && b[3] >= v[1];

/* ---------- colour ---------- */
const C = {};
['bg','ocean','land','land-line','accent','fg','muted','surface','surface-2','fire-lo','fire-mid','fire-hi','cool','neutral','warm','line'].forEach(k => C[k] = cssv('--'+k));
const LUTN = 64;
const lutOf = stops => { const f = d3.interpolateRgbBasis(stops); return d3.range(LUTN).map(i => f(i/(LUTN-1))); };
const seqLUT = lutOf([C['fire-lo'], C['fire-mid'], C['fire-hi']]);
const divLUT = lutOf([C.cool, C.neutral, C.warm]);
const lut = (L, u) => L[clamp(Math.round(u*(LUTN-1)), 0, LUTN-1)];
const anomU = ratio => clamp((Math.log2(ratio) + 2)/4, 0, 1);       // 1/4x .. 4x across the diverging ramp
// error classes, calm teal to bright yellow: lightness rises with the error, so "do not trust" stands out, also for colour-blind readers
const TRUST = [[0.15,'#2a8296','under 15 %'],[0.3,'#35b88a','15 to 30 %'],[0.5,'#94d34f','30 to 50 %'],[Infinity,'#ffe83a','over 50 %']];
const NOTEST = '#9aa3b2';   // "too few fires to test" is hatched, not a fifth lightness that could pass for a class
const PTC = [lut(seqLUT, .4), lut(seqLUT, .72), C['fire-hi']];     // weak, medium, strong detections
// brightness scale for the globe: the 99.5th percentile of non-empty adjusted cell-months
const VMAX = (() => { const s = []; for(let i=0;i<Hm.length;i+=53) if(Hm[i]) s.push(Hm[i]); s.sort((a,b) => a-b); return s[Math.floor(s.length*.995)] || 100; })();

/* ---------- state ---------- */
const state = {t:T-1, harm:true, view:'count', cal:'grid', live:false, ghost:false, time:'all', strong:false, pick:false, sel:{kind:'world', name:'Earth', id:0}};
let months = null, S = null, liveArea = null, lookList = null, lookAll = false, lookFrom = null, lastSeason = null, lastTiles = [];
const liveCells = new Map();
let viewPlaces = null, curVB = null, viewKey = '', wasFlat = false, statesOff = false, placesOff = false;
const placeCache = new Map(), stateCache = new Set();
const rawTotal = m => m.raw.terra + m.raw.aqua + m.raw.n20 + m.raw.snpp;
const gTime = () => state.harm && Nt ? state.time : 'all';                 // the globe can split day and night only with the third grid
const mParam = () => HAS.night && state.time !== 'all' ? {time:state.time} : {};   // monthly requests
const lParam = () => state.time !== 'all' ? {time:state.time} : {};                 // last-7-days requests
function reader(){
  if(!state.harm) return i => Rw[i];
  const tm = gTime();
  return tm === 'night' ? i => Nt[i] : tm === 'day' ? i => Math.max(0, Hm[i] - Nt[i]) : i => Hm[i];
}

// median of each calendar month per cell over the baseline years, for the "compared with normal" globe
const medCache = new Map(), BASE = d3.range(VAL.baseline[0], VAL.baseline[1] + 1);
function cellMedians(mo){
  const key = mo + (state.harm ? 'h' : 'r') + gTime(); let a = medCache.get(key); if(a) return a;
  a = new Float32Array(U); const n = BASE.length, tmp = new Float64Array(n), rd = reader();
  for(let u=0;u<U;u++){ for(let i=0;i<n;i++) tmp[i] = rd(u*T + tOf(BASE[i], mo)); tmp.sort(); a[u] = (tmp[(n-1)>>1] + tmp[n>>1])/2; }
  medCache.set(key, a); return a;
}

/* ---------- globe that turns into a flat map ----------
   alpha = 0 is the orthographic globe, alpha = 1 is a flat map centred on the place you flew to.
   It follows the zoom, so flying into a country flattens the map and zooming out restores the globe.
   Each frame has three layers: the base map, the fire layer, the drawing tools. The base map is kept in an offscreen
   canvas, because the sharp borders cost about 60 ms; while the map moves it is reused or replaced by the coarse borders. */
const cv = $('cv'), ctx = cv.getContext('2d'), wrap = $('globe');
const baseC = document.createElement('canvas'), bctx = baseC.getContext('2d');
let alpha = 0;
const isFlat = () => alpha > 0.9;
const blend = (l, p) => { const c = Math.cos(p); return [(1 - alpha)*c*Math.sin(l) + alpha*l, (1 - alpha)*Math.sin(p) + alpha*p]; };
blend.invert = (x, y) => {   // y depends on latitude only, so two 1-D Newton solves are enough
  let p = y; for(let i=0;i<8;i++) p -= ((1 - alpha)*Math.sin(p) + alpha*p - y)/((1 - alpha)*Math.cos(p) + alpha || 1e-9);
  const c = Math.cos(p); let l = x; for(let i=0;i<8;i++) l -= ((1 - alpha)*c*Math.sin(l) + alpha*l - x)/((1 - alpha)*c*Math.cos(l) + alpha || 1e-9);
  return [l, p];
};
const projection = d3.geoProjection(blend).clipAngle(90).precision(0.6).rotate([100, -20]);
const path = d3.geoPath(projection, ctx), bpath = d3.geoPath(projection, bctx);
const graticule = d3.geoGraticule10();
let W = 0, H = 0, dpr = 1, S0 = 100, zoom = 1, dirty = true, spin = !reduced, fly = null, dragging = null, drawMode = null, drawRect = null, poly = [];
let lastWheel = -1e9, lastMove = -1e9, wasMoving = false, pinch = null, noClick = false, baseVer = 0, baseSig = '', baseView = null, baseMode = '', fireLevel = 0;
const pointers = new Map();
const stars = d3.range(170).map(() => [Math.random(), Math.random(), 0.4 + Math.random()*1.1, 0.25 + Math.random()*0.6]);
// a unit vector per cell, so the far-side test and culling need no trigonometry
const ux = new Float32Array(U), uy = new Float32Array(U), uz = new Float32Array(U);
for(let u=0;u<U;u++){ ux[u] = cp[u]*Math.cos(lam[u]); uy[u] = cp[u]*Math.sin(lam[u]); uz[u] = sp[u]; }
// cells come sorted by id (south to north, west to east); the first cell of each row lets a flat view visit only its rows
const rowStart = (() => {
  for(let u=1;u<U;u++) if(cellId[u] < cellId[u-1]) return null;
  const a = new Int32Array(NROW + 1); let u = 0;
  for(let r=0;r<=NROW;r++){ while(u < U && Math.floor(cellId[u]/NCOL) < r) u++; a[r] = u; }
  return a;
})();
let qX = new Float32Array(0), qY = new Float32Array(0), qI = new Int32Array(0), nQ = 0, qSide = 0, l1Shown = null;   // level 1 on screen, for hover
const NB = 12;
function setZoom(z){ zoom = z; const u = clamp((z - 1.5)/1.1, 0, 1); alpha = u*u*(3 - 2*u); projection.scale(S0*zoom); }
const bump = () => { baseVer++; dirty = true; };   // something on the base map changed

function resize(){
  W = wrap.clientWidth; H = wrap.clientHeight; if(!W || !H) return;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = baseC.width = Math.round(W*dpr); cv.height = baseC.height = Math.round(H*dpr); baseSig = '';
  S0 = Math.min(W, H)*0.42;
  projection.translate([W/2, H/2]); setZoom(zoom);
  draw(); dirty = false;   // resizing clears the canvas, so repaint now instead of waiting for the next frame
}
new ResizeObserver(resize).observe(wrap);

const boxShape = b => d3.geoGraticule().extentMajor([[b.w, b.s], [b.e, b.n]]).outline();
function selOutline(full){
  const s = state.sel;
  if(s.kind === 'box') return boxShape(s.box);
  if(s.polygon) return {type:'MultiLineString', coordinates:ringsOf(s.polygon)};
  if(s.kind === 'country' && featOf[s.c] >= 0){ const f = feats[featOf[s.c]]; return (full && zoom > 1.8 && feat50.get(f.properties.name)) || f; }
  return null;
}
const strongMW = () => liveArea && liveArea.strong_mw != null ? liveArea.strong_mw : null;

/* the projection above, done by hand for unit vectors: one dot product decides the far side */
let PC = {cx:0, cy:0, k:1, cX:0, cY:0, cZ:1, eX:0, eY:1, nX:0, nY:0, nZ:1};
function frameRot(){
  const r = projection.rotate(), l0 = -r[0]*RAD, p0 = -r[1]*RAD, s0 = Math.sin(p0), c0 = Math.cos(p0), sl = Math.sin(l0), cl = Math.cos(l0);
  PC = {cx:W/2, cy:H/2, k:projection.scale(), cX:c0*cl, cY:c0*sl, cZ:s0, eX:-sl, eY:cl, nX:-s0*cl, nY:-s0*sl, nZ:c0};
}
const PX = [0, 0];
function projU(x, y, z, m){   // unit vector -> PX; false on the far side or more than m px off screen
  const P = PC, cosc = x*P.cX + y*P.cY + z*P.cZ; if(cosc < 0.04) return false;
  let xr = x*P.eX + y*P.eY, yr = x*P.nX + y*P.nY + z*P.nZ;
  if(alpha > 0){ xr = (1 - alpha)*xr + alpha*Math.atan2(xr, cosc); yr = (1 - alpha)*yr + alpha*Math.asin(yr > 1 ? 1 : yr < -1 ? -1 : yr); }
  const X = P.cx + P.k*xr, Y = P.cy - P.k*yr;
  if(X < -m || X > W + m || Y < -m || Y > H + m) return false;
  PX[0] = X; PX[1] = Y; return true;
}
const unitOf = (lon, lat) => { const c = Math.cos(lat*RAD); return [c*Math.cos(lon*RAD), c*Math.sin(lon*RAD), Math.sin(lat*RAD)]; };
const projLL = (lon, lat, m) => { const v = unitOf(lon, lat); return projU(v[0], v[1], v[2], m); };

// visible [w, s, e, n] with a margin; the whole longitude range when the view crosses the date line or shows a pole
function viewBounds(pad){
  const pts = [];
  for(let i=0;i<=6;i++) for(let j=0;j<=6;j++){ const ll = lonLat(W*i/6, H*j/6); if(ll) pts.push(ll); }
  if(pts.length < 6) return null;
  const c0 = projection.invert([W/2, H/2]); if(!c0 || isNaN(c0[0])) return null;
  const rel = pts.map(p => ((p[0] - c0[0] + 540) % 360) - 180);
  let w = c0[0] + d3.min(rel), e = c0[0] + d3.max(rel), s = d3.min(pts, p => p[1]), n = d3.max(pts, p => p[1]);
  const pw = Math.max(0.5, (e - w)*pad), ph = Math.max(0.5, (n - s)*pad);
  w -= pw; e += pw; s -= ph; n += ph;
  if(n > 85){ n = 90; w = -180; e = 180; } if(s < -85){ s = -90; w = -180; e = 180; }
  if(w < -180 || e > 180){ w = -180; e = 180; }
  return [w, s, e, n];
}
function viewBox(){   // rounded out to whole degrees, so small moves reuse the caches
  const b = viewBounds(0.02); if(!b) return null;
  return [Math.max(-180, Math.floor(b[0])), Math.max(-90, Math.floor(b[1])), Math.min(180, Math.ceil(b[2])), Math.min(90, Math.ceil(b[3]))];
}
const fhit = (b, v) => b[0][0] > b[1][0] || (b[0][0] <= v[2] && b[1][0] >= v[0] && b[0][1] <= v[3] && b[1][1] >= v[1]);

/* ---------- confidence map: one unit per deg square from api/trust, loaded in the background ----------
   Corners are unit vectors shared by neighbours, so every frame projects each corner once and units meet without gaps. */
let TR = null, trustOff = !HAS.trust;
const kmOf = deg => Number((deg*111).toPrecision(1));   // 1 degree is about 100 km
function trustFail(){
  trustOff = true;
  const r = document.querySelector('input[name=view][value=trust]'); r.disabled = true;
  r.parentElement.title = 'Not available: the server has no confidence map yet. Rebuilding the data adds it.';
  if(state.view === 'trust') setView('count');
}
function loadTrust(){
  if(trustOff) return trustFail();
  api('api/trust').then(d => {
    const n = d.ux.length, D = d.deg, NX = Math.round(360/D), key = new Map(), cv = [], ci = new Int32Array(4*n), cls = new Uint8Array(n), at = new Map();
    const corner = (cx, cy) => {   // -180 and 180 are one corner
      const k = (cy + 1e4)*NX + ((cx % NX) + NX) % NX; let i = key.get(k);
      if(i === undefined){ key.set(k, i = key.size); cv.push(...unitOf(cx*D, cy*D)); }
      return i;
    };
    for(let i=0;i<n;i++){
      const x = d.ux[i], y = d.uy[i];
      ci[4*i] = corner(x, y); ci[4*i+1] = corner(x + 1, y); ci[4*i+2] = corner(x + 1, y + 1); ci[4*i+3] = corner(x, y + 1);
      cls[i] = d.n[i] < d.min_n ? 4 : TRUST.findIndex(s => d.err[i] < s[0]);
      at.set(y*1e4 + x, i);
    }
    TR = {...d, N:n, cv:Float32Array.from(cv), ci, cls, at, px:new Float32Array(cv.length/3*2)};
    bump(); legend(); buildAbout();
    const sz = d.by_size.filter(s => [20, 5, D].includes(s.deg));
    $('trustScale').textContent = `Larger areas are more exact. Monthly counts in test years were off by ${sz.map(s => `${pct(s.err)} for about ${fmt(kmOf(s.deg))} km`).join(', ')}.`;
    $('trustScale').hidden = false;
  }).catch(err => { console.error(err); trustFail(); });
}
// shortcut: a unit is drawn only when all 4 corners are on the near side, so a strip of about 2 degrees at the globe's limb stays plain land
function drawTrust(g, vb){
  const R = TR, P = R.px, c = R.cv, q = R.ci, D = R.deg, ps = [0, 1, 2, 3, 4].map(() => new Path2D());
  for(let j=0, m=c.length/3; j<m; j++){ if(projU(c[3*j], c[3*j+1], c[3*j+2], 300)){ P[2*j] = PX[0]; P[2*j+1] = PX[1]; } else P[2*j] = NaN; }
  for(let i=0;i<R.N;i++){
    if(vb){ const lo = R.ux[i]*D, la = R.uy[i]*D; if(la + D < vb[1] || la > vb[3] || lo + D < vb[0] || lo > vb[2]) continue; }
    const a = 2*q[4*i], b = 2*q[4*i+1], e = 2*q[4*i+2], f = 2*q[4*i+3];
    if(isNaN(P[a]) || isNaN(P[b]) || isNaN(P[e]) || isNaN(P[f])) continue;
    const p = ps[R.cls[i]]; p.moveTo(P[a], P[a+1]); p.lineTo(P[b], P[b+1]); p.lineTo(P[e], P[e+1]); p.lineTo(P[f], P[f+1]); p.closePath();
  }
  g.globalAlpha = .9;
  for(let k=0;k<4;k++){ g.fillStyle = TRUST[k][1]; g.fill(ps[k]); }
  g.fillStyle = g.createPattern(hatchC, 'repeat'); g.fill(ps[4]);
  g.globalAlpha = 1;
}
const hatchC = Object.assign(document.createElement('canvas'), {width:6, height:6});
{ const h = hatchC.getContext('2d'); h.strokeStyle = NOTEST; h.lineWidth = 1.5; h.beginPath();
  for(const o of [-6, 0, 6]){ h.moveTo(o, 6); h.lineTo(o + 6, 0); } h.stroke(); }   // "/" lines that tile without seams

/* ---------- base layer: ocean, land and borders, confidence map, states, selection, place names ---------- */
function drawBase(g, pth, full, under){
  const k = projection.scale(), cx = W/2, cy = H/2, round = 1 - alpha;
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
  g.fillStyle = C.fg;
  for(const s of stars){ g.globalAlpha = s[3]; g.fillRect(s[0]*W, s[1]*H, s[2], s[2]); }
  if(round > 0.02){
    g.globalAlpha = round;
    const a = g.createRadialGradient(cx, cy, k*0.96, cx, cy, k*1.16);           // atmosphere
    a.addColorStop(0, 'rgba(120,180,255,.38)'); a.addColorStop(1, 'rgba(120,180,255,0)');
    g.fillStyle = a; g.beginPath(); g.arc(cx, cy, k*1.16, 0, 7); g.fill();
  }
  g.globalAlpha = 1;
  g.beginPath(); pth({type:'Sphere'}); g.fillStyle = C.ocean; g.fill();
  g.beginPath(); pth(graticule); g.strokeStyle = C.line; g.globalAlpha = .35; g.lineWidth = .5; g.stroke(); g.globalAlpha = 1;
  const vb = alpha >= 0.5 ? viewBounds(alpha > 0.9 ? 0.1 : 0.3) : null;
  const land = full && alpha >= 0.5 && world50 ? world50.features : feats;
  if(alpha > 0.95) projection.precision(0);   // nearly flat: segments stay straight, and resampling was most of the cost
  const landP = new Path2D(), pc = pth.context();   // built once: fill, clip and outline all reuse it
  pth.context(landP); for(const f of land) if(!vb || fhit(f._b, vb)) pth(f); pth.context(pc);
  g.fillStyle = C.land; g.fill(landP); g.strokeStyle = C['land-line']; g.lineWidth = .6; g.stroke(landP);
  if(!under){
    if(state.view === 'trust' && !state.live){
      // units of coastal cells reach into the sea: land only. The clip is kept for still frames; a moving globe shows a few pixels of spill instead of paying for it every frame
      if(TR){ if(full){ g.save(); g.clip(landP); } drawTrust(g, vb); if(full) g.restore(); }
      g.strokeStyle = C.bg; g.lineWidth = .6; g.stroke(landP);
    }
    if(full && alpha > 0.9 && vb && stateMap.size){   // state and province borders of the visible area
      g.beginPath(); for(const s of stateMap.values()) if(hits(s.bbox, vb)) pth(s._ml);
      g.globalAlpha = Math.min(1, (alpha - .9)*10)*.5; g.strokeStyle = C.muted; g.lineWidth = .6; g.stroke(); g.globalAlpha = 1;
    }
    const out = selOutline(full);
    if(out){ g.beginPath(); pth(out); if(!/LineString/.test(out.type)){ g.fillStyle = 'rgba(143,201,255,.06)'; g.fill(); } g.strokeStyle = C.accent; g.lineWidth = 1.5; g.stroke(); }
    if(round > 0.02){
      const s = g.createRadialGradient(cx - k*.3, cy - k*.3, k*.2, cx, cy, k);    // shading toward the limb
      s.addColorStop(0, 'rgba(0,0,0,0)'); s.addColorStop(1, 'rgba(0,0,0,.5)');
      g.globalAlpha = round; g.fillStyle = s; g.beginPath(); g.arc(cx, cy, k, 0, 7); g.fill(); g.globalAlpha = 1;
    }
    if(full && alpha > 0.9 && viewPlaces && viewPlaces.length){   // names of the largest places in view, skipping overlaps
      g.font = '11px Inter, system-ui, sans-serif'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      const boxes = [];
      for(const p of viewPlaces){
        if(boxes.length >= 25) break;
        if(!p.name || !projLL(p.lon, p.lat, 0)) continue;
        const x = PX[0], y = PX[1], b = [x - 3, y - 8, x + g.measureText(p.name).width + 9, y + 8];
        if(boxes.some(q => b[0] < q[2] && b[2] > q[0] && b[1] < q[3] && b[3] > q[1])) continue; boxes.push(b);
        g.fillStyle = C.fg; g.globalAlpha = .9; g.fillRect(x - 1.5, y - 1.5, 3, 3);
        g.lineWidth = 3; g.strokeStyle = C.bg; g.strokeText(p.name, x + 5, y); g.fillText(p.name, x + 5, y);
      }
      g.globalAlpha = 1;
    }
  }
  projection.precision(0.6);
}

/* ---------- fire layer, level 0: the 0.5 degree grid that ships with the page ---------- */
function forVisible(vb, fn){   // flat view: only the rows and columns in view
  if(!vb || !rowStart){ for(let u=0;u<U;u++) fn(u); return; }
  const r0 = clamp(Math.floor((vb[1] + 90)/RES), 0, NROW - 1), r1 = clamp(Math.floor((vb[3] + 90)/RES), 0, NROW - 1);
  const c0 = Math.floor((vb[0] + 180)/RES), c1 = Math.floor((vb[2] + 180)/RES);
  for(let r=r0;r<=r1;r++){
    const hi = rowStart[r + 1], base = r*NCOL; let a = rowStart[r], b = hi;
    while(a < b){ const m = (a + b) >> 1; if(cellId[m] - base < c0) a = m + 1; else b = m; }
    for(let u=a; u<hi && cellId[u] - base <= c1; u++) fn(u);
  }
}
const inBox = (b, lon, lat) => b && lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
/* squares of every level are collected per frame, then filled with one path per colour bucket; the list also serves hover */
const SQ = {n:0, x:new Float32Array(1 << 16), y:new Float32Array(1 << 16), s:new Float32Array(1 << 16), v:new Float32Array(1 << 16),
            b:new Uint8Array(1 << 16), l:new Uint8Array(1 << 16), u:new Int32Array(1 << 16)};
let sqOrder = new Int32Array(1 << 16);
const sqCount = new Int32Array(NB + 1);
function sqPush(x, y, s, b, v, l, u){
  if(SQ.n === SQ.x.length){
    for(const k of ['x', 'y', 's', 'v', 'b', 'l', 'u']){ const a = new SQ[k].constructor(SQ[k].length*2); a.set(SQ[k]); SQ[k] = a; }
    sqOrder = new Int32Array(SQ.x.length);
  }
  const i = SQ.n++; SQ.x[i] = x; SQ.y[i] = y; SQ.s[i] = s; SQ.b[i] = b; SQ.v[i] = v; SQ.l[i] = l; SQ.u[i] = u;
}
function sqFlush(g, from, to, count, a, glow){   // counting sort by bucket, then one path per bucket
  if(to <= from || a <= 0) return;
  sqCount.fill(0);
  for(let i=from;i<to;i++) sqCount[SQ.b[i] + 1]++;
  for(let b=0;b<NB;b++) sqCount[b + 1] += sqCount[b];
  const pos = sqCount.slice(0, NB);
  for(let i=from;i<to;i++) sqOrder[pos[SQ.b[i]]++] = i;
  g.globalCompositeOperation = count ? 'lighter' : 'source-over';
  for(let b=0;b<NB;b++){
    const j0 = sqCount[b], j1 = sqCount[b + 1]; if(j0 === j1) continue;
    const q = (b + .5)/NB; g.fillStyle = count ? lut(seqLUT, 0.2 + 0.7*q) : lut(divLUT, q);
    if(glow){   // one soft glow, only on the round globe while it is still
      g.globalAlpha = (0.3 + 0.7*q)*0.1*a; g.beginPath();
      for(let j=j0;j<j1;j++){ const i = sqOrder[j], r = SQ.s[i]*1.8; g.moveTo(SQ.x[i] + r, SQ.y[i]); g.arc(SQ.x[i], SQ.y[i], r, 0, 7); }
      g.fill();
    }
    g.globalAlpha = (count ? 0.3 + 0.45*q : 0.8)*a; g.beginPath();
    for(let j=j0;j<j1;j++){ const i = sqOrder[j], s = SQ.s[i], h = s/2; g.rect(SQ.x[i] - h, SQ.y[i] - h, s, s); }
    g.fill();
  }
  g.globalAlpha = 1;
}
// level 0: the 0.5 degree cells as squares of their footprint, limited to the box when one is given
function cells0(vb, box){
  const k = PC.k, t = state.t, count = state.view !== 'anom', side = Math.max(1.5, k*RES*RAD);
  const area = box ? (vb ? [Math.max(vb[0], box[0]), Math.max(vb[1], box[1]), Math.min(vb[2], box[2]), Math.min(vb[3], box[3])] : box) : vb;
  if(area && (area[0] >= area[2] || area[1] >= area[3])) return;
  const med = count ? null : cellMedians(monOf(t)), rd = reader();
  forVisible(area, u => {
    if(box && !(lonD[u] > box[0] && lonD[u] < box[2] && latD[u] > box[1] && latD[u] < box[3])) return;
    const v = rd(u*T + t);
    if(count ? v < 1 : (v < 3 && med[u] < 3)) return;
    if(!projU(ux[u], uy[u], uz[u], side)) return;
    if(count) sqPush(PX[0], PX[1], side, Math.min(NB-1, Math.floor(Math.sqrt(Math.min(1, v/VMAX))*NB)), v, 0, u);
    else { const r = (v + 1)/(med[u] + 1); sqPush(PX[0], PX[1], side, Math.min(NB-1, Math.floor(anomU(r)*NB)), r, 0, u); }
  });
}
function drawLive0(g, cells, skip, a, moving){   // the last 7 days on 0.5 degree cells
  const k = PC.k, zs = 0.75 + 0.3*(k/S0), foot = 0.55*k*RES*RAD;
  g.globalCompositeOperation = 'lighter';
  for(const c of cells){
    const v = c[state.harm ? 3 : 2]; if(v < 0.5) continue;
    const lon = c[0] + RES/2, lat = c[1] + RES/2;
    if(skip && inBox(skip, lon, lat)) continue;
    if(!projLL(lon, lat, 16)) continue;
    const q = Math.sqrt(Math.min(1, v*4/VMAX)), r = clamp(Math.max(foot, (0.7 + 2.5*q)*zs), 0.8, 14);
    g.fillStyle = lut(seqLUT, 0.2 + 0.7*q);
    if(!moving){ g.globalAlpha = (0.3 + 0.7*q)*0.1*a; g.beginPath(); g.arc(PX[0], PX[1], r*2.2, 0, 7); g.fill(); }
    g.globalAlpha = (0.3 + 0.45*q)*a; g.beginPath(); g.arc(PX[0], PX[1], r, 0, 7); g.fill();
  }
}

/* ---------- fire layer, level 1: 0.05 degree cells for a month, or single detections for the last 7 days ----------
   Fetched for the visible box once the view settles, cached for 12 views, faded in when nothing as sharp was shown before. */
const l1Cache = new Map(), l1Bad = new Set();
let l1Cur = null, l1Pending = null, l1Ctl = null, cellsOff = false, ptsOff = false;
const l1Base = () => state.live ? `p|${state.time}|${state.strong ? 1 : 0}`
  : `c|${ymOf(state.t)}|${mParam().time || 'all'}|${state.harm ? 'h' : 'r'}|${state.view === 'anom' ? 1 : 0}`;
function l1Spec(){
  if(!isFlat() || playing) return null;
  const vb = viewBox(); if(!vb) return null;
  const base = l1Base(), key = base + '|' + vb.join(',');
  if(state.live){
    if(!HAS.live || ptsOff || !pbOff) return null;   // the week file does this better when it is there
    return {base, key, vb, url:'api/live/points?' + new URLSearchParams({bbox:vb.join(','), ...lParam(), strong:state.strong ? 1 : 0})};
  }
  if(!tilesOff || state.view === 'trust' || cellsOff || vb[2] - vb[0] > 70 || vb[3] - vb[1] > 45) return null;   // the API refuses larger boxes
  const anom = state.view === 'anom';
  return {base, key, vb, anom, harm:state.harm,
          url:'api/cells?' + new URLSearchParams({bbox:vb.join(','), month:ymOf(state.t), ...mParam(), normal:anom ? 1 : 0})};
}
function l1Prep(s, r){
  if(s.base[0] === 'p'){
    const pts = Array.isArray(r.points) ? r.points : [], n = pts.length, d = {...s, kind:'p', pts, n, ux:new Float32Array(n), uy:new Float32Array(n), uz:new Float32Array(n)};
    pts.forEach((p, i) => { const v = unitOf(+p[0], +p[1]); d.ux[i] = v[0]; d.uy[i] = v[1]; d.uz[i] = v[2]; });
    d.days = Math.round((new Date(r.to) - new Date(r.from))/864e5) + 1 || 7;   // the file can hold 8 local dates
    return d;
  }
  const cells = Array.isArray(r.cells) ? r.cells : [], res = +r.res || 0.05, f = (RES/res)**2, n = cells.length;
  const d = {...s, kind:'c', res, ux:new Float32Array(n), uy:new Float32Array(n), uz:new Float32Array(n), b:new Uint8Array(n), v:new Float32Array(n)};
  let m = 0;
  for(const c of cells){   // one colour scale with level 0: a 0.5 degree cell holds f = 100 of these cells
    const v = +(s.harm ? c[2] : c[3]) || 0, nv = +c[4] || 0;
    if(s.anom){ if(v*f < 3 && nv*f < 3) continue; const ratio = (v*f + 1)/(nv*f + 1); d.b[m] = Math.min(NB-1, Math.floor(anomU(ratio)*NB)); d.v[m] = ratio; }
    else { if(v*f < 1) continue; d.b[m] = Math.min(NB-1, Math.floor(Math.sqrt(Math.min(1, v*f/VMAX))*NB)); d.v[m] = v; }
    const u = unitOf((c[0] + .5)*res, (c[1] + .5)*res); d.ux[m] = u[0]; d.uy[m] = u[1]; d.uz[m] = u[2]; m++;
  }
  d.n = m;
  return d;
}
function l1Use(d){ d.shownAt = l1Cur && l1Cur.base === d.base ? 0 : performance.now(); l1Cur = d; dirty = true; }
function l1Check(){
  const s = l1Spec();
  if(!s || l1Bad.has(s.key) || l1Bad.has(s.base) || (l1Cur && l1Cur.key === s.key)) return;
  if(l1Cache.has(s.key)){ const d = l1Cache.get(s.key); l1Cache.delete(s.key); l1Cache.set(s.key, d); l1Use(d); return; }
  if(l1Pending === s.key) return;
  if(l1Ctl) l1Ctl.abort();
  const ctl = l1Ctl = new AbortController(); l1Pending = s.key;
  fetch(s.url, {signal:ctl.signal}).then(r => { if(!r.ok){ const e = new Error(r.status); e.status = r.status; throw e; } return r.json(); })
    .then(r => {
      const d = l1Prep(s, r); l1Cache.set(s.key, d); if(l1Cache.size > 12) l1Cache.delete(l1Cache.keys().next().value);
      if(l1Pending === s.key) l1Pending = null;
      if(l1Base() === s.base) l1Use(d);
    })
    .catch(err => {
      if(err.name === 'AbortError') return;
      if(l1Pending === s.key) l1Pending = null;
      if(err.status === 404){ if(s.base[0] === 'c') cellsOff = true; else ptsOff = true; }   // endpoint missing: level 0 only
      else if(err.status === 409) l1Bad.add(s.base);                  // day and night need rebuilt data
      else l1Bad.add(s.key);
    });
}
function drawL1(g, d, a){
  const k = PC.k;
  if(qX.length < d.n){ qX = new Float32Array(d.n); qY = new Float32Array(d.n); qI = new Int32Array(d.n); }
  nQ = 0; l1Shown = d;
  if(d.kind === 'p'){   // one dot per detection, coloured by strength
    const smw = strongMW() || 50, cls = new Uint8Array(d.n);
    for(let i=0;i<d.n;i++){ if(!projU(d.ux[i], d.uy[i], d.uz[i], 6)) continue; const f = +d.pts[i][4] || 0; cls[nQ] = f >= smw ? 2 : f >= smw/4 ? 1 : 0; qX[nQ] = PX[0]; qY[nQ] = PX[1]; qI[nQ++] = i; }
    g.globalCompositeOperation = 'source-over';
    for(let c=0;c<3;c++){
      const r = [1.8, 2.5, 3.3][c]; g.globalAlpha = .9*a; g.fillStyle = PTC[c]; g.beginPath();
      for(let j=0;j<nQ;j++){ if(cls[j] !== c) continue; g.moveTo(qX[j] + r, qY[j]); g.arc(qX[j], qY[j], r, 0, 7); }
      g.fill();
    }
    qSide = 6; return;
  }
  const side = Math.max(1.5, k*d.res*RAD), h = side/2, count = !d.anom;
  for(let i=0;i<d.n;i++){ if(!projU(d.ux[i], d.uy[i], d.uz[i], side)) continue; qX[nQ] = PX[0]; qY[nQ] = PX[1]; qI[nQ++] = i; }
  g.globalCompositeOperation = count ? 'lighter' : 'source-over';
  for(let b=0;b<NB;b++){
    const q = (b + .5)/NB; g.fillStyle = count ? lut(seqLUT, 0.2 + 0.7*q) : lut(divLUT, q);
    g.globalAlpha = (count ? 0.3 + 0.45*q : 0.8)*a; g.beginPath();
    for(let j=0;j<nQ;j++){ if(d.b[qI[j]] !== b) continue; g.rect(qX[j] - h, qY[j] - h, side, side); }
    g.fill();
  }
  qSide = Math.max(6, h);
}
/* ---------- time tiles: every month of an area in one file, so any month draws without asking the server ----------
   Level by footprint on screen: the finest level whose cell is at least 3 px (kept down to 2.6 px, so it does not flap). */
const TL = {1:{cell:0.25, tf:500, f:5, n:25, km:25}, 2:{cell:0.1, tf:200, f:2, n:4, km:10}, 3:{cell:0.05, tf:100, f:1, n:1, km:5}};
const TS = new Map();   // "level/tx/ty" -> {state: loading | ok | empty | err, data, bytes, at, used}
let tsBytes = 0, tsFlight = 0, tilesOff = false, tileLv = 0, prefetch = null, tileWanted = [], tileStat = [0, 0];
const TS_MAX = 250e6;
function levelFor(k, hyst){
  if(zoom < 1.8) return 0;
  let best = 0; for(let L=3;L>=1;L--) if(TL[L].cell*RAD*k >= 2){ best = L; break; }
  if(hyst && tileLv > best && TL[tileLv].cell*RAD*k >= 1.7) best = tileLv;
  return best || 1;
}
const tileBox = (L, x, y) => { const s = TL[L].tf*0.05, w = -180 + x*s, so = -90 + y*s; return [w, so, w + s, so + s]; };
function tilesIn(L, vb){   // tiles of level L over the box, nearest to the view centre first
  if(!vb) return [];
  const s = TL[L].tf*0.05, nx = Math.ceil(360/s), ny = Math.ceil(180/s), c = projection.invert([W/2, H/2]) || [0, 0];
  const x0 = clamp(Math.floor((vb[0] + 180)/s), 0, nx - 1), x1 = clamp(Math.floor((vb[2] + 180)/s - 1e-9), 0, nx - 1);
  const y0 = clamp(Math.floor((vb[1] + 90)/s), 0, ny - 1), y1 = clamp(Math.floor((vb[3] + 90)/s - 1e-9), 0, ny - 1), out = [];
  for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++){
    const b = tileBox(L, x, y), dl = ((b[0] + s/2 - c[0] + 540) % 360) - 180, dp = b[1] + s/2 - c[1];
    out.push({key:`${L}/${x}/${y}`, L, x, y, b, d:dl*dl + dp*dp});
  }
  return out.sort((p, q) => p.d - q.d);
}
const tileView = () => viewBounds(isFlat() ? 0.05 : 0.3);
function wantNow(hyst){
  if(tilesOff || state.live || state.view === 'trust') return [];
  const L = levelFor(projection.scale(), hyst); return L ? tilesIn(L, tileView()) : [];
}
function decodeTile(buf, L, x, y){
  const hl = new DataView(buf).getUint32(0, true), h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
  let off = 4 + hl; off += (-off & 3);
  const nT = h.months, n = h.nnz, mstart = new Uint32Array(buf, off, nT + 1); off += (nT + 1)*4;
  const u16 = () => { const a = new Uint16Array(buf, off, n); off += n*2; off += (-off & 3); return a; };
  const idx = u16(), harm = u16(), night = u16(), raw = u16();
  const t = TL[L], b = tileBox(L, x, y), vx = new Float32Array(10000), vy = new Float32Array(10000), vz = new Float32Array(10000);
  for(let r=0;r<100;r++) for(let c=0;c<100;c++){ const v = unitOf(b[0] + (c + .5)*t.cell, b[1] + (r + .5)*t.cell), i = r*100 + c; vx[i] = v[0]; vy[i] = v[1]; vz[i] = v[2]; }
  return {nT, t0:tAt(h.first || '2000-11'), mstart, idx, harm, night, raw, scale:+h.scale || 1, hasNight:!!h.night, vx, vy, vz, norm:new Map()};
}
function startTile(it){
  const ctl = new AbortController(), e = {state:'loading', ctl, bytes:0, used:0};
  TS.set(it.key, e); tsFlight++;
  fetch(`api/tiles/${it.L}/${it.x}/${it.y}`, {signal:ctl.signal})
    .then(r => { if(r.status === 204) return null; if(!r.ok){ const x = new Error(r.status); x.status = r.status; throw x; } return r.arrayBuffer(); })
    .then(buf => {
      if(TS.get(it.key) !== e) return;
      if(!buf || !buf.byteLength){ e.state = 'empty'; }
      else { e.data = decodeTile(buf, it.L, it.x, it.y); e.state = 'ok'; e.bytes = buf.byteLength + 120000; tsBytes += e.bytes; evictTiles(); }
      e.at = performance.now(); dirty = true;
    })
    .catch(err => {
      if(err.name === 'AbortError' || TS.get(it.key) !== e) return;
      if(err.status === 404){ tilesOff = true; for(const [k, q] of TS) if(q.state === 'loading') q.ctl.abort(); TS.clear(); tsBytes = 0; legend(); dirty = true; return; }   // no tile endpoint: the old path
      e.state = 'err'; e.at = performance.now();
    })
    .finally(() => { tsFlight--; pumpTiles(); });
}
function evictTiles(){
  while(tsBytes > TS_MAX){
    let old = null, ok = null;
    for(const [k, e] of TS) if(e.state === 'ok' && (!old || e.used < old.used)){ old = e; ok = k; }
    if(!old || performance.now() - old.used < 200) return;   // never drop what is on screen
    TS.delete(ok); tsBytes -= old.bytes;
  }
}
function pumpTiles(){   // at most 6 requests, nearest first; requests for tiles that left the view are cancelled
  if(tilesOff) return;
  const list = (prefetch || []).concat(fly ? [] : tileWanted), keep = new Set(list.map(i => i.key)), now = performance.now();
  for(const [k, e] of TS) if(e.state === 'loading' && !keep.has(k)){ e.ctl.abort(); TS.delete(k); }
  for(const it of list){
    if(tsFlight >= 6) break;
    const e = TS.get(it.key);
    if(e && e.state === 'err' && now - e.at > 10000) TS.delete(it.key);
    if(!TS.has(it.key)) startTile(it);
  }
}
function prefetchFly(lonR, latR, k1){   // the tiles of the destination, asked for as the fly starts
  if(tilesOff || state.live || state.view === 'trust') return;
  const r = projection.rotate(), z = zoom;
  projection.rotate([lonR, latR]); setZoom(k1);
  prefetch = wantNow(false);
  projection.rotate(r); setZoom(z);
  pumpTiles();
}
// normal of each cell for one calendar month and filter: median over the baseline years, a missing year counts as 0
const tileVal = (d, i, filt) => filt === 'raw' ? d.raw[i] : filt === 'night' ? d.night[i]/d.scale : filt === 'day' ? Math.max(0, d.harm[i] - d.night[i])/d.scale : d.harm[i]/d.scale;
function tileNormal(e, mo, filt){
  const d = e.data, key = mo + filt; let r = d.norm.get(key); if(r) return r;
  const ny = BASE.length, buf = new Float32Array(10000*ny), seen = new Uint8Array(10000), ids = [];
  BASE.forEach((Y, yi) => { const t = tOf(Y, mo) - d.t0; if(t < 0 || t >= d.nT) return;
    for(let i=d.mstart[t];i<d.mstart[t + 1];i++){ const id = d.idx[i]; buf[id*ny + yi] = tileVal(d, i, filt); if(!seen[id]){ seen[id] = 1; ids.push(id); } } });
  const med = new Float32Array(10000), tmp = new Float32Array(ny), keep = [];
  for(const id of ids){ for(let j=0;j<ny;j++) tmp[j] = buf[id*ny + j]; tmp.sort(); med[id] = (tmp[(ny - 1) >> 1] + tmp[ny >> 1])/2; if(med[id] > 0) keep.push(id); }
  keep.sort((a, b) => a - b);
  r = {med, ids:Int32Array.from(keep)}; d.norm.set(key, r); e.bytes += 40000 + keep.length*4; tsBytes += 40000 + keep.length*4;
  return r;
}
const tCur = new Float32Array(10000), tMark = new Uint8Array(10000);
function tileSquares(e, L, tb, box, vb){   // push the squares of one tile for the selected month, inside box and view
  const d = e.data, t = state.t - d.t0; if(t < 0 || t >= d.nT) return;
  const c = TL[L], f100 = 100/c.n, side = Math.max(1.2, PC.k*c.cell*RAD), anom = state.view === 'anom';
  const filt = state.harm ? (mParam().time || 'all') : 'raw';
  const w = Math.max(box[0], vb ? vb[0] : -180), e2 = Math.min(box[2], vb ? vb[2] : 180), s = Math.max(box[1], vb ? vb[1] : -90), n = Math.min(box[3], vb ? vb[3] : 90);
  if(w >= e2 || s >= n) return;
  const c0 = clamp(Math.floor((w - tb[0])/c.cell + 1e-6), 0, 99), c1 = clamp(Math.ceil((e2 - tb[0])/c.cell - 1e-6) - 1, 0, 99);
  const r0 = clamp(Math.floor((s - tb[1])/c.cell + 1e-6), 0, 99), r1 = clamp(Math.ceil((n - tb[1])/c.cell - 1e-6) - 1, 0, 99);
  let a = d.mstart[t], b = d.mstart[t + 1];
  { let lo = a, hi = b; while(lo < hi){ const m = (lo + hi) >> 1; if(d.idx[m] < r0*100) lo = m + 1; else hi = m; } a = lo; }   // rows are sorted
  const last = r1*100 + 99;
  if(!anom){
    for(let i=a;i<b;i++){
      const id = d.idx[i]; if(id > last) break;
      const col = id % 100; if(col < c0 || col > c1) continue;
      const v = tileVal(d, i, filt); if(v*f100 < 1) continue;
      if(!projU(d.vx[id], d.vy[id], d.vz[id], side)) continue;
      sqPush(PX[0], PX[1], side, Math.min(NB-1, Math.floor(Math.sqrt(Math.min(1, v*f100/VMAX))*NB)), v, L, -1);
    }
    return;
  }
  const nm = tileNormal(e, monOf(state.t), filt), list = [];
  for(let i=a;i<b;i++){ const id = d.idx[i]; if(id > last) break; const col = id % 100; if(col < c0 || col > c1) continue; tCur[id] = tileVal(d, i, filt); tMark[id] = 1; list.push(id); }
  for(const id of nm.ids){ if(id < r0*100) continue; if(id > last) break; const col = id % 100; if(col < c0 || col > c1 || tMark[id]) continue; list.push(id); }
  for(const id of list){
    const v = tCur[id], m = nm.med[id]; tCur[id] = 0; tMark[id] = 0;
    if(v*f100 < 3 && m*f100 < 3) continue;
    if(!projU(d.vx[id], d.vy[id], d.vz[id], side)) continue;
    const r = (v*f100 + 1)/(m*f100 + 1);
    sqPush(PX[0], PX[1], side, Math.min(NB-1, Math.floor(anomU(r)*NB)), r, L, -1);
  }
}
function fallbackSquares(L, box, vb){   // best data already in memory for a tile that is not here yet: a coarser tile, else level 0
  for(let M=L-1;M>=1;M--){
    const cover = tilesIn(M, box).filter(it => hits(it.b, box) && it.b[0] < box[2] && it.b[2] > box[0] && it.b[1] < box[3] && it.b[3] > box[1]);
    if(cover.length && cover.every(it => { const e = TS.get(it.key); return e && (e.state === 'ok' || e.state === 'empty'); })){
      for(const it of cover){ const e = TS.get(it.key); if(e.state === 'ok'){ e.used = performance.now(); tileSquares(e, M, it.b, box, vb); } }
      return;
    }
  }
  cells0(vb, box);
}
function drawTiles(g, L, now){
  const vb = tileView(), vis = tilesIn(L, vb), count = state.view !== 'anom', fading = [];
  let ok = 0;
  const from = SQ.n;
  for(const it of vis){
    const e = TS.get(it.key);
    if(e && e.state === 'empty'){ ok++; continue; }
    if(e && e.state === 'ok'){
      ok++; e.used = now;
      const f = reduced ? 1 : clamp((now - e.at)/120, 0, 1);
      if(f < 1){ fading.push([it, e, f]); continue; }
      tileSquares(e, L, it.b, it.b, vb);
    } else fallbackSquares(L, it.b, vb);
  }
  sqFlush(g, from, SQ.n, count, 1, false);
  for(const [it, e, f] of fading){   // a new tile fades in over the data it replaces
    let i0 = SQ.n; fallbackSquares(L, it.b, vb); sqFlush(g, i0, SQ.n, count, 1 - f, false);
    i0 = SQ.n; tileSquares(e, L, it.b, it.b, vb); sqFlush(g, i0, SQ.n, count, f, false);
    dirty = true;
  }
  tileStat = [ok, vis.length - ok];
}

/* ---------- the last 7 days as one binary file: single detections for the whole world, filtered in the page ---------- */
let PB = null, pbOff = !HAS.live;
function decodePB(buf){
  const hl = new DataView(buf).getUint32(0, true), h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
  let off = 4 + hl; off += (-off & 3);
  const n = h.n, B = h.buckets, take = (Type, m) => { const a = new Type(buf, off, m); off += m*Type.BYTES_PER_ELEMENT; off += (-off & 3); return a; };
  const lon = take(Float32Array, n), lat = take(Float32Array, n), frp = take(Float32Array, n), minute = take(Uint16Array, n);
  const day = take(Uint8Array, n), flags = take(Uint8Array, n), burn = take(Uint8Array, n), ids = take(Uint32Array, B), starts = take(Uint32Array, B + 1);
  const vx = new Float32Array(n), vy = new Float32Array(n), vz = new Float32Array(n);
  for(let i=0;i<n;i++){ const v = unitOf(lon[i], lat[i]); vx[i] = v[0]; vy[i] = v[1]; vz[i] = v[2]; }
  return {h, n, lon, lat, frp, minute, day, flags, burn, ids, starts, vx, vy, vz, first:new Date((h.first_day || h.from) + 'T00:00:00Z')};
}
function loadPB(){
  if(pbOff) return;
  fetch('api/live/points.bin').then(r => { if(!r.ok){ const x = new Error(r.status); x.status = r.status; throw x; } return r.arrayBuffer(); })
    .then(buf => { PB = decodePB(buf); dirty = true; legend(); })
    .catch(() => { pbOff = true; });   // keep the per-view request
}
const pbStrong = () => PB && PB.h.strong_mw != null ? +PB.h.strong_mw : strongMW();
function drawPB(g){
  const d = PB, vb = tileView(), smw = pbStrong() || 50, night = state.time === 'night', day = state.time === 'day', strong = state.strong;
  if(qX.length < d.n){ qX = new Float32Array(d.n); qY = new Float32Array(d.n); qI = new Int32Array(d.n); }
  const cls = new Uint8Array(d.n); nQ = 0; l1Shown = {kind:'pb'};
  const visit = (a, b) => { for(let i=a;i<b;i++){
    const isN = d.flags[i] & 1; if((night && !isN) || (day && isN)) continue;
    const f = d.frp[i]; if(strong && !(f >= smw)) continue;
    if(!projU(d.vx[i], d.vy[i], d.vz[i], 6)) continue;
    cls[nQ] = f >= smw ? 2 : f >= smw/4 ? 1 : 0; qX[nQ] = PX[0]; qY[nQ] = PX[1]; qI[nQ++] = i; } };
  if(!vb || vb[2] - vb[0] >= 359) visit(0, d.n);
  else {   // only the 0.5 degree buckets in view
    const r0 = clamp(Math.floor((vb[1] + 90)/0.5), 0, 359), r1 = clamp(Math.floor((vb[3] + 90)/0.5), 0, 359);
    const c0 = clamp(Math.floor((vb[0] + 180)/0.5), 0, 719), c1 = clamp(Math.floor((vb[2] + 180)/0.5), 0, 719);
    for(let r=r0;r<=r1;r++){
      const lo0 = r*720 + c0, hi0 = r*720 + c1; let lo = 0, hi = d.ids.length;
      while(lo < hi){ const m = (lo + hi) >> 1; if(d.ids[m] < lo0) lo = m + 1; else hi = m; }
      for(let j=lo;j<d.ids.length && d.ids[j] <= hi0;j++) visit(d.starts[j], d.starts[j + 1]);
    }
  }
  g.globalCompositeOperation = 'source-over';
  for(let c=0;c<3;c++){
    const r = [1.8, 2.5, 3.3][c]; g.globalAlpha = .9; g.fillStyle = PTC[c]; g.beginPath();
    for(let j=0;j<nQ;j++){ if(cls[j] !== c) continue; g.moveTo(qX[j] + r, qY[j]); g.arc(qX[j], qY[j], r, 0, 7); }
    g.fill();
  }
  qSide = 6;
}

function drawFire(g, moving, now){
  nQ = 0; l1Shown = null; SQ.n = 0;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const flat = isFlat(), vb = flat ? viewBounds(0.1) : null, glow = alpha < 0.5 && !moving;
  let lv = 0;
  if(state.live && PB && zoom >= 1.8){ drawPB(g); lv = 4; }
  else if(!state.live && state.view !== 'trust' && !tilesOff){
    lv = tileLv = levelFor(PC.k, true);
    if(lv === 0){ cells0(vb, null); sqFlush(g, 0, SQ.n, state.view !== 'anom', 1, glow); tileStat = [0, 0]; }
    else drawTiles(g, lv, now);
  } else {
    // without tiles or the week file: level 0, and the per-view level 1 once the view has settled (as before)
    const L1 = flat && !playing && l1Cur && l1Cur.base === l1Base() && (state.live || state.view !== 'trust') ? l1Cur : null;
    const f = !L1 ? 0 : reduced || !L1.shownAt ? 1 : clamp((now - L1.shownAt)/200, 0, 1);
    if(L1 && f < 1) dirty = true;
    const skip = L1 && f >= 1 ? L1.vb : null, a0 = L1 && f < 1 ? 1 - f : 1;   // after the fade, level 0 only outside the level 1 box
    if(state.live){ const cells = liveCells.get(state.time); if(cells && a0 > 0) drawLive0(g, cells, skip, a0, moving); }
    else if(state.view !== 'trust' && a0 > 0){
      cells0(vb, null);
      if(skip){ let j = 0; for(let i=0;i<SQ.n;i++){ const u = SQ.u[i]; if(inBox(skip, lonD[u], latD[u])) continue;   // drop squares under level 1
        if(j !== i) for(const k of ['x', 'y', 's', 'v', 'b', 'l', 'u']) SQ[k][j] = SQ[k][i]; j++; } SQ.n = j; }
      sqFlush(g, 0, SQ.n, state.view !== 'anom', a0, glow);
    }
    if(L1){ drawL1(g, L1, f); lv = L1.kind === 'p' ? 4 : 3; }
  }
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  if(lv !== fireLevel){ fireLevel = lv; legend(); }
}

/* ---------- one frame ---------- */
const PERF = new URLSearchParams(location.search).get('perf') === '1', frameMs = [];
let perfN = 0;
const perfBox = PERF ? Object.assign(document.createElement('p'), {className:'perf'}) : null;
if(perfBox) wrap.appendChild(perfBox);
const isMoving = now => !!fly || !!pinch || !!(dragging && dragging.moved) || now - lastWheel < 140 || (spin && !dragging && !drawMode);
function draw(now = performance.now()){
  if(!W) return;
  const t0 = performance.now(), moving = isMoving(now);
  frameRot();
  const r = projection.rotate(), sig = `${r[0]},${r[1]},${PC.k},${alpha},${W},${H},${dpr},${baseVer}`;
  if(!moving){   // still: full detail, drawn once into the cache, then only copied
    if(sig !== baseSig){ drawBase(bctx, bpath, true, false); baseSig = sig; baseView = {k:PC.k, alpha, c:projection.invert([W/2, H/2])}; baseMode = 'full'; }
    else baseMode = 'blit';
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.drawImage(baseC, 0, 0);
  } else if(alpha > 0.999 && baseView && baseView.alpha > 0.999 && baseView.c && !isNaN(baseView.c[0])){
    // flat and moving: coarse land underneath, the last sharp image moved and scaled onto the current view
    drawBase(ctx, path, false, true);
    const p = projection(baseView.c), s = PC.k/baseView.k;
    ctx.setTransform(dpr*s, 0, 0, dpr*s, dpr*(p[0] - s*W/2), dpr*(p[1] - s*H/2)); ctx.drawImage(baseC, 0, 0, W, H);
    baseMode = 'transform';
  } else { drawBase(ctx, path, false, false); baseMode = 'direct 110m'; }
  drawFire(ctx, moving, now);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.setLineDash([5, 4]); ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5;
  if(drawRect) ctx.strokeRect(drawRect.x0, drawRect.y0, drawRect.x1 - drawRect.x0, drawRect.y1 - drawRect.y0);
  if(poly.length){ ctx.beginPath(); path({type:'LineString', coordinates:poly}); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = C.accent; for(const p of poly){ const q = projection(p); if(q){ ctx.beginPath(); ctx.arc(q[0], q[1], 3, 0, 7); ctx.fill(); } } }
  ctx.setLineDash([]);
  frameMs.push(performance.now() - t0); if(frameMs.length > 60) frameMs.shift();
  if(perfBox && ++perfN % 10 === 0){
    const s = frameMs.slice().sort((a, b) => a - b);
    perfBox.textContent = `median ${s[s.length >> 1].toFixed(1)} ms, worst ${s.at(-1).toFixed(1)} ms\nbase: ${baseMode}, fire level ${fireLevel === 4 ? 'dots' : fireLevel}
tiles ${tileStat[0]} loaded, ${tileStat[1]} waiting, ${tsFlight} in flight, ${(tsBytes/1e6).toFixed(0)} MB`;
  }
}

function flyTo(lon, lat, k1){
  const r = projection.rotate();
  if(reduced){ projection.rotate([lon, lat]); setZoom(k1); dirty = true; return; }
  fly = {t0:performance.now(), dur:1700, l0:r[0], dl:((lon - r[0] + 540) % 360) - 180, p0:r[1], p1:lat, k0:zoom, k1};
  prefetchFly(lon, lat, k1);
}
// centre and angular radius of a set of [lon, lat] points, to frame them
function frame(pts){
  let X = 0, Y = 0, Z = 0;
  const xyz = pts.map(([lo, la]) => [Math.cos(la*RAD)*Math.cos(lo*RAD), Math.cos(la*RAD)*Math.sin(lo*RAD), Math.sin(la*RAD)]);
  for(const p of xyz){ X += p[0]; Y += p[1]; Z += p[2]; }
  const n = Math.hypot(X, Y, Z) || 1; X /= n; Y /= n; Z /= n;
  let minDot = 1; for(const p of xyz){ const d = X*p[0] + Y*p[1] + Z*p[2]; if(d < minDot) minDot = d; }
  return {lon:Math.atan2(Y, X)/RAD, lat:Math.asin(Z)/RAD, rad:Math.acos(clamp(minDot, -1, 1))};
}
const goTo = where => flyTo(-where.lon, clamp(-where.lat, -75, 75), clamp(0.85/Math.sin(clamp(where.rad, 0.5*RAD, 60*RAD)), 1.2, 40));
const frameBox = b => frame([[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]], [(b[0] + b[2])/2, (b[1] + b[3])/2]]);
function anchor(ll, x, y){   // turn the map so the place ll sits under the screen point x, y
  for(let i=0;i<2;i++){
    const p = projection(ll), r = projection.rotate(), k = projection.scale(); if(!p || isNaN(p[0])) return;
    projection.rotate([r[0] + (x - p[0])/k/RAD, clamp(r[1] - (y - p[1])/k/RAD, -80, 80)]);
  }
}

let last = 0, playing = false, playAcc = 0, speed = 1, rng = [0, T-1],   // Play runs inside rng, at speed times one month per 110 ms
     lastCheck = 0, lastTileReq = 0;
function tick(now){
  const dt = Math.min(100, now - last); last = now;
  if(fly){
    const u = Math.min(1, (now - fly.t0)/fly.dur), e = d3.easeCubicInOut(u);
    projection.rotate([fly.l0 + fly.dl*e, fly.p0 + (fly.p1 - fly.p0)*e]);
    setZoom(fly.k0 * Math.pow(fly.k1/fly.k0, e));
    if(u >= 1){ fly = null; prefetch = null; } dirty = true;
  } else if(spin && !dragging && !drawMode){
    const r = projection.rotate(); projection.rotate([r[0] + dt*0.004, r[1]]); dirty = true;
  }
  if(playing){ playAcc += dt; if(playAcc > 110/speed){ playAcc = 0; if(state.t >= rng[1]) setPlaying(false); else setT(state.t + 1); } }
  const mv = isMoving(now);
  if(mv) lastMove = now; else if(wasMoving) dirty = true;   // movement ended: one full-detail frame
  wasMoving = mv;
  const flat = isFlat(); if(flat !== wasFlat){ wasFlat = flat; legend(); howto(); }
  if(!mv && now - lastMove >= 150 && now - lastCheck > 100){ lastCheck = now; viewCheck(); }   // the view has settled
  if(now - lastTileReq > 100){ lastTileReq = now; tileWanted = fly ? [] : wantNow(true); pumpTiles(); }   // tiles do not wait for the view to settle
  if(dirty){ dirty = false; draw(now); }
  requestAnimationFrame(tick);
}

/* ---------- what a settled flat view loads: states, place names, and level 1 fire data ---------- */
function viewCheck(){
  if(!isFlat()) return;
  const vb = viewBox(); if(!vb) return;
  const key = vb.join(',');
  if(key !== viewKey){ viewKey = key; curVB = vb; loadView(vb, key); }
  l1Check();
}
function loadView(vb, key){
  const q = '?' + new URLSearchParams({bbox:vb.join(',')});
  if(HAS.states && !statesOff && !stateCache.has(key)){
    stateCache.add(key);
    api('api/states' + q).then(r => { const n = stateMap.size; (r.states || []).forEach(addState); if(stateMap.size !== n) bump(); })
      .catch(err => { stateCache.delete(key); if(err.status === 404) statesOff = true; });
  }
  if(HAS.places && !placesOff){
    if(placeCache.has(key)){ if(viewPlaces !== placeCache.get(key)){ viewPlaces = placeCache.get(key); bump(); } return; }
    api('api/places' + q + '&limit=40').then(r => { placeCache.set(key, r.places || []); if(viewKey === key){ viewPlaces = r.places || []; bump(); } })
      .catch(err => { if(err.status === 404) placesOff = true; });
  }
}

/* globe pointer: drag to move, wheel or pinch to zoom, click to pick a country or state, hover for a reading, or draw an area */
const tip = $('tip');
function showTip(text, x, y){ tip.textContent = text; tip.hidden = false; tip.style.left = Math.min(x + 12, innerWidth - 250) + 'px'; tip.style.top = (y + 14) + 'px'; }
function local(e){ const b = cv.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; }
function lonLat(x, y){   // screen point -> [lon, lat] on the visible side, or null
  const k = projection.scale(), q = blend.invert((x - W/2)/k, (H/2 - y)/k);
  if(!(Math.abs(q[0]) <= Math.PI/2 && Math.abs(q[1]) <= Math.PI/2)) return null;
  const ll = projection.invert([x, y]); return ll && !isNaN(ll[0]) && !isNaN(ll[1]) ? ll : null;
}
const pinchAt = () => { const [a, b] = [...pointers.values()]; return [Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, (a[0] + b[0])/2, (a[1] + b[1])/2]; };
function endGesture(){ dragging = null; drawRect = null; cv.classList.remove('dragging'); }
cv.addEventListener('pointerdown', e => {
  const xy = local(e), [x, y] = xy, r = projection.rotate();
  pointers.set(e.pointerId, xy); cv.setPointerCapture(e.pointerId); tip.hidden = true;
  if(pointers.size === 2){   // second finger: pinch to zoom, two-finger drag to move
    endGesture(); noClick = true; spin = false; fly = null;
    const [d, mx, my] = pinchAt(); pinch = {d0:d, z0:zoom, mx, my, r, ll:isFlat() ? lonLat(mx, my) : null}; return;
  }
  if(pointers.size > 2) return;
  noClick = false;
  if(drawMode === 'box'){ drawRect = {x0:x, y0:y, x1:x, y1:y}; spin = false; fly = null; return; }
  dragging = {x, y, l:r[0], p:r[1], moved:false}; cv.classList.add('dragging');
});
cv.addEventListener('pointermove', e => {
  const [x, y] = local(e);
  if(pointers.has(e.pointerId)) pointers.set(e.pointerId, [x, y]);
  if(pinch){
    if(pointers.size < 2) return;
    const [d, mx, my] = pinchAt();
    setZoom(clamp(pinch.z0*d/pinch.d0, 0.8, 60));
    if(pinch.ll && isFlat()) anchor(pinch.ll, mx, my);
    else { const s = 57.3/projection.scale(); projection.rotate([pinch.r[0] + (mx - pinch.mx)*s, clamp(pinch.r[1] - (my - pinch.my)*s, -80, 80)]); }
    dirty = true; return;
  }
  if(drawRect){ drawRect.x1 = x; drawRect.y1 = y; dirty = true; return; }
  if(dragging){
    const dx = x - dragging.x, dy = y - dragging.y;
    if(Math.abs(dx) + Math.abs(dy) > 4){ dragging.moved = true; spin = false; fly = null; }
    if(dragging.moved){ const s = 57.3/projection.scale(); projection.rotate([dragging.l + dx*s, clamp(dragging.p - dy*s, -80, 80)]); dirty = true; }
    return;
  }
  if(state.view === 'trust' && !state.live){
    const ll = TR && lonLat(x, y), i = ll ? TR.at.get(Math.floor(ll[1]/TR.deg)*1e4 + Math.floor(ll[0]/TR.deg)) : undefined;
    if(i === undefined || countryAt(ll[0], ll[1]) < 0){ tip.hidden = true; return; }   // the sea part of a coastal unit is not drawn
    showTip(TR.cls[i] === 4 ? `Too few fires here to test (${fmt(TR.n[i])} detections in the test years).`
      : `In test years, the adjusted monthly count for this area (about ${kmOf(TR.deg)} km) was off by ${pct(TR.err[i])}.\nWithout adjustment: ${pct(TR.raw[i])}.\n${fmt(TR.n[i])} detections in the test.`, e.clientX, e.clientY);
    return;
  }
  const ll = isFlat() && stateMap.size ? lonLat(x, y) : null, st = ll && stateAt(ll[0], ll[1]), m = monOf(state.t), yr = yearOf(state.t);
  const name = st ? st.name + '\n' : '';
  if(nQ && l1Shown){   // level 1: a single detection or a square of about 5 km
    let best = -1, bd = qSide*qSide;
    for(let j=0;j<nQ;j++){ const d = (qX[j]-x)**2 + (qY[j]-y)**2; if(d < bd){ bd = d; best = qI[j]; } }
    if(best >= 0){
      const d = l1Shown;
      if(d.kind === 'pb'){ const P = PB, smw = pbStrong(), dt = new Date(P.first.getTime() + P.day[best]*864e5), mi = P.minute[best];
        showTip(`${dt.getUTCDate()} ${MON[dt.getUTCMonth()]}, ${String(mi/60 | 0).padStart(2, '0')}:${String(mi%60).padStart(2, '0')} local time${P.flags[best] & 1 ? ' (night)' : ''}\n${smw != null && P.frp[best] >= smw ? 'Strong fire. ' : ''}Burning ${P.burn[best]} of ${Math.max(+P.h.days || 7, P.burn[best])} days here`, e.clientX, e.clientY); }
      else if(d.kind === 'p'){ const p = d.pts[best], smw = strongMW();
        showTip(`${dShort(p[2])}, ${p[3]} local time${p[5] === 'N' ? ' (night)' : ''}\n${smw != null && p[4] >= smw ? 'Strong fire. ' : ''}Burning ${p[6]} of ${Math.max(d.days, p[6])} days here`, e.clientX, e.clientY); }
      else { const v = d.v[best];
        showTip(d.anom ? `${name}${ratioText(v, `${MONTHS[m]} in this square`)}`
          : `${name}${v < 10 ? +v.toFixed(1) : fmt(v)} fire detections${state.harm ? ' (adjusted)' : ''} in this square of about 5 km, ${MON[m]} ${yr}`, e.clientX, e.clientY); }
      return;
    }
  }
  let best = -1, bd = Infinity;   // squares of any level: the one under the cursor, or the nearest within 6 px
  for(let i=0;i<SQ.n;i++){ const h = Math.max(SQ.s[i]/2, 6), dx = Math.abs(SQ.x[i] - x), dy = Math.abs(SQ.y[i] - y); if(dx > h || dy > h) continue; const dd = dx*dx + dy*dy; if(dd < bd){ bd = dd; best = i; } }
  if(best < 0){ if(st && !drawMode) showTip(`${st.name}\nClick to choose this area`, e.clientX, e.clientY); else tip.hidden = true; return; }
  const u = SQ.u[best], v = SQ.v[best], km = [50, 25, 10, 5][SQ.l[best]], nm = name || (u >= 0 && ctry[u] !== NONE ? COUNTRIES[ctry[u]] + '\n' : '');
  showTip(state.view === 'count' ? `${nm}${v < 10 && SQ.l[best] ? +v.toFixed(1) : fmt(v)} fire detections${state.harm ? ' (adjusted)' : ''} in this square of about ${km} km, ${MON[m]} ${yr}`
                                 : `${nm}${ratioText(v, `${MONTHS[m]} in this square`)}`, e.clientX, e.clientY);
});
cv.addEventListener('pointerup', e => {
  const [x, y] = local(e);
  pointers.delete(e.pointerId);
  if(pinch){ if(pointers.size < 2) pinch = null; endGesture(); return; }
  if(noClick){ if(!pointers.size) noClick = false; endGesture(); return; }   // the last finger of a pinch is not a click
  if(drawRect){ const r = drawRect; drawRect = null; setDrawMode(null); dirty = true; boxFromRect(r); return; }
  const d = dragging; dragging = null; cv.classList.remove('dragging');
  if(!d || d.moved) return;
  const ll = lonLat(x, y); if(!ll) return;
  if(drawMode === 'poly'){ const p = poly.at(-1); if(!p || p[0] !== ll[0] || p[1] !== ll[1]) poly.push(ll); $('polyDone').hidden = poly.length < 3; dirty = true; return; }
  if(isFlat()){ const st = stateAt(ll[0], ll[1]); if(st){ selectState(st); return; } }
  const f = countryAt(ll[0], ll[1]);
  const u = cellUnit.get(Math.min(NROW-1, Math.floor((ll[1] + 90)/RES))*NCOL + Math.min(NCOL-1, Math.floor((ll[0] + 180)/RES)));
  const c = u !== undefined && ctry[u] !== NONE && (f < 0 || featOf[ctry[u]] === f) ? ctry[u] : f >= 0 && firmsOf.has(f) ? firmsOf.get(f) : -1;
  if(c >= 0) selectCountry(c);
  else if(f >= 0) toast(`No fire detections on record for ${feats[f].properties.name}.`);
});
cv.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); pinch = null; noClick = pointers.size > 0; endGesture(); });
cv.addEventListener('dblclick', () => { if(drawMode === 'poly') finishPolygon(); });
cv.addEventListener('pointerleave', () => { tip.hidden = true; });
cv.addEventListener('wheel', e => {
  e.preventDefault(); fly = null; spin = false; lastWheel = performance.now();
  const [x, y] = local(e), ll = isFlat() ? lonLat(x, y) : null;
  setZoom(clamp(zoom*Math.exp(-e.deltaY*0.0015), 0.8, 60));
  if(ll && isFlat()) anchor(ll, x, y);   // flat map: zoom toward the cursor
  dirty = true;
}, {passive:false});
document.addEventListener('pointermove', e => {
  if(e.target === cv) return;
  const el = e.target.closest && e.target.closest('[data-tip]');
  if(el) showTip(el.dataset.tip, e.clientX, e.clientY); else tip.hidden = true;
});

/* ---------- selection: the server cuts the area on its 0.05 degree grid and returns every month ---------- */
function request(extra, path = 'api/calendar'){
  const s = state.sel;
  if(s.polygon) return [path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({polygon:s.polygon, ...extra})}];
  return [path + '?' + new URLSearchParams({...(s.kind === 'box' ? {bbox:[s.box.w, s.box.s, s.box.e, s.box.n].join(',')} : {country:s.kind === 'world' ? 'World' : s.name}), ...extra}), {}];
}
let selSeq = 0;
const KIND = {world:'Whole planet', country:'Country', box:'Box', polygon:'Drawn area'};
function select(sel, where){
  sel.id = ++selSeq; state.sel = sel; spin = false; liveArea = null;
  if(where) goTo(where);
  $('pKind').textContent = sel.kind === 'state' ? `State or province, ${sel.country}` : KIND[sel.kind];
  $('pName').textContent = sel.name; $('mapTitle').textContent = sel.kind === 'world' ? '' : sel.name;
  if(sel.kind !== 'country' && sel.kind !== 'state') $('stateWrap').hidden = true;
  bump(); saveHash();   // the selection outline is on the base map
  loadLive(); loadLook();
  return loadMonths();
}
async function loadMonths(){
  const sel = state.sel; $('panel').classList.add('busy');
  try {
    const r = await api(...request(mParam()));
    if(state.sel !== sel) return;
    months = r.months; renderStatic(); renderTime();
    if(sel.polygon && r.polygon_exact === false) toast('Exact shapes are not available on this server. The surrounding box was used.');
  } catch(err){
    if(err.status === 409 && HAS.night){ HAS.night = false; syncTimeControls(); return loadMonths(); }   // old data: no day and night split
    if(state.sel === sel) toast('Could not load this area: ' + err.message);
  } finally { if(state.sel === sel) $('panel').classList.remove('busy'); }
}
function loadLive(){
  if(!HAS.live) return;
  const sel = state.sel, tm = state.time;
  api(...request(lParam(), 'api/live')).then(l => { if(state.sel === sel && state.time === tm){ liveArea = l; renderAnswer(); renderLook(); legend(); dirty = true; } })
    .catch(() => { if(state.sel === sel && state.time === tm){ liveArea = false; renderAnswer(); } });   // the answer works without it
}
function loadLook(){
  lookList = null; lookAll = false; renderLook();
  if(!HAS.live) return;
  const sel = state.sel, tm = state.time;
  api(...request(lParam(), 'api/live/places')).then(r => { if(state.sel === sel && state.time === tm){ lookList = Array.isArray(r.places) ? r.places : null; lookFrom = r; renderLook(); } })
    .catch(() => {});
}
function selectCountry(c){
  $('q').value = COUNTRIES[c]; toast('');
  const us = byCountry[c], b = meta.boxes[COUNTRIES[c]];
  const p = select({kind:'country', name:COUNTRIES[c], c}, us.length ? frame(us.map(u => [lonD[u], latD[u]])) : b ? frameBox(b) : null);
  fillStates(c, '');
  return p;
}
async function statesOf(c){   // states of one country, from the API, cached
  if(ctryStates.has(c)) return ctryStates.get(c);
  const name = COUNTRIES[c], b = meta.boxes[name];
  if(!HAS.states || statesOff || !b) return null;
  try {
    const all = (await api('api/states?' + new URLSearchParams({bbox:b.join(',')}))).states || [];
    all.forEach(addState);
    let mine = all.filter(s => s.country === name);
    if(!mine.length) mine = all.filter(s => { const f = countryAt((s.bbox[0] + s.bbox[2])/2, (s.bbox[1] + s.bbox[3])/2); return f >= 0 && firmsOf.get(f) === c; });   // names differ between sources
    mine = mine.map(s => stateMap.get(s.country + '|' + s.name) || s).sort((p, q) => p.name.localeCompare(q.name));
    ctryStates.set(c, mine); return mine;
  } catch(err){ if(err.status === 404) statesOff = true; return null; }
}
async function fillStates(c, pick){
  $('stateWrap').hidden = true;
  if(c < 0) return;
  const list = await statesOf(c);
  if(!list || !list.length || state.sel.c !== c) return;
  $('stateSel').innerHTML = '<option value="">Whole country</option>' + list.map((s, i) => `<option value="${i}">${esc(s.name)}</option>`).join('');
  const i = list.findIndex(s => s.name === pick); $('stateSel').value = i >= 0 ? String(i) : '';
  $('stateWrap').hidden = false;
}
function selectState(st){
  let c = COUNTRIES.indexOf(st.country);
  if(c < 0){ const f = countryAt((st.bbox[0] + st.bbox[2])/2, (st.bbox[1] + st.bbox[3])/2); c = f >= 0 && firmsOf.has(f) ? firmsOf.get(f) : -1; }
  $('q').value = c >= 0 ? COUNTRIES[c] : ''; toast('');
  const p = select({kind:'state', name:st.name, country:c >= 0 ? COUNTRIES[c] : st.country, c, polygon:st.geometry, bbox:st.bbox}, frameBox(st.bbox));
  fillStates(c, st.name);
  return p;
}
const side = (v, pos, neg) => `${Math.abs(v)}°${v < 0 ? neg : pos}`;
function selectBox(box, name){
  if(!(box.w < box.e)){ toast('West must be less than East. Boxes across the date line are not supported.'); return; }
  $('bN').value = box.n; $('bS').value = box.s; $('bW').value = box.w; $('bE').value = box.e; $('q').value = ''; toast('');
  return select({kind:'box', name:name || `${side(box.s,'N','S')} to ${side(box.n,'N','S')}, ${side(box.w,'E','W')} to ${side(box.e,'E','W')}`, label:name, box},
         frameBox([box.w, box.s, box.e, box.n]));
}
function finishPolygon(){
  if(poly.length < 3) return;
  const ring = poly.map(p => [+p[0].toFixed(3), +p[1].toFixed(3)]); ring.push(ring[0]);
  setDrawMode(null); $('q').value = '';
  select({kind:'polygon', name:'Drawn area', polygon:{type:'Polygon', coordinates:[ring]}}, frame(ring));
}
function clearPlace(){
  $('q').value = ''; toast('');
  flyTo(projection.rotate()[0], -20, 1);
  select({kind:'world', name:'Earth'}, null).then(() => { spin = !reduced; });
}
function howto(){
  $('howto').textContent = drawMode === 'box' ? 'Drag a rectangle over the area you want.' : drawMode === 'poly' ? 'Click the corners of the area. Double-click or press Finish shape to close it.'
    : isFlat() && stateMap.size ? 'Drag to move. Scroll to zoom. Click a state to choose it.' : 'Drag to spin. Scroll to zoom. Click a country to fly in.';
}
function setDrawMode(mode){
  drawMode = mode; poly = []; cv.classList.toggle('drawing', !!mode); $('polyDone').hidden = true;
  $('boxDraw').setAttribute('aria-pressed', mode === 'box'); $('polyDraw').setAttribute('aria-pressed', mode === 'poly');
  howto(); dirty = true;
}
function boxFromRect(r){
  const x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1), y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1);
  if(x1 - x0 < 6 || y1 - y0 < 6) return;
  const pts = [];
  for(let i=0;i<=8;i++) for(let j=0;j<=8;j++){ const ll = lonLat(x0 + (x1 - x0)*i/8, y0 + (y1 - y0)*j/8); if(ll) pts.push(ll); }
  if(pts.length < 4){ toast('Draw the rectangle over the map itself.'); return; }
  const c0 = pts[(pts.length/2)|0][0], rel = pts.map(p => ((p[0] - c0 + 540) % 360) - 180), snap = v => Math.round(v*20)/20;
  selectBox({s:snap(d3.min(pts, p => p[1])), n:snap(d3.max(pts, p => p[1])), w:snap(c0 + d3.min(rel)), e:snap(c0 + d3.max(rel))});
}

/* ---------- words ---------- */
const LEVEL = {well_above:['▲','up','Much higher than normal'], above:['▲','up','Higher than normal'], near:['●','flat','Normal'],
               below:['▼','down','Lower than normal'], well_below:['▼','down','Much lower than normal']};
const ratioLevel = r => r >= 2 ? 'well_above' : r >= 1.25 ? 'above' : r > 0.8 ? 'near' : r > 0.5 ? 'below' : 'well_below';
function ratioText(r, noun){   // never "0.9x": times when clearly more, percent otherwise
  if(!isFinite(r)) return '';
  if(r >= 1.5) return `${r >= 10 ? r.toFixed(0) : r.toFixed(1)} times a normal ${noun}`;
  if(r >= 1.05) return `${Math.round(100*(r - 1))} % above normal for ${noun}`;
  if(r > 0.95) return `About normal for ${noun}`;
  return `${Math.round(100*(1 - r))} % below normal for ${noun}`;
}
const unitWord = () => state.harm ? 'adjusted detections' : 'detections as reported';
const srcWord = x => ({terra_scaled:'Counted by the older satellite (less certain)', aqua:'Counted by the reference satellite'})[x.source] || 'Counted by the newer satellites, adjusted so all years compare';

/* ---------- answer ---------- */
const cal = $('cal'), Wv = 360, L = 38, Rm = 10, Tp = 8, B = 20, iw = Wv - L - Rm, sfmt = d3.format('~s');
let calColor = [], calTip = [];
for(const id of ['yFrom','yTo','pYear']) for(const y of YEARS) $(id).add(new Option(y, y));
MONTHS.forEach((m, i) => $('pMonth').add(new Option(m, i)));
$('yFrom').value = YEARS[0]; $('yTo').value = YEARS.at(-1);
$('tRange').max = T - 1;
$('eras').innerHTML = `<span class="era e0" style="flex:${AQUA}" data-tip="Before August 2002 only an older satellite flew. Its counts are scaled to the reference satellite. Less certain.">Older satellite (less certain)</span>`
  + `<span class="era e1" style="flex:${MODEL - AQUA}" data-tip="The reference satellite, as measured. Every other year is adjusted to it.">Reference satellite</span>`
  + `<span class="era e2" style="flex:${T - MODEL}" data-tip="From 2022 the newer satellites carry the record. Their detections are adjusted to what the reference satellite would have seen.">Newer satellite (adjusted)</span>`;
const yearRange = () => { const a = +$('yFrom').value, b = +$('yTo').value; return [Math.min(a, b), Math.max(a, b)]; };
const tipOf = t => { const m = months[t]; let s = `${MON[monOf(t)]} ${yearOf(t)}: ${fmt(S[t])} ${unitWord()}`;
  if(state.harm && m.low !== m.high) s += `\nlikely ${fmt(m.low)} to ${fmt(m.high)}`;
  return s; };
const medOf = mo => (months && months[firstOf(mo)] && months[firstOf(mo)].median) || 0;

function renderStatic(){
  const harm = state.harm, anom = state.view === 'anom';
  S = Float64Array.from(months, m => harm ? m.harmonized : rawTotal(m));
  $('rawNote').hidden = harm;
  const med = d3.range(12).map(mo => harm ? medOf(mo) : d3.median(d3.range(T).filter(t => monOf(t) === mo), t => S[t]) || 0);
  const smax = d3.max(S) || 0;
  calColor = []; calTip = [];
  for(let t=0;t<T;t++){
    const v = S[t], md = med[monOf(t)]; let col = '', txt = tipOf(t);
    if(anom){ if(v >= 3 || md >= 3){ const r = (v + 1)/(md + 1); col = lut(divLUT, anomU(r)); txt += `\n${ratioText(r, MONTHS[monOf(t)])} (${fmt(md)})`; } }
    else if(smax > 0 && v/smax > 0.0005) col = lut(seqLUT, Math.sqrt(v/smax));
    calColor[t] = col; calTip[t] = txt;
  }
  $('calUnit').textContent = anom ? 'each month against normal for that month' : unitWord() + ' per month';
  $('calRamp').className = 'ramp ' + (anom ? 'div' : 'seq');
  $('calLo').textContent = anom ? 'Lower than normal' : 'Fewer'; $('calHi').textContent = anom ? 'Higher than normal' : 'More';
  renderCalendar(); renderYears(); renderCheck();
}

function renderCalendar(){
  const [a, b] = yearRange(), tot = YEARS.map(y => d3.sum(d3.range(12), m => S[tOf(y, m)] || 0)), tmax = d3.max(tot) || 1;
  const firstViirs = months.findIndex(m => m.raw.n20 + m.raw.snpp > 0);
  cal.className = state.cal === 'grid' ? 'cal' : 'cal rings';
  if(state.cal === 'rings'){
    const Rr = 180, r0 = 26, dr = (Rr - 18 - r0)/YEARS.length, arc = d3.arc();
    let h = `<svg viewBox="${-Rr} ${-Rr} ${2*Rr} ${2*Rr}" role="img" aria-label="Fire rings: one ring per year, months around like a clock">`;
    YEARS.forEach((y, i) => { for(let m=0;m<12;m++){ const t = tOf(y, m); if(t < 0 || t >= T) continue;
      h += `<path data-t="${t}" class="${t === state.t ? 'now' : ''}" fill="${calColor[t] || C['surface-2']}" data-tip="${calTip[t]}" d="${arc({innerRadius:r0 + i*dr, outerRadius:r0 + (i + 1)*dr - 0.5, startAngle:m*Math.PI/6 + 0.01, endAngle:(m + 1)*Math.PI/6 - 0.01})}"/>`; } });
    MON.forEach((mn, m) => { const an = (m + .5)*Math.PI/6; h += `<text x="${Math.sin(an)*(Rr - 8)}" y="${-Math.cos(an)*(Rr - 8) + 3}" text-anchor="middle">${mn}</text>`; });
    cal.innerHTML = h + `<text text-anchor="middle" y="-2">${YEARS[0]}</text><text text-anchor="middle" y="9">inside</text></svg>`;
    return;
  }
  let h = '<div class="cal-row head"><span></span>' + MON.map(m => `<span>${m[0]}</span>`).join('') + '<span>Year</span></div>';
  YEARS.forEach((y, i) => {
    if(state.harm && y === yearOf(MODEL)) h += `<div class="era-mark">${y}: the newer satellites take over, adjusted so all years compare</div>`;
    if(!state.harm && firstViirs >= 0 && y === yearOf(firstViirs)) h += `<div class="era-mark">${y}: a newer satellite starts and sees more small fires</div>`;
    h += `<div class="cal-row${y < a || y > b ? ' out' : ''}"><span class="cal-y">${y}</span>`;
    for(let m=0;m<12;m++){ const t = tOf(y, m);
      h += t < 0 || t >= T ? '<div class="cell none"></div>' : `<div class="cell${t === state.t ? ' now' : ''}" data-t="${t}" data-tip="${calTip[t]}" style="background:${calColor[t]}"></div>`; }
    h += `<div class="cal-bar" data-tip="${y}: ${fmt(tot[i])} ${unitWord()}"><i style="width:${100*tot[i]/tmax}%"></i></div></div>`;
  });
  cal.innerHTML = h;
}
cal.addEventListener('click', e => { const c = e.target.closest('[data-t]'); if(c){ setPlaying(false); setT(+c.dataset.t); } });

// Past years whose months so far were closest to the latest year (distance on log counts).
function similarYears(){
  const Y = yearOf(T-1), Lm = monOf(T-1), vec = y => d3.range(Lm + 1).map(m => tOf(y, m)).filter(t => t >= 0).map(t => Math.log1p(months[t].harmonized)), cur = vec(Y);
  if(cur.length < 3 || d3.sum(cur) < 5) return [];
  return YEARS.filter(y => y < Y && vec(y).length === cur.length).map(y => [y, d3.sum(vec(y), (v, i) => (v - cur[i])**2)]).sort((p, q) => p[1] - q[1]).slice(0, 3).map(d => d[0]);
}

function syncWhen(){
  const pick = !state.live && (state.pick || state.t !== T-1);
  $('wLive').setAttribute('aria-pressed', state.live);
  $('wLatest').setAttribute('aria-pressed', !state.live && !pick);
  $('wPick').setAttribute('aria-pressed', pick);
  $('pickWrap').hidden = !pick;
  $('pYear').value = yearOf(state.t); $('pMonth').value = monOf(state.t);
}

function renderTime(){
  const t = state.t;
  $('readout').textContent = state.live ? 'Last 7 days' : `${MONTHS[monOf(t)]} ${yearOf(t)}`;
  $('tRange').value = t;
  $('sensorNow').textContent = state.live ? 'Newer satellite, first numbers' + (state.harm ? ', adjusted' : ', as reported')
    : state.harm ? (t < AQUA ? 'Older satellite (less certain)' : t < MODEL ? 'Reference satellite' : 'Newer satellite (adjusted)')
    : 'Counts as reported' + (months && months[t].raw.n20 + months[t].raw.snpp > 0 ? ', newer satellites included' : '');
  syncWhen(); legend(); dirty = true;
  if(!months) return;
  cal.querySelectorAll('.now').forEach(el => el.classList.remove('now'));
  const now = cal.querySelector(`[data-t="${t}"]`); if(now) now.classList.add('now');
  renderAnswer();
  saveHash();
}

function liveWeek(){   // the last 7 days against a normal week of the same calendar month
  if(!liveArea || !months) return null;
  const to = new Date(liveArea.to + 'T00:00:00Z'); if(isNaN(to)) return null;
  const lm = to.getUTCMonth(), days = new Date(Date.UTC(to.getUTCFullYear(), lm + 1, 0)).getUTCDate();
  const ok = state.harm && (state.time === 'all' || HAS.night);   // a night-only week needs a night-only normal
  return {n:state.harm ? liveArea.harmonized : liveArea.raw, normal:ok ? medOf(lm)*7/days : null, lm};
}
function setStatus(icon, dir, level, line, src){
  $('stIcon').textContent = icon; $('stIcon').className = 'v-icon ' + dir; $('status').className = 'status ' + dir;
  $('stLevel').textContent = level; $('stLine').textContent = line; $('stSrc').textContent = src;
}
function renderAnswer(){
  if(!months || !S) return;
  const t = state.t, m = monOf(t), yr = yearOf(t), x = months[t], cur = S[t], lw = liveWeek(), tm = {all:'', day:'Day fires only. ', night:'Night fires only. '}[state.time];
  $('pSub').textContent = state.live ? (liveArea ? `Last 7 days, up to ${dShort(liveArea.to)}` : 'Last 7 days') : `${MONTHS[m]} ${yr}`;
  if(state.live){
    const src = liveArea ? `${tm}First numbers from the newer satellite. They can change.` : '';
    if(liveArea === false) setStatus('●', 'flat', 'Last 7 days', 'The last 7 days could not be loaded.', '');
    else if(!lw) setStatus('●', 'flat', 'Last 7 days', 'Loading the last 7 days…', '');
    else if(lw.normal == null) setStatus('●', 'flat', 'Last 7 days', `${fmt(lw.n)} ${unitWord()}.`, src + (state.harm ? ' No normal week to compare with for this choice yet.' : ' Counts as reported.'));
    else if(lw.normal < 1 && lw.n < 5) setStatus('●', 'flat', 'Off season', `Hardly any fire in a normal ${MONTHS[lw.lm]} week here.`, src);
    else { const r = lw.n/Math.max(lw.normal, 1), L = LEVEL[ratioLevel(r)]; setStatus(L[0], L[1], L[2], ratioText(r, `${MONTHS[lw.lm]} week`) + '.', src); }
  } else if(!state.harm){
    setStatus('●', 'flat', 'Counts as reported', `${fmt(cur)} fire detections in ${MONTHS[m]} ${yr}.`, 'These counts cannot be compared across years. Choose "Comparable across years" under Advanced for a verdict.');
  } else if(d3.max(S) < 1){
    setStatus('', 'flat', 'No fires on record', `Nothing on record in this area since ${Y0}.`, '');
  } else {
    const n = months.filter((_, i) => monOf(i) === m).length;
    const src = `${tm}${srcWord(x)}${x.low !== x.high ? `. Likely ${fmt(x.low)} to ${fmt(x.high)}` : ''}. ${fmt(cur)} ${unitWord()}, ${ordinal(x.rank)} highest of ${n} ${MONTHS[m]}s on record.`
      + (x.filled >= 1 ? ` Includes ${fmt(x.filled)} for days when the reference satellite did not record.` : '');
    if(x.anomaly === 'insufficient' && cur < 5) setStatus('●', 'flat', 'Off season', `Hardly any fire in a normal ${MONTHS[m]} here.`, src);
    else if(x.anomaly === 'insufficient') setStatus('▲', 'up', 'Higher than normal', `${fmt(cur)} fire detections in a month that is usually quiet here.`, src);
    else { const L = LEVEL[x.anomaly] || ['●', 'flat', 'Normal']; setStatus(L[0], L[1], L[2], ratioText(cur/Math.max(x.median, 1), MONTHS[m]) + '.', src); }
  }

  const sm = lastSeason = seasonModel(t), tl = [];
  if(HAS.live && liveArea !== false) tl.push(['Last 7 days', lw ? fmt(lw.n) : '…', lw && lw.normal != null ? `${unitWord()}. A normal ${MONTHS[lw.lm]} week has about ${fmt(lw.normal)}.` : unitWord()]);
  tl.push([t === T-1 ? `This month (${MON[m]} ${yr})` : `${MONTHS[m]} ${yr}`, fmt(cur), state.harm ? `${unitWord()}. Normal is about ${fmt(x.median)}.` : unitWord()]);
  tl.push(['Season so far', sm && sm.ratio != null ? pct(sm.ratio) : '–', sm && sm.ratio != null ? `of a normal season, since ${MON[sm.start]} ${yearOf(sm.t0)}` : 'Too early in the season to tell']);
  lastTiles = tl;
  $('tiles').innerHTML = tl.map(([a, v, s]) => `<div class="tile"><span class="t-name">${esc(a)}</span><span class="t-val">${esc(v)}</span><span class="t-sub">${esc(s)}</span></div>`).join('');

  const ex = [];
  if(state.live && liveArea){
    if(liveArea.night_share != null) ex.push(`<p><b>Night fires:</b> ${pct(liveArea.night_share)} of detections in the last 7 days.</p>`);
    if(liveArea.strong != null) ex.push(`<p><b>Strong fires:</b> ${fmt(liveArea.strong)} of ${fmt(liveArea.raw)} detections in the last 7 days.</p>`);
  }
  if(!state.live && state.harm){
    if(state.time === 'all' && x.night != null && x.harmonized > 0)
      ex.push(`<p><b>Night fires:</b> ${pct(x.night/x.harmonized)} of detections this month${x.night_median != null && x.median > 0 ? ` (normal ${pct(x.night_median/x.median)})` : ''}.</p>`);
    if(x.frp != null && x.frp_median > 0) ex.push(`<p><b>Fire strength:</b> ${(x.frp/x.frp_median).toFixed(1)} times normal for this month.</p>`);
  }
  const like = state.harm && state.time === 'all' ? similarYears() : [];
  if(like.length) ex.push(`<p>${yearOf(T-1)} so far looks most like ${like.join(', ')}.</p>`);
  $('extra').innerHTML = ex.join(''); $('extraSec').hidden = !ex.length;
  renderSeason(sm);
}

function renderLook(){
  const P = lookList;
  $('lookSec').hidden = !(P && P.length);
  if(!P || !P.length) return;
  $('lookSub').textContent = `Last 7 days${lookFrom && lookFrom.to ? `, up to ${dShort(lookFrom.to)}` : ''}. Most urgent first.`;
  const sr = liveArea ? liveArea.static_removed : null;
  $('lookNote').textContent = sr > 0 ? `${fmt(sr)} detections at industrial heat sources are left out.`
    : meta.static_mask === false ? 'Industrial heat sources are not filtered in this data set.' : '';
  $('lookNote').hidden = !$('lookNote').textContent;
  $('look').innerHTML = (lookAll ? P : P.slice(0, 5)).map((p, i) => `<li><button type="button" data-i="${i}"${/permanent heat source/.test(p.why || '') ? ' class="perm"' : ''}><span class="l-name">${esc(p.label || coord(p.lon, p.lat))}</span>`
    + (p.why ? `<span class="l-why">${esc(p.why)}</span>` : '') + `<span class="l-n">${fmt(p.detections)} fire detection${p.detections === 1 ? '' : 's'}</span></button></li>`).join('');
  $('lookMore').hidden = lookAll || P.length <= 5;
  $('lookMore').textContent = `Show all ${P.length}`;
}
$('lookMore').onclick = () => { lookAll = true; renderLook(); };
$('look').addEventListener('click', e => {
  const b = e.target.closest('button[data-i]'), p = b && lookList && lookList[+b.dataset.i]; if(!p) return;
  setPlaying(false); goTo({lon:p.lon, lat:p.lat, rad:0}); if(!state.live) setLive(true);
});

// The fire year of the area starts after its quietest calendar month. The selected season is compared, as a running
// total, with the running totals of the baseline fire years.
function seasonModel(t){
  const Hh = months.map(m => m.harmonized), meds = d3.range(12).map(medOf);
  if(!(d3.max(Hh) > 0)) return null;
  const start = (meds.indexOf(d3.min(meds)) + 1) % 12, k = (monOf(t) - start + 12) % 12, t0 = t - k;
  const cum = b0 => { let s = 0; return d3.range(12).map(i => { const tt = b0 + i; if(tt < 0 || tt >= T) return NaN; s += Hh[tt]; return s; }); };
  const curves = BASE.map(y => tOf(y, start)).filter(b => b >= 0 && b + 11 < T).map(cum);
  const q = p => d3.range(12).map(i => d3.quantile(curves.map(c => c[i]).sort(d3.ascending), p) || 0);
  const q50 = q(.5), cur = cum(t0).map((v, i) => i <= k ? v : NaN);
  return {start, k, t0, cur, q10:q(.1), q50, q90:q(.9), ratio:t0 >= 0 && q50[k] >= 5 ? cur[k]/q50[k] : null};
}
function renderSeason(sm){
  if(!sm){ $('season').innerHTML = '<p class="hint">No fires on record here.</p>'; $('seasonSpan').textContent = ''; return; }
  const Hv = 132, ih = Hv - Tp - B, ok = d => !isNaN(d), lab = i => MON[(sm.start + i) % 12];
  const sc = d3.scaleLinear().domain([0, Math.max(1, d3.max(sm.q90), d3.max(sm.cur.filter(ok)) || 0)]).nice(3).range([Tp + ih, Tp]);
  const x = i => L + iw*i/11, line = d3.line().defined(ok).x((d, i) => x(i)).y(d => sc(d)), area = d3.area().x((d, i) => x(i)).y0((d, i) => sc(sm.q10[i])).y1((d, i) => sc(sm.q90[i]));
  const fy = sm.start === 0 ? `${yearOf(sm.t0)}` : `${yearOf(sm.t0)}–${String(yearOf(sm.t0) + 1).slice(2)}`;
  let h = `<svg viewBox="0 0 ${Wv} ${Hv}" role="img" aria-label="Fire detections added up since ${MONTHS[sm.start]}, this season against a normal season">`;
  sc.ticks(3).forEach(v => { h += `<line class="grid" x1="${L}" x2="${Wv-Rm}" y1="${sc(v)}" y2="${sc(v)}"/><text class="axis" x="${L-6}" y="${sc(v)+4}" text-anchor="end">${sfmt(v)}</text>`; });
  d3.range(12).forEach(i => { h += `<text class="axis" x="${x(i)}" y="${Hv-5}" text-anchor="middle">${lab(i)[0]}</text>`; });
  h += `<path class="band" d="${area(sm.q50)}"/><path class="med" d="${line(sm.q50)}"/><path class="cur" d="${line(sm.cur)}"/>`;
  if(ok(sm.cur[sm.k])) h += `<circle class="dot" cx="${x(sm.k)}" cy="${sc(sm.cur[sm.k])}" r="4.5"/>`;
  d3.range(12).forEach(i => { h += `<rect class="hit" x="${x(i)-iw/22}" y="${Tp}" width="${iw/11}" height="${ih}" data-tip="To the end of ${lab(i)}&#10;This season: ${ok(sm.cur[i]) ? fmt(sm.cur[i]) : 'not yet'}&#10;Normal: ${fmt(sm.q50[i])}&#10;8 of 10 seasons: ${fmt(sm.q10[i])} to ${fmt(sm.q90[i])}"/>`; });
  $('season').innerHTML = h + '</svg>';
  $('seasonSpan').textContent = `added up since ${MONTHS[sm.start]}`;
  $('keyYear').textContent = `This season (${fy})`;
}

// "Small fires": newer-satellite detections per adjusted detection, per calendar month, learned in the years of the newer
// satellite and applied to every year. The spread of the yearly factors gives the range.
function ghostModel(){
  const key = months.some(m => m.raw.snpp) ? 'snpp' : 'n20', seen = months.map((m, t) => [m, t]).filter(([m]) => m.raw[key] > 0 && m.harmonized > 0);
  const sum = (a, f) => d3.sum(a, f), hs = a => sum(a, ([m]) => m.harmonized);
  if(hs(seen) < 200) return null;
  const all = sum(seen, ([m]) => m.raw[key])/hs(seen), k = d3.rollup(seen, v => sum(v, ([m]) => m.raw[key])/hs(v), ([, t]) => monOf(t));
  const yearly = d3.rollups(seen, v => v.length >= 6 ? sum(v, ([m]) => m.raw[key])/hs(v)/all : NaN, ([, t]) => yearOf(t)).map(d => d[1]).filter(isFinite);
  return {k, all, lo:d3.min(yearly) ?? 1, hi:d3.max(yearly) ?? 1};
}
function renderYears(){
  const Hv = 140, ih = Hv - Tp - B, [a, b] = yearRange(), ys = YEARS.filter(y => y >= a && y <= b), harm = state.harm;
  const gm = state.ghost && harm ? ghostModel() : null;
  const rows = ys.map(y => { const ts = d3.range(12).map(m => tOf(y, m)).filter(t => t >= 0 && t < T), ms = ts.map(t => months[t]);
    return {y, n:ms.length, harm:d3.sum(ms, m => m.harmonized), low:d3.sum(ms, m => m.low), high:d3.sum(ms, m => m.high), src:ms.at(-1).source,
            raw:Object.fromEntries(Object.keys(SENSOR).map(k => [k, d3.sum(ms, m => m.raw[k])])),
            ghost:gm ? d3.sum(ts, t => months[t].harmonized*(gm.k.get(monOf(t)) ?? gm.all)) : 0}; });
  const top = d3.max(rows, r => harm ? Math.max(r.high, r.ghost*(gm ? gm.hi : 1)) : d3.sum(Object.values(r.raw))) || 1;
  const sc = d3.scaleLinear().domain([0, top]).nice(3).range([Tp + ih, Tp]), bw = iw/rows.length, x = i => L + i*bw;
  let h = `<svg viewBox="0 0 ${Wv} ${Hv}" role="img" aria-label="Fire detections per year">`;
  sc.ticks(3).forEach(v => { h += `<line class="grid" x1="${L}" x2="${Wv-Rm}" y1="${sc(v)}" y2="${sc(v)}"/><text class="axis" x="${L-6}" y="${sc(v)+4}" text-anchor="end">${sfmt(v)}</text>`; });
  rows.forEach((r, i) => {
    if(r.y % 5 === 0) h += `<text class="axis" x="${x(i) + bw/2}" y="${Hv-5}" text-anchor="middle">${r.y}</text>`;
    const rect = (cls, v0, v1, tipText) => `<rect class="${cls}" x="${x(i) + 1}" width="${Math.max(1, bw - 2)}" y="${sc(v1)}" height="${Math.max(0, sc(v0) - sc(v1))}" data-tip="${tipText}"/>`;
    if(harm){
      const part = r.n < 12 ? ` (${r.n} months)` : '';
      if(gm && r.ghost > r.harm) h += rect('bar-ghost', r.harm, r.ghost, `${r.y}: with small fires, about ${fmt(r.ghost)} detections&#10;likely ${fmt(r.ghost*gm.lo)} to ${fmt(r.ghost*gm.hi)}. Estimate only.`);
      h += rect(r.src === 'aqua' ? 'bar-aqua' : r.src === 'terra_scaled' ? 'bar-terra' : 'bar-viirs', 0, r.harm, `${r.y}${part}: ${fmt(r.harm)} adjusted detections` + (r.high > r.low ? `&#10;likely ${fmt(r.low)} to ${fmt(r.high)}` : ''));
      if(r.high > r.low) h += `<line class="whisk" x1="${x(i) + bw/2}" x2="${x(i) + bw/2}" y1="${sc(r.low)}" y2="${sc(r.high)}"/>`;
    } else { let base = 0; const all = Object.keys(SENSOR).filter(k => r.raw[k]).map(k => `${PLAIN[k]}: ${fmt(r.raw[k])}`).join('&#10;');
      for(const k of Object.keys(SENSOR)){ if(!r.raw[k]) continue; h += rect('bar-' + k, base, base + r.raw[k], `${r.y}&#10;${all}`); base += r.raw[k]; } }
  });
  $('years').innerHTML = h + '</svg>';
  const sq = (c, tx) => `<span><span class="sq" style="background:${c}"></span>${tx}</span>`;
  $('yearsUnit').textContent = harm ? 'adjusted detections' : 'as reported, all satellites';
  $('yearsKey').innerHTML = harm ? sq(C.cool, 'Older satellite (less certain)') + sq(C.accent, 'Reference satellite') + sq(C['fire-mid'], 'Newer satellite (adjusted)') + '<span>White line: likely range</span>'
    : sq(C.cool, PLAIN.terra) + sq(C.accent, PLAIN.aqua) + sq('#c9662b', PLAIN.snpp) + sq(C['fire-mid'], PLAIN.n20) + '<span>The jump is the new satellite, not more fire.</span>';
  $('ghostNote').hidden = !state.ghost;
  $('ghostNote').textContent = !state.ghost ? '' : !harm ? 'Choose "Comparable across years" under Advanced to see this estimate.' : !gm ? 'Too few detections by the newer satellites in this area for an estimate.'
    : `Dashed bars: about how many detections there would be in every year if small fires were counted too, with the same share as in recent years (about ${gm.all.toFixed(1)} per adjusted detection here). An estimate: in single years the factor was ${d3.format('+.0%')(gm.lo - 1)} to ${d3.format('+.0%')(gm.hi - 1)} from its average.`;
}

// Sensor check: in the years both flew, adjusted VIIRS should land on top of measured Aqua.
// The adjusted values shown here come from tables fitted without the year they are compared in.
function renderCheck(){
  const Hv = 120, ih = Hv - Tp - B, t0 = tAt(SAT.window[0]), t1 = Math.min(T-1, tAt(SAT.window[1])), ts = d3.range(t0, t1 + 1), n = ts.length;
  const aq = ts.map(t => months[t].raw.aqua), cv2 = ts.map(t => months[t].pred[PKEY]), rw = ts.map(t => months[t].raw[PKEY]);
  const sc = d3.scaleLinear().domain([0, Math.max(1, d3.max(aq), d3.max(cv2))]).nice(3).range([Tp + ih, Tp]);
  const x = i => L + iw*i/(n - 1), line = d3.line().x((d,i) => x(i)).y(d => sc(d));
  let h = `<svg viewBox="0 0 ${Wv} ${Hv}" role="img" aria-label="Monthly detections: Aqua measured and VIIRS adjusted">`;
  sc.ticks(3).forEach(v => { h += `<line class="grid" x1="${L}" x2="${Wv-Rm}" y1="${sc(v)}" y2="${sc(v)}"/><text class="axis" x="${L-6}" y="${sc(v)+4}" text-anchor="end">${sfmt(v)}</text>`; });
  ts.forEach((t, i) => { if(monOf(t) === 0) h += `<text class="axis" x="${x(i)}" y="${Hv-5}" text-anchor="middle">${yearOf(t)}</text>`; });
  h += `<path class="cur" d="${line(aq)}"/><path class="conv" d="${line(cv2)}"/>`;
  ts.forEach((t, i) => { h += `<rect class="hit" x="${x(i)-iw/(2*(n-1))}" y="${Tp}" width="${iw/(n-1)}" height="${ih}" data-tip="${MON[monOf(t)]} ${yearOf(t)}&#10;Aqua measured: ${fmt(aq[i])}&#10;VIIRS adjusted: ${fmt(cv2[i])}&#10;VIIRS as reported: ${fmt(rw[i])}"/>`; });
  $('check').innerHTML = h + '</svg>';
  $('checkSpan').textContent = `${yearOf(t0)} to ${yearOf(t1)}`;
  const tot = d3.sum(aq), err = tot ? d3.sum(aq, (v, i) => Math.abs(cv2[i] - v))/tot : NaN;
  $('checkLine').textContent = tot >= 50 ? `In the years both flew, adjusted ${SENSOR[PKEY]} is off by ${pct(err)} of the Aqua total here, month by month. Unadjusted, VIIRS reports ${(d3.sum(rw)/tot).toFixed(1)} times more.`
    : 'Too few fire detections here to compare the satellites.';
}

/* ---------- controls ---------- */
function setT(t){ state.t = clamp(t, 0, T-1); if(state.t !== T-1) state.pick = true; if(state.live) setLive(false); else renderTime(); }
function setPlaying(p){
  if(p){ setLive(false); if(state.t >= rng[1] || state.t < rng[0]) setT(rng[0]); }
  playing = p; playAcc = 0; $('play').textContent = p ? '❚❚ Pause' : `▶ Play ${yearOf(rng[0])}–${yearOf(rng[1])}`;
  if(!p) saveHash();
}
const check = (name, v) => { const r = document.querySelector(`input[name=${name}][value=${v}]`); if(r) r.checked = true; };
function setMode(harm){
  state.harm = harm; check('counts', harm ? 'harm' : 'raw');
  if(months){ renderStatic(); renderTime(); } legend(); dirty = true; saveHash();
}
function setView(view){
  if(view === 'trust' && trustOff) view = 'count';   // no confidence map on this server
  state.view = view; check('view', view);
  if(months) renderStatic(); legend(); bump(); saveHash();
}
function syncTimeControls(){
  const off = !HAS.night && !state.live;   // months can be split by day and night only with rebuilt data
  $('tDay').disabled = $('tNight').disabled = off; $('timeNote').hidden = !off;
  if(off && state.time !== 'all') setTime('all');
  check('time', state.time);
}
function setTime(v){
  if(v === state.time) return;
  state.time = v; syncTimeControls();
  if(HAS.night) loadMonths(); else if(months){ renderStatic(); renderTime(); }
  liveArea = null; loadLive(); loadLook();
  if(state.live && !liveCells.has(v)) loadCells();
  legend(); dirty = true; saveHash();
}
function loadCells(){
  const tm = state.time;
  api('api/live/cells' + (tm !== 'all' ? '?time=' + tm : '')).then(r => { liveCells.set(tm, r.cells || []); dirty = true; })
    .catch(err => { toast('The last 7 days are not available: ' + err.message); if(state.live) setLive(false); });
}
function setLive(on){
  if(on && !HAS.live) return;
  state.live = on; if(on) state.pick = false;
  syncTimeControls(); renderTime(); bump();   // the confidence map is hidden in the last 7 days
  if(on && !liveCells.has(state.time)) loadCells();
}
function legend(){
  const tm = state.live || gTime() !== 'all' ? {all:'', day:'day ', night:'night '}[state.time] : '', sq = [50, 25, 10, 5, 5][fireLevel] || 50;
  $('legend').innerHTML = state.view === 'trust' && !state.live
    ? !TR ? 'Loading the confidence map…'
      : `How far off the adjusted monthly count for an area of about ${kmOf(TR.deg)} km was in test years: ` + TRUST.map(s => `<span class="lstep"><span class="box" style="background:${s[1]}"></span>${s[2]}</span>`).join('')
        + '<span class="lstep"><span class="box hatch"></span>too few fires to test</span>'
    : state.live && fireLevel === 4 ? `Each dot is one ${tm}fire detection in the last 7 days: ` + ['weak', 'medium', 'strong'].map((w, i) => `<span class="lstep"><span class="dotk" style="background:${PTC[i]}"></span>${w}</span>`).join('')
    : state.live ? `<span>Fewer</span><span class="ramp seq"></span><span>More ${tm}fire detections in the last 7 days, per square of about 50 km</span>`
    : state.view === 'anom' ? `<span>Lower than normal</span><span class="ramp div"></span><span>Higher than normal for ${MONTHS[monOf(state.t)]}, per square of about ${sq} km</span>`
    : `<span>Fewer</span><span class="ramp seq"></span><span>More ${tm}${unitWord()} per square of about ${sq} km</span>`;
}
function toast(msg){ $('toast').textContent = msg; }
function save(blob, name){ const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
const slug = () => state.sel.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'area';

/* ---------- the view lives in the URL hash, so a link brings back the same answer ---------- */
let restoring = true, ownHash = '';   // until the hash has been read, nothing may overwrite it
function saveHash(){
  if(playing || restoring) return;
  const s = state.sel, p = new URLSearchParams();
  p.set('a', s.kind === 'world' ? 'world' : s.kind === 'country' ? 'c:' + s.name : s.kind === 'state' ? `s:${s.country}|${s.name}`
    : s.kind === 'box' ? 'b:' + [s.box.w, s.box.s, s.box.e, s.box.n].join(',') : 'p:' + s.polygon.coordinates[0].map(q => q.join(' ')).join(';'));
  if(s.kind === 'box' && s.label) p.set('n', s.label);
  p.set('t', state.live ? 'live' : ymOf(state.t)); p.set('map', state.view); p.set('only', state.time); p.set('counts', state.harm ? 'adjusted' : 'reported');
  ownHash = '#' + p;
  try { history.replaceState(null, '', ownHash); } catch(e){}
}
// Applies the whole view in the hash: on load, and when a link is pasted into an open page.
async function restore(){
  const p = new URLSearchParams(location.hash.slice(1)), a = p.get('a'); if(!a){ restoring = false; return false; }
  restoring = true;
  try {
    setPlaying(false);
    const v = p.get('map'); setView(['count', 'anom', 'trust'].includes(v) ? v : 'count');
    const harm = p.get('counts') !== 'reported'; if(harm !== state.harm) setMode(harm);
    const tt = p.get('t') || '', f = p.get('only'), live = tt === 'live' && HAS.live;
    if(/^\d{4}-\d{2}$/.test(tt)){ state.t = clamp(tAt(tt), 0, T-1); state.pick = state.t !== T-1; }
    if(live !== state.live) setLive(live);
    state.time = ['day', 'night'].includes(f) && (HAS.night || live) ? f : 'all';   // the area selection below reloads everything for it
    syncTimeControls(); if(state.live && !liveCells.has(state.time)) loadCells();
    renderTime();
    if(a === 'world'){ clearPlace(); return true; }
    if(a.startsWith('c:')){ const c = COUNTRIES.indexOf(a.slice(2)); if(c >= 0){ selectCountry(c); return true; } }
    else if(a.startsWith('s:')){
      const i = a.indexOf('|'), c = COUNTRIES.indexOf(a.slice(2, i)), sn = a.slice(i + 1);
      if(i > 2 && c >= 0){ const list = await statesOf(c), st = list && list.find(s => s.name === sn); if(st) selectState(st); else selectCountry(c); return true; }
    }
    else if(a.startsWith('b:')){ const [w, s, e, n] = a.slice(2).split(',').map(Number); if([w, s, e, n].every(isFinite) && w < e && s < n){ selectBox({w, s, e, n}, p.get('n') || undefined); return true; } }
    else if(a.startsWith('p:')){
      const ring = a.slice(2).split(';').map(q => q.split(' ').map(Number));
      if(ring.length >= 4 && ring.every(q => q.length === 2 && q.every(isFinite))){ select({kind:'polygon', name:'Drawn area', polygon:{type:'Polygon', coordinates:[ring]}}, frame(ring)); return true; }
    }
    return false;
  } finally { restoring = false; saveHash(); }
}

/* ---------- downloads ---------- */
async function downloadCsv(){
  const [a, b] = yearRange(), [url, opts] = request({...mParam(), start:`${a}-01`, end:`${b}-12`, format:'csv'});
  try { const r = await fetch(url, opts); if(!r.ok) throw new Error(r.statusText); save(await r.blob(), `firepulse_${slug()}_${a}-${b}.csv`); toast('Saved the monthly table.'); }
  catch(err){ toast('The download failed: ' + err.message); }
}
function downloadDetections(){
  const s = state.sel, [a, b] = yearRange();
  const box = s.kind === 'box' ? [s.box.w, s.box.s, s.box.e, s.box.n] : s.kind === 'state' ? s.bbox
    : s.polygon ? (r => [d3.min(r, p => p[0]), d3.min(r, p => p[1]), d3.max(r, p => p[0]), d3.max(r, p => p[1])])(ringsOf(s.polygon).flat())
    : s.kind === 'country' ? meta.boxes[s.name] : null;
  if(!box){ toast('Pick a country or an area first. The whole planet is too large for one file.'); return; }
  location.href = 'api/hotspots.csv?' + new URLSearchParams({bbox:box.join(','), start:`${a}-01-01`, end:`${b}-12-31`});
  toast('Every single fire detection in the box around the area, at most 500,000 rows.');
}
function wrapText(g, text, x, y, maxW, lh){
  let line = '';
  for(const w of String(text).split(' ')){ const t = line ? line + ' ' + w : w; if(g.measureText(t).width > maxW && line){ g.fillText(line, x, y); y += lh; line = w; } else line = t; }
  if(line){ g.fillText(line, x, y); y += lh; }
  return y;
}
function briefing(){
  if(!months){ toast('Wait until the answer has loaded.'); return; }
  draw();
  // 1000 logical px drawn at 2x; no text below 12 logical px (24 px in the image)
  const Wb = 1000, pad = 32, sc = 2, [a, b] = yearRange(), nY = b - a + 1, cw = (Wb - 2*pad - 56)/12, ch = 16;
  const look = state.live && lookList ? lookList.slice(0, 3) : [];
  const mapY = 400 + (look.length ? 40 + look.length*46 : 0);
  const mapW = 470, mapH = Math.round(clamp(mapW*H/(W || 1), 260, 400)), chartX = pad + mapW + 28, chartW = Wb - pad - chartX, chartH = 220;
  const calY = mapY + Math.max(mapH, chartH + 70) + 50, Hb = calY + 24 + nY*ch + 90;
  const c = document.createElement('canvas'); c.width = Wb*sc; c.height = Hb*sc;
  const g = c.getContext('2d'); g.scale(sc, sc);
  const font = (w, s, f) => { g.font = `${w} ${s}px ${f === 'd' ? '"Space Grotesk"' : 'Inter'}, system-ui, sans-serif`; };
  g.fillStyle = C.bg; g.fillRect(0, 0, Wb, Hb);
  g.fillStyle = C.muted; font(500, 14); g.fillText('FIRE BRIEFING', pad, 38);
  g.fillStyle = C.fg; font(600, 32, 'd'); g.fillText(state.sel.name, pad, 76);
  g.fillStyle = C.muted; font(400, 16); g.fillText(`${$('pKind').textContent}. ${$('pSub').textContent}. Made ${new Date().toISOString().slice(0, 10)}.`, pad, 102);
  g.fillStyle = C['surface-2']; g.fillRect(pad, 120, Wb - 2*pad, 138);
  const dir = $('status').className.split(' ')[1]; g.fillStyle = dir === 'up' ? C.warm : dir === 'down' ? C.cool : C.neutral; g.fillRect(pad, 120, 6, 138);
  g.fillStyle = C.fg; font(600, 28, 'd'); g.fillText(`${$('stIcon').textContent} ${$('stLevel').textContent}`.trim(), pad + 22, 158);
  font(400, 19); g.fillText($('stLine').textContent, pad + 22, 188);
  g.fillStyle = C.muted; font(400, 14); wrapText(g, $('stSrc').textContent, pad + 22, 214, Wb - 2*pad - 44, 18);
  const tw = (Wb - 2*pad - 16*(lastTiles.length - 1))/Math.max(1, lastTiles.length);
  lastTiles.forEach(([nm, v, s], i) => { const x = pad + i*(tw + 16);
    g.fillStyle = C['surface-2']; g.fillRect(x, 274, tw, 110);
    g.fillStyle = C.muted; font(400, 14); g.fillText(nm, x + 14, 298);
    g.fillStyle = C.fg; font(700, 30, 'd'); g.fillText(v, x + 14, 334);
    g.fillStyle = C.muted; font(400, 13); wrapText(g, s, x + 14, 356, tw - 28, 16); });
  if(look.length){
    g.fillStyle = C.fg; font(600, 18, 'd'); g.fillText('Where to look first', pad, 428);
    look.forEach((p, i) => { const y = 456 + i*46;
      g.fillStyle = C.fg; font(600, 15); g.fillText(`${i + 1}. ${p.label || coord(p.lon, p.lat)}`, pad, y);
      g.fillStyle = C.muted; font(400, 14); g.fillText(`${p.why || ''}${p.why ? '. ' : ''}${fmt(p.detections)} fire detections.`, pad + 20, y + 20); });
  }
  g.drawImage(cv, pad, mapY, mapW, mapH); g.strokeStyle = C.line; g.strokeRect(pad, mapY, mapW, mapH);
  const sm = lastSeason;
  g.fillStyle = C.fg; font(600, 18, 'd'); g.fillText('Season so far', chartX, mapY + 16);
  if(sm){
    const top = Math.max(1, d3.max(sm.q90), d3.max(sm.cur.filter(v => !isNaN(v))) || 0), y0 = mapY + 34, X = i => chartX + chartW*i/11, Y = v => y0 + chartH - chartH*v/top;
    g.fillStyle = 'rgba(147,160,186,.2)'; g.beginPath(); sm.q90.forEach((v, i) => g.lineTo(X(i), Y(v))); for(let i=11;i>=0;i--) g.lineTo(X(i), Y(sm.q10[i])); g.fill();
    g.strokeStyle = C.muted; g.lineWidth = 2; g.setLineDash([4, 4]); g.beginPath(); sm.q50.forEach((v, i) => g.lineTo(X(i), Y(v))); g.stroke(); g.setLineDash([]);
    g.strokeStyle = C['fire-mid']; g.beginPath(); sm.cur.forEach((v, i) => { if(!isNaN(v)) g.lineTo(X(i), Y(v)); }); g.stroke();
    g.fillStyle = C.muted; font(400, 13); g.textAlign = 'center';
    for(let i=0;i<12;i++) g.fillText(MON[(sm.start + i) % 12][0], X(i), y0 + chartH + 18);
    g.textAlign = 'left'; wrapText(g, `Orange: this season. Dashed: normal. Band: 8 of 10 seasons. Top: ${fmt(top)} adjusted detections.`, chartX, y0 + chartH + 40, chartW, 17);
  }
  g.fillStyle = C.fg; font(600, 18, 'd'); g.fillText(`Fire calendar, ${a} to ${b}`, pad, calY - 14);
  g.fillStyle = C.muted; font(400, 13); g.textAlign = 'center'; MON.forEach((m, i) => g.fillText(m, pad + 56 + i*cw + cw/2, calY + 10));
  for(let y=a; y<=b; y++){
    const yy = calY + 20 + (y - a)*ch;
    g.textAlign = 'right'; g.fillStyle = C.muted; font(400, 12); g.fillText(y, pad + 46, yy + ch - 3);
    for(let m=0;m<12;m++){ const t = tOf(y, m); if(t < 0 || t >= T) continue; g.fillStyle = calColor[t] || C['surface-2']; g.fillRect(pad + 56 + m*cw + 1, yy + 1, cw - 2, ch - 2);
      if(t === state.t){ g.strokeStyle = C.fg; g.lineWidth = 2; g.strokeRect(pad + 56 + m*cw + 1, yy + 1, cw - 2, ch - 2); } }
  }
  g.textAlign = 'left'; g.fillStyle = C.muted; font(400, 13);
  wrapText(g, 'Source: NASA FIRMS fire detections (MODIS and VIIRS), adjusted so all years compare. Clouds hide fires. The last 7 days are first numbers and can change. Made with Fire Pulse.', pad, Hb - 46, Wb - 2*pad, 18);
  c.toBlob(blob => { if(blob){ save(blob, `firepulse_briefing_${slug()}.png`); toast('Saved the briefing as an image.'); } else toast('The briefing could not be made.'); });
}
function copyLink(){
  saveHash();
  const url = location.href;
  (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => toast('Link copied.'), () => toast('Copy this link: ' + url));
}

function buildAbout(){
  const row = (label, v, pick) => `<tr class="${pick ? 'pick' : ''}"><td>${label}</td>${v.map(x => `<td>${x}</td>`).join('')}</tr>`;
  const sats = Object.entries(VAL.satellites), head = sats.map(([s, v]) => `<th>${SENSOR[s.toLowerCase()]}<br>${v.window[0].slice(0,4)}–${v.window[1].slice(0,4)}</th>`).join('');
  const line = (label, key, pick) => row(label, sats.map(([, v]) => v.overall[key] != null ? pct(v.overall[key]) : '–'), pick);
  const gaps = (VAL.aqua_gaps || []).filter(([a, b]) => (new Date(b) - new Date(a))/864e5 >= 2);
  $('aboutBody').innerHTML = `
  <h2>How Fire Pulse works</h2>
  <p>Satellites have seen the heat of fires since 2000. Each place where a satellite saw a fire is a fire detection. The record comes from two kinds of instruments. MODIS (on the Terra and Aqua satellites, 1 km pixels) is the long series and is close to retirement. VIIRS (375 m pixels, since 2012) sees many small fires that MODIS misses. Side by side, the counts jump when VIIRS starts, for no real reason. Fire Pulse adjusts all years so they compare.</p>
  <h3>The method</h3>
  <ol>
    <li><b>Same fires only.</b> Keep detections marked as vegetation fire. Drop MODIS confidence below 30 % and VIIRS "low" confidence.</li>
    <li><b>One reference.</b> Aqua MODIS passes at the same local time as VIIRS, so every number is what Aqua would have reported. These are the adjusted detections.</li>
    <li><b>Conversion tables.</b> For the years both flew, every group of VIIRS detections (same 0.05° cell, date, day or night) is matched with the Aqua pixels in that cell. The average depends on fire strength, pixel count, day or night, and region (5° tiles, falling back to 20° tiles and then the globe).</li>
    <li><b>Monthly calibration.</b> A ratio per region and calendar month adds the Aqua pixels that had no VIIRS partner and removes the seasonal difference.</li>
    <li><b>One record.</b> Terra scaled to Aqua before August 2002 (the older satellite), Aqua as measured until 2021 (the reference satellite), adjusted ${SENSOR[PKEY]} from 2022 (the newer satellite), when Aqua's orbit drifts. Days when Aqua did not record are found from the data and filled.</li>
  </ol>
  <h3>Normal, and the season</h3>
  <p>Normal for a month is the middle value of that calendar month in 2003 to 2020. The fire season of an area starts after its quietest month. "Season so far" adds up the detections since then and compares them with the same running total in 2003 to 2020.</p>
  <h3>Does it work?</h3>
  <p>Each year when both flew is hidden in turn. The tables are learned from the other years and the adjusted VIIRS is compared with real Aqua in the hidden year. Error per 5° tile and month (lower is better):</p>
  <table><tr><th>Adjustment</th>${head}</tr>
    ${line('None (VIIRS as reported)', 'raw')}${line('One global factor', 'global_factor')}${line('Monthly ratio per region', 'ratio')}${line('Conversion tables (used)', 'table', true)}
  </table>
  <p>The "compared with normal" level is the same as real Aqua's in ${pct(SAT.anomaly_agreement.table)} of tested tile-months, and the same or the next level in ${pct(SAT.anomaly_agreement.table_within_one)}.
  ${VAL.twin ? ` Two identical VIIRS instruments (Suomi NPP and NOAA-20) disagree by ${pct(VAL.twin.overlap)} after adjustment in the overlap years, and by ${pct(VAL.twin.after)} after 2021. No adjustment can beat the first number.` : ''}
  Choose "Confidence in the numbers" under Show on the map to see the error by place.</p>
  ${TR ? `<h3>The confidence map</h3>
  <p>The map splits the land into squares of about ${kmOf(TR.deg)} km. Each square shows how far the adjusted monthly count was from real Aqua in the test years ${TR.years[0]} to ${TR.years[1]}, with ${TR.satellites.map(s => SENSOR[s.toLowerCase()] || s).join(' and ')} tested together. ${TR.left_out.length ? `${TR.left_out.length} months when Aqua did not record are left out. ` : ''}Hatched squares had fewer than ${fmt(TR.min_n)} detections in those years: too few to test.</p>
  <p>The number depends on the size of the area. In a larger area the errors of small places partly cancel out, so its count is more exact. The same test for squares of other sizes:</p>
  <table><tr><th>Square of about</th><th>Monthly count off by</th></tr>${TR.by_size.map(s => row(`${fmt(kmOf(s.deg))} km`, [pct(s.err)], s.deg === TR.deg)).join('')}</table>` : ''}
  ${gaps.length ? `<p>Aqua outages found and filled: ${gaps.slice(0, 8).map(([a, b]) => `${a} to ${b}`).join('; ')}${gaps.length > 8 ? `; and ${gaps.length - 8} more` : ''}.</p>` : ''}
  <h3>The last 7 days</h3>
  <p>The FIRMS near-real-time file of ${SENSOR.n20}, adjusted with the same tables. Times are local solar time. A strong fire releases more heat than a set level. "Burning N of 7 days" counts the days with a detection in the same 5 km square. These are first numbers and can change.</p>
  <h3>What to keep in mind</h3>
  <ul>
    <li>A fire detection is a satellite pixel with the heat of a fire, not one fire. A large fire gives many detections.</li>
    <li>Counts are not corrected for clouds. A cloudy month looks like a quiet month.</li>
    <li>After 2021 the adjustment cannot be checked against Aqua, because its orbit drifts.</li>
    <li>Small fires that MODIS never saw before VIIRS cannot be recovered. The "small fires" bars are a labeled estimate.</li>
    <li>The months before August 2002 come from Terra, which passes in the morning. They are less certain.</li>
    <li>The monthly record ends in ${MONTHS[monOf(T-1)]} ${yearOf(T-1)}, the last complete yearly archive.</li>
  </ul>
  <h3>Data</h3>
  <p>NASA FIRMS yearly country archives: MODIS Collection 6.1 and VIIRS 375 m, standard processing. Country shapes: Natural Earth. Single detections for any area: Download detections.</p>`;
}

/* ---------- wiring ---------- */
document.querySelectorAll('input[name=view]').forEach(r => r.addEventListener('change', () => setView(r.value)));
document.querySelectorAll('input[name=counts]').forEach(r => r.addEventListener('change', () => setMode(r.value === 'harm')));
document.querySelectorAll('input[name=time]').forEach(r => r.addEventListener('change', () => setTime(r.value)));
$('strong').onchange = e => { state.strong = e.target.checked; dirty = true; lastCheck = 0; };
$('cGrid').onclick = $('cRings').onclick = e => { state.cal = e.currentTarget.id === 'cGrid' ? 'grid' : 'rings';
  $('cGrid').setAttribute('aria-pressed', state.cal === 'grid'); $('cRings').setAttribute('aria-pressed', state.cal === 'rings'); if(months) renderCalendar(); };
$('wholeBtn').onclick = clearPlace;
$('wLive').onclick = () => { setPlaying(false); setLive(true); };
$('wLatest').onclick = () => { setPlaying(false); state.pick = false; setT(T-1); };
$('wPick').onclick = () => { setPlaying(false); state.pick = true; if(state.live) setLive(false); else renderTime(); $('pMonth').focus(); };
$('pYear').onchange = $('pMonth').onchange = () => { setPlaying(false); setT(tOf(+$('pYear').value, +$('pMonth').value)); };
$('play').onclick = () => setPlaying(!playing);
for(const id of ['rFrom', 'rTo']) for(const y of YEARS) $(id).add(new Option(y, y));
$('rFrom').value = YEARS[0]; $('rTo').value = YEARS.at(-1);
function setRange(){   // the timeline and Play cover only the chosen years
  const a = +$('rFrom').value, b = +$('rTo').value;
  rng = [clamp(tOf(Math.min(a, b), 0), 0, T-1), clamp(tOf(Math.max(a, b), 11), 0, T-1)];
  $('tRange').min = rng[0]; $('tRange').max = rng[1]; $('eras').hidden = rng[0] > 0 || rng[1] < T-1;
  setPlaying(false); if(!state.live && (state.t < rng[0] || state.t > rng[1])) setT(clamp(state.t, rng[0], rng[1])); else renderTime();
}
$('rFrom').onchange = $('rTo').onchange = setRange;
$('speed').onchange = e => { speed = +e.target.value; };
$('tRange').addEventListener('input', e => { setPlaying(false); setT(+e.target.value); });
$('dlCsv').onclick = downloadCsv; $('dlHot').onclick = downloadDetections; $('dlBrief').onclick = briefing; $('copyLink').onclick = copyLink;
$('yFrom').onchange = $('yTo').onchange = () => { if(months){ renderCalendar(); renderYears(); } };
$('ghost').onclick = () => { state.ghost = !state.ghost; $('ghost').setAttribute('aria-pressed', state.ghost); if(months) renderYears(); };
$('aboutBtn').onclick = $('trustAbout').onclick = () => $('about').showModal();
$('boxDraw').onclick = () => setDrawMode(drawMode === 'box' ? null : 'box');
$('polyDraw').onclick = () => setDrawMode(drawMode === 'poly' ? null : 'poly');
$('polyDone').onclick = finishPolygon;
$('stateSel').onchange = () => { const c = state.sel.c, list = ctryStates.get(c), v = $('stateSel').value;
  if(c == null || c < 0) return; if(v === '' || !list) selectCountry(c); else if(list[+v]) selectState(list[+v]); };
$('boxApply').onclick = () => {
  const b = {n:+$('bN').value, s:+$('bS').value, w:+$('bW').value, e:+$('bE').value};
  if(['bN','bS','bW','bE'].some(id => $(id).value === '') || !(b.n > b.s) || Math.abs(b.n) > 90 || Math.abs(b.s) > 90 || Math.abs(b.w) > 180 || Math.abs(b.e) > 180){
    toast('Enter four numbers, with North above South.'); return;
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

// On phones steps 3 and 4 and the definition move into "More options", so the map is closer to the top
const phone = matchMedia('(max-width: 759.98px)'), moreOpts = $('moreOpts');
function placeOpts(){
  if(phone.matches){ [$('stepShow'), $('stepOnly'), $('foot')].forEach(el => moreOpts.appendChild(el)); }
  else { moreOpts.before($('stepShow'), $('stepOnly')); $('ask').appendChild($('foot')); }
  moreOpts.hidden = !phone.matches;
}
phone.addEventListener('change', placeOpts); placeOpts();
addEventListener('hashchange', () => { if(location.hash !== ownHash) restore(); });   // a pasted link; our own writes use replaceState

$('wLive').hidden = !HAS.live;
$('strongWrap').hidden = !HAS.live;
buildAbout(); syncTimeControls(); legend(); loadPB(); loadTrust();
resize(); setPlaying(false); renderTime();
requestAnimationFrame(tick);
if(!(await restore())) select({kind:'world', name:'Earth'}, null).then(() => { spin = !reduced; });
})();
