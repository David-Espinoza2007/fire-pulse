/* blazeBridge. The look and the globe come from the team's first prototype (fire-pulse). The numbers come
   from the API in app.py, in one of two units: what VIIRS reports (the main one, measured since 2012, estimated before)
   or what Aqua MODIS would have reported (the strict long record). Both are tested on held-out years.
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
async function fetchWithProgress(url, onProgress){   // the globe file is the one big download: say how far it is
  const r = await fetch(url); if(!r.ok) throw new Error(r.status);
  const total = +r.headers.get('content-length') || 0;
  if(!r.body || !total || r.headers.get('content-encoding')) return r.arrayBuffer();
  const rd = r.body.getReader(), parts = []; let n = 0;
  for(;;){ const {done, value} = await rd.read(); if(done) break; parts.push(value); n += value.length; onProgress(n, total); }
  const out = new Uint8Array(n); let o = 0; for(const p of parts){ out.set(p, o); o += p.length; }
  return out.buffer;
}
let G, meta, VAL, cellId, ctry, GR, Hm, Rw, Nt = null, topo110;
try {
  const [bin, t110, m, v] = await Promise.all([
    fetchWithProgress('api/globe.bin', (n, total) => {
      $('loadText').textContent = `Loading 26 years of fire detections · ${(n/1e6).toFixed(1)} of ${(total/1e6).toFixed(1)} MB`;
      $('loadBar').style.width = (100*Math.min(1, n/total)).toFixed(1) + '%'; }),
    fetch('vendor/countries-110m.json').then(r => r.json()), api('api/meta'), api('api/validation')]);
  let bytes = new Uint8Array(bin);
  if(bytes[0] === 0x1f && bytes[1] === 0x8b)   // gunzip unless the server already did
    bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const hl = new DataView(bytes.buffer).getUint32(0, true);
  G = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + hl)));
  let off = 4 + hl; off += (-off & 3);
  const take = (Type, n) => { const a = new Type(bytes.buffer, off, n); off += n*Type.BYTES_PER_ELEMENT; off += (-off & 3); return a; };
  cellId = take(Uint32Array, G.units); ctry = take(Uint16Array, G.units);
  GR = {}; for(const k of (G.grids || ['harm', 'raw'])) GR[k] = take(Uint16Array, G.units*G.months);   // old files: no "grids" key
  Hm = GR.harm; Rw = GR.raw; Nt = GR.night || null;
  topo110 = t110; meta = m; VAL = v;
} catch(err){
  console.error(err); $('loading').hidden = true; $('loadErr').hidden = false; return;
}
$('loading').hidden = true;
// optional parts of the server; each one switches off quietly when its data or endpoint is missing
const HAS = {night:meta.night === true, states:meta.states === true, places:meta.places === true, live:!!meta.live, trust:meta.trust === true, points:meta.points === true};

/* time: t = 0 is November 2000 */
const U = G.units, T = G.months, RES = G.res, NCOL = G.ncol, NROW = Math.round(180/RES), Y0 = 2000, M0 = 10;
const yearOf = t => Y0 + ((t + M0)/12 | 0), monOf = t => (t + M0) % 12, tOf = (y, m) => (y - Y0)*12 + m - M0;
const tAt = ym => tOf(+ym.slice(0,4), +ym.slice(5,7) - 1);
const ymOf = t => `${yearOf(t)}-${String(monOf(t) + 1).padStart(2, '0')}`;
const dimOf = t => new Date(Date.UTC(yearOf(t), monOf(t) + 1, 0)).getUTCDate();   // days in month t
const firstOf = mo => ((mo - M0) % 12 + 12) % 12;   // first t of a calendar month
const YEARS = d3.range(Y0, yearOf(T-1) + 1), AQUA = tAt(meta.aqua_start), MODEL = tAt(meta.model_start);
const PRIMARY = VAL.primary, PKEY = PRIMARY.toLowerCase(), SAT = VAL.satellites[PRIMARY];
const SENSOR = {terra:'MODIS Terra', aqua:'MODIS Aqua', n20:'VIIRS NOAA-20', snpp:'VIIRS Suomi NPP'};
const PLAIN = {terra:'Older satellite', aqua:'Reference satellite', snpp:'Newer satellite (first)', n20:'Newer satellite (second)'};
const COUNTRIES = G.countries, NC = COUNTRIES.length, NONE = 65535;
const monthName = t => `${MONTHS[monOf(t)]} ${yearOf(t)}`;
const VV = meta.viirs || VAL.viirs || null, VSTART = VV ? tAt(VV.start) : T;
const PROV = meta.provisional ? clamp(tAt(meta.provisional), 0, T) : T;   // months from here on come from near-real-time files: first numbers
// The two units of the record: everything the page draws or says differently for each one is here.
// state.unit picks one; state.harm = false shows the raw counts instead (as reported, no unit).
const UNIT = {
  viirs:{word:'fire detections', label:'All fires the newer satellites see', grid:GR.vharm && {h:GR.vharm, n:GR.vnight || null},
    base:(meta.baseline && meta.baseline.viirs) || (VAL.viirs && VAL.viirs.baseline), est:t => t < VSTART,
    help:`Measured since ${monthName(VSTART)}. Earlier months are estimated from older satellites.`,
    sentence:`Counts: all fires the newer satellites see, measured since ${monthName(VSTART)}; earlier months are estimated from older satellites.`,
    now:t => t < VSTART ? 'Older satellites (estimated)' : 'Newer satellites (measured)',
    mark:[yearOf(VSTART), 'the newer satellites start. Earlier months are estimated from older satellites']},
  aqua:{word:'detections, strict count', label:'Strict long record', grid:{h:GR.harm, n:GR.night || null},
    base:(meta.baseline && meta.baseline.aqua) || VAL.baseline, est:t => t < AQUA || t >= MODEL,
    help:`Fewer small fires. Measured ${monthName(AQUA)} to ${monthName(MODEL - 1)}; other months are estimated.`,
    sentence:`Counts: the strict long record, what the reference satellite would have seen, measured ${monthName(AQUA)} to ${monthName(MODEL - 1)}; other months are estimated.`,
    now:t => t < AQUA ? 'Older satellite (less certain)' : t < MODEL ? 'Reference satellite' : 'Newer satellite (adjusted)',
    mark:[yearOf(MODEL), 'the newer satellites take over, adjusted so all years compare']}};
let UNITS = (meta.units || ['aqua']).filter(u => UNIT[u] && UNIT[u].grid && UNIT[u].base && (u === 'aqua' || VAL.viirs));
if(!UNITS.length) UNITS = ['aqua'];
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
// colour vision option (top bar): style.css swaps the ramp colours under html[data-cvd]
const CVD = (() => { const v = new URLSearchParams(location.search).get('colors') ?? (() => { try { return localStorage.getItem('fp-cvd'); } catch(e){ return null; } })(); return ['rg', 'by'].includes(v) ? v : ''; })();
if(CVD) document.documentElement.dataset.cvd = CVD;
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
// brightness scale for the globe, per unit (VIIRS counts are about 6 times larger): the 99.5th percentile of non-empty cell-months
const vmaxOf = a => { const s = []; for(let i=0;i<a.length;i+=53) if(a[i]) s.push(a[i]); s.sort((a,b) => a-b); return s[Math.floor(s.length*.995)] || 100; };
let VMAX = 100;
let minDens = 1, fireGain = 1;
const disp = {states:true, places:true};   // viewer settings: hide sparse squares, scale the fire brightness (drawing only)
const DENS = [1, 5, 20, 50, 200, 1000];

/* ---------- state ---------- */
const state = {t:T-1, day:0, harm:true, unit:UNITS[0], view:'count', cal:'grid', live:false, time:'all', strong:false, pick:false, sel:{kind:'world', name:'Earth', id:0}};
let months = null, S = null, liveArea = null, lookList = null, lookAll = false, lookFrom = null, lastSeason = null, lastTiles = [];
const liveCells = new Map();
let viewPlaces = null, curVB = null, viewKey = '', wasFlat = false, statesOff = false, placesOff = false;
const placeCache = new Map(), stateCache = new Set();
const rawTotal = m => m.raw.terra + m.raw.aqua + m.raw.n20 + m.raw.snpp;
const gTime = () => state.harm && Nt ? state.time : 'all';                 // the globe can split day and night only with the third grid
const uParam = () => meta.units ? {unit:state.unit} : {};                          // a server without units answers in aqua
const mParam = () => ({...uParam(), ...(HAS.night && state.time !== 'all' ? {time:state.time} : {})});   // monthly requests
const lParam = () => ({...uParam(), ...(state.time !== 'all' ? {time:state.time} : {})});                 // last-7-days requests
const lcKey = () => state.unit + state.time;
function reader(){
  if(!state.harm) return i => Rw[i];
  const tm = gTime();
  return tm === 'night' ? i => Nt[i] : tm === 'day' ? i => Math.max(0, Hm[i] - Nt[i]) : i => Hm[i];
}

// median of each calendar month per cell over the baseline years, for the "compared with normal" globe
const medCache = new Map();
let BASE = [];
function cellMedians(mo){
  const key = mo + state.unit + (state.harm ? 'h' : 'r') + gTime(); let a = medCache.get(key); if(a) return a;
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
let W = 0, H = 0, dpr = 1, S0 = 100, zoom = 1, dirty = true, spin = false, fly = null, dragging = null, drawMode = null, drawRect = null, poly = [];
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
// flat map switch: the same projection held fully flat (alpha = 1, the whole world in view at the smallest zoom, north up)
let flatMap = false;
const flatFit = () => Math.min(W/(2*Math.PI), 1.3*H/Math.PI)/S0;   // the world fills the width; on a wide screen the empty polar ends are cut (to 69 degrees at most) instead of leaving bands at the sides
const flatOut = () => flatMap && zoom <= flatFit()*1.02;   // fully zoomed out: keep the equator level
function setZoom(z){
  if(flatMap){
    zoom = Math.max(z, flatFit()); alpha = 1; projection.scale(S0*zoom);
    if(flatOut()){ const r = projection.rotate(); if(r[1]) projection.rotate([r[0], 0]); }
    return;
  }
  zoom = z; const u = clamp((z - 1.5)/1.1, 0, 1); alpha = u*u*(3 - 2*u); projection.scale(S0*zoom);
}
const bump = () => { baseVer++; dirty = true; };   // something on the base map changed

function resize(){
  const out = W && flatOut();   // the whole flat world stays whole when the size changes
  W = wrap.clientWidth; H = wrap.clientHeight; if(!W || !H) return;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = baseC.width = Math.round(W*dpr); cv.height = baseC.height = Math.round(H*dpr); baseSig = '';
  S0 = Math.min(W, H)*0.42;
  projection.translate([W/2, H/2]).clipExtent([[-100, -100], [W + 100, H + 100]]); setZoom(out ? 0 : zoom);   // deep zoom: shapes are cut near the screen, the canvas never fills polygons thousands of pixels wide
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
  const P = PC, cosc = x*P.cX + y*P.cY + z*P.cZ; if(cosc < 0.04 && !flatMap) return false;
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
let TR = null, TRS = null, trustOff = !HAS.trust;   // TRS: the map per unit, TR: the one of the current unit
const kmOf = deg => Number((deg*111).toPrecision(1));   // 1 degree is about 100 km
function trustFail(){
  trustOff = true;
  const b = document.querySelector('.vbox[data-view=trust]'); b.disabled = document.querySelector('input[name=view][value=trust]').disabled = true;
  b.title = 'Not available: the server has no confidence map yet. Rebuilding the data adds it.';
  if(state.view === 'trust') setView('count');
}
function loadTrust(){
  if(trustOff) return trustFail();
  api('api/trust').then(d => {
    TRS = {aqua:prepTrust(d), viirs:d.viirs ? prepTrust(d.viirs) : null}; TR = TRS[state.unit];
    bump(); legend(); buildAbout(); trustScale();
  }).catch(err => { console.error(err); trustFail(); });
}
function prepTrust(d){
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
  return {...d, N:n, cv:Float32Array.from(cv), ci, cls, at, px:new Float32Array(cv.length/3*2)};
}
function trustScale(){
  $('trustScale').hidden = !TR; if(!TR) return;
  const sz = TR.by_size.filter(s => [20, 5, TR.deg].includes(s.deg));
  $('trustScale').textContent = `Larger areas are more exact. Monthly ${state.unit === 'viirs' ? 'estimates' : 'counts'} in test years were off by ${sz.map(s => `${pct(s.err)} for about ${fmt(kmOf(s.deg))} km`).join(', ')}.`;
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


/* ---------- globe look: Minimal (neutral, for reading fire) or Realistic (relief and land cover). Presentation only:
   the fire layer, data and interaction are the same. Chosen with the switch on the map, kept per browser. ---------- */
const LOOK = {
  minimal:{space:'#0c0e10', ocean:'#16191c', land:'#262a30', border:'#3b4049', borderW:.5, graticule:.22, line:'#2c3138', stars:.7,
           atmo:null, limb:'#3b4049', shade:false, glow:false},
  // Natural Earth II relief and land cover (public domain); heavier to draw
  realistic:{space:'#05070b', ocean:'#0d2238', land:null, border:'rgba(255,255,255,.28)', borderW:.5, graticule:0, line:'#263350', stars:.6,
             atmo:'rgba(150,195,255,.30)', atmoOut:1.08, shade:false, glow:true, texture:true},
};
const TEX = {data:null, w:0, h:0, state:'idle'};
const texC = document.createElement('canvas'), texG = texC.getContext('2d');
let texBuf = null;
function loadTexture(){
  if(TEX.state !== 'idle') return; TEX.state = 'loading';
  const im = new Image();
  im.onload = () => {
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
    const g = c.getContext('2d', {willReadFrequently:true}); g.drawImage(im, 0, 0);
    TEX.data = g.getImageData(0, 0, im.width, im.height).data; TEX.w = im.width; TEX.h = im.height; TEX.state = 'ready'; bump();
  };
  im.onerror = () => { TEX.state = 'failed'; };
  im.src = 'textures/earth-ne2-4096.jpg';
}
// every pixel of the sphere is turned back into a longitude and latitude and looked up in the texture,
// lit from the upper left; the light fades and the texture darkens as the map flattens, so fires keep contrast
const LIGHT = (() => { const v = [-0.5, 0.55, 0.67], n = Math.hypot(...v); return v.map(x => x/n); })();
function drawTexture(g, moving){
  if(TEX.state !== 'ready'){ loadTexture(); return false; }
  const budget = moving ? 120000 : 700000, q = Math.min(dpr, Math.sqrt(budget/(W*H)));
  const w = Math.max(1, Math.round(W*q)), h = Math.max(1, Math.round(H*q));
  if(texC.width !== w || texC.height !== h){ texC.width = w; texC.height = h; texBuf = null; }
  if(!texBuf) texBuf = texG.createImageData(w, h);
  const out = texBuf.data, src = TEX.data, tw = TEX.w, th = TEX.h, P = PC, a = alpha, lit = 1 - a, ymax = (1 - a) + a*Math.PI/2;
  out.fill(0);
  if(a > 0.9999){   // flat: x is longitude and y is latitude, nothing to solve. With north up, every column and row of the screen is one column and row of the texture
    const lmax = flatMap ? Math.PI : Math.PI/2, sl = new Float32Array(w), cl = new Float32Array(w), ok = new Uint8Array(w), cu = new Int32Array(w);
    const level = Math.abs(P.cZ) < 1e-9, l0 = Math.atan2(P.cY, P.cX);
    for(let i=0;i<w;i++){ const l = ((i + .5)/q - P.cx)/P.k; ok[i] = Math.abs(l) <= lmax ? 1 : 0; sl[i] = Math.sin(l); cl[i] = Math.cos(l);
      if(level){ let u = (((l0 + l)/Math.PI + 1)/2) % 1; if(u < 0) u += 1; cu[i] = Math.min(tw - 1, (u*tw) | 0); } }
    for(let j=0;j<h;j++){
      const p = (P.cy - (j + .5)/q)/P.k; if(!(Math.abs(p) < Math.PI/2)) continue;
      const sp = Math.sin(p), cp = Math.cos(p), row = Math.min(th - 1, ((0.5 - p/Math.PI)*th) | 0)*tw;
      for(let i=0, o=j*w*4;i<w;i++, o+=4){
        if(!ok[i]) continue;
        let si;
        if(level) si = (row + cu[i])*4;
        else { const X = cp*sl[i], Z = cp*cl[i], vx = X*P.eX + sp*P.nX + Z*P.cX, vy = X*P.eY + sp*P.nY + Z*P.cY, vz = sp*P.nZ + Z*P.cZ;
          const u = ((Math.atan2(vy, vx)/Math.PI + 1)/2*tw) | 0, v = ((0.5 - Math.asin(vz > 1 ? 1 : vz < -1 ? -1 : vz)/Math.PI)*th) | 0;
          si = ((v >= th ? th - 1 : v)*tw + (u >= tw ? tw - 1 : u))*4; }
        out[o] = src[si] >> 1; out[o + 1] = src[si + 1] >> 1; out[o + 2] = src[si + 2] >> 1; out[o + 3] = 255;   // the flat map is unlit at half brightness
      }
    }
  } else
  for(let j=0;j<h;j++){
    const yr = (P.cy - (j + .5)/q)/P.k;
    let sp = 0, cp = 1;
    if(a > 1e-3){
      if(Math.abs(yr) >= ymax) continue;
      let p = yr; for(let i=0;i<8;i++) p -= ((1 - a)*Math.sin(p) + a*p - yr)/((1 - a)*Math.cos(p) + a || 1e-9);
      if(!(Math.abs(p) <= Math.PI/2)) continue;
      sp = Math.sin(p); cp = Math.cos(p);
    } else if(Math.abs(yr) >= 1) continue;
    for(let i=0;i<w;i++){
      const xr = ((i + .5)/q - P.cx)/P.k;
      let X, Y, Z;
      if(a <= 1e-3){ const r2 = xr*xr + yr*yr; if(r2 >= 1) continue; X = xr; Y = yr; Z = Math.sqrt(1 - r2); }
      else {
        let l = xr; for(let it=0;it<6;it++) l -= ((1 - a)*cp*Math.sin(l) + a*l - xr)/((1 - a)*cp*Math.cos(l) + a || 1e-9);
        if(!(Math.abs(l) <= (flatMap ? Math.PI : Math.PI/2))) continue;
        if(Math.abs((1 - a)*cp*Math.sin(l) + a*l - xr) > 2e-3) continue;   // outside the map the solve does not settle; without this it drew rings around the globe
        X = cp*Math.sin(l); Y = sp; Z = cp*Math.cos(l);
      }
      const vx = X*P.eX + Y*P.nX + Z*P.cX, vy = X*P.eY + Y*P.nY + Z*P.cY, vz = Y*P.nZ + Z*P.cZ;
      const u = ((Math.atan2(vy, vx)/Math.PI + 1)/2*tw) | 0, v = ((0.5 - Math.asin(vz > 1 ? 1 : vz < -1 ? -1 : vz)/Math.PI)*th) | 0;
      const si = ((v >= th ? th - 1 : v)*tw + (u >= tw ? tw - 1 : u))*4;
      const d = X*LIGHT[0] + Y*LIGHT[1] + Z*LIGHT[2], f = lit*0.8*(0.36 + 0.7*(d > 0 ? d : 0)) + a*0.5, o = (j*w + i)*4;
      out[o] = src[si]*f; out[o + 1] = src[si + 1]*f; out[o + 2] = src[si + 2]*f; out[o + 3] = 255;
    }
  }
  texG.putImageData(texBuf, 0, 0);
  g.imageSmoothingEnabled = true; g.drawImage(texC, 0, 0, W, H);
  return true;
}
const pageQ = new URLSearchParams(location.search);
if(pageQ.get('embed') === '1') document.querySelector('.app').classList.add('embed');
const lookStore = {get(){ try { return localStorage.getItem('fp-globe'); } catch(e){ return null; } }, set(v){ try { localStorage.setItem('fp-globe', v); } catch(e){} },
  get2(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }, set2(k, v){ try { localStorage.setItem(k, v); } catch(e){} }};
let globeLook = [pageQ.get('globe'), lookStore.get()].find(v => v in LOOK) || 'minimal';
const syncLook = () => document.querySelectorAll('button[data-look]').forEach(b => b.setAttribute('aria-pressed', b.dataset.look === globeLook));
function setGlobeLook(look){
  if(!(look in LOOK) || look === globeLook) return;
  globeLook = look; lookStore.set(look); syncLook(); bump();
}
document.querySelectorAll('button[data-look]').forEach(b => b.addEventListener('click', () => setGlobeLook(b.dataset.look)));
syncLook();
function setFlat(on, save = true){
  flatMap = on; projection.clipAngle(on ? null : 90);
  if(on){ const r = projection.rotate(); projection.rotate([r[0], 0]); setZoom(zoom < 1.6 ? 0 : zoom); }   // from the whole globe: the whole world, flat
  else setZoom(Math.max(zoom, 1));
  document.querySelectorAll('.flat-toggle').forEach(b => b.setAttribute('aria-checked', on));
  if(save) lookStore.set2('fp-flat', on ? '1' : '0');
  bump(); legend(); howto();
}
document.querySelectorAll('.flat-toggle').forEach(b => b.addEventListener('click', () => setFlat(!flatMap)));

/* ---------- base layer: ocean, land and borders, confidence map, states, selection, place names ---------- */
function drawBase(g, pth, full, under){
  const k = projection.scale(), cx = W/2, cy = H/2, round = 1 - alpha, L = LOOK[globeLook];
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  g.fillStyle = L.space; g.fillRect(0, 0, W, H);
  g.fillStyle = '#e8edf7';
  if(L.stars) for(const s of stars){ g.globalAlpha = s[3]*L.stars; g.fillRect(s[0]*W, s[1]*H, s[2], s[2]); }
  if(round > 0.02 && L.atmo){
    g.globalAlpha = round;
    const out = L.atmoOut, col = L.atmo;
    const a = g.createRadialGradient(cx, cy, k*0.96, cx, cy, k*out);           // atmosphere
    a.addColorStop(0, col); a.addColorStop(1, col.replace(/[\d.]+\)$/, '0)'));
    g.fillStyle = a; g.beginPath(); g.arc(cx, cy, k*out, 0, 7); g.fill();
  }
  g.globalAlpha = 1;
  g.beginPath(); pth({type:'Sphere'}); g.fillStyle = L.ocean; g.fill();
  const textured = !!L.texture && drawTexture(g, !full);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  if(L.graticule){ g.beginPath(); pth(graticule); g.strokeStyle = L.line; g.globalAlpha = L.graticule; g.lineWidth = .5; g.stroke(); g.globalAlpha = 1; }
  const vb = alpha >= 0.5 ? viewBounds(alpha > 0.9 ? 0.1 : 0.3) : null;
  const land = full && alpha >= 0.5 && world50 ? world50.features : feats;
  if(alpha > 0.95) projection.precision(0);   // nearly flat: segments stay straight, and resampling was most of the cost
  const landP = new Path2D(), pc = pth.context();   // built once: fill, clip and outline all reuse it
  pth.context(landP); for(const f of land) if(!vb || fhit(f._b, vb)) pth(f); pth.context(pc);
  if(!textured){ g.fillStyle = L.land || C.land; g.fill(landP); } g.strokeStyle = L.border; g.lineWidth = L.borderW; g.stroke(landP);
  if(!under){
    if(state.view === 'trust' && !state.live){
      // units of coastal cells reach into the sea: land only. The clip is kept for still frames; a moving globe shows a few pixels of spill instead of paying for it every frame
      if(TR){ if(full){ g.save(); g.clip(landP); } drawTrust(g, vb); if(full) g.restore(); }
      g.strokeStyle = L.space; g.lineWidth = .6; g.stroke(landP);
    }
    if(disp.states && full && alpha > 0.9 && vb && stateMap.size){   // state and province borders of the visible area
      g.beginPath(); for(const s of stateMap.values()) if(hits(s.bbox, vb)) pth(s._ml);
      g.globalAlpha = Math.min(1, (alpha - .9)*10)*.5; g.strokeStyle = C.muted; g.lineWidth = .6; g.stroke(); g.globalAlpha = 1;
    }
    const out = selOutline(full);
    if(out){ g.beginPath(); pth(out); if(!/LineString/.test(out.type)){ g.fillStyle = 'rgba(143,201,255,.06)'; g.fill(); } g.strokeStyle = C.accent; g.lineWidth = 1.5; g.stroke(); }
    if(round > 0.02 && L.limb){ g.globalAlpha = round; g.beginPath(); g.arc(cx, cy, k, 0, 7); g.strokeStyle = L.limb; g.lineWidth = 1; g.stroke(); g.globalAlpha = 1; }
    if(round > 0.02 && L.shade){
      const s = g.createRadialGradient(cx - k*.3, cy - k*.3, k*.2, cx, cy, k);    // shading toward the limb
      s.addColorStop(0, 'rgba(0,0,0,0)'); s.addColorStop(1, 'rgba(0,0,0,.5)');
      g.globalAlpha = round; g.fillStyle = s; g.beginPath(); g.arc(cx, cy, k, 0, 7); g.fill(); g.globalAlpha = 1;
    }
    if(disp.places && full && alpha > 0.9 && k > 150 && viewPlaces && viewPlaces.length){   // not on a phone-size whole world: the names would cover it   // names of the largest places in view, skipping overlaps
      g.font = '11px "Source Sans 3", system-ui, sans-serif'; g.textBaseline = 'middle'; g.lineJoin = 'round';
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
      g.globalAlpha = Math.min(1, (0.3 + 0.7*q)*0.1*fireGain)*a; g.beginPath();
      for(let j=j0;j<j1;j++){ const i = sqOrder[j], r = SQ.s[i]*1.8; g.moveTo(SQ.x[i] + r, SQ.y[i]); g.arc(SQ.x[i], SQ.y[i], r, 0, 7); }
      g.fill();
    }
    g.globalAlpha = (count ? Math.min(1, (0.3 + 0.45*q)*fireGain) : 0.8)*a; g.beginPath();
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
    if(count ? v < minDens : (v < 3 && med[u] < 3) || (minDens > 1 && v < minDens)) return;
    if(!projU(ux[u], uy[u], uz[u], side)) return;
    if(count) sqPush(PX[0], PX[1], side, Math.min(NB-1, Math.floor(Math.sqrt(Math.min(1, v/VMAX))*NB)), v, 0, u);
    else { const r = (v + 1)/(med[u] + 1); sqPush(PX[0], PX[1], side, Math.min(NB-1, Math.floor(anomU(r)*NB)), r, 0, u); }
  });
}
function drawLive0(g, cells, skip, a, moving){   // the last 7 days on 0.5 degree cells
  const k = PC.k, zs = 0.75 + 0.3*(k/S0), foot = 0.55*k*RES*RAD;
  g.globalCompositeOperation = 'lighter';
  for(const c of cells){
    const v = c[state.harm ? 3 : 2]; if(v < Math.max(0.5, minDens)) continue;
    const lon = c[0] + RES/2, lat = c[1] + RES/2;
    if(skip && inBox(skip, lon, lat)) continue;
    if(!projLL(lon, lat, 16)) continue;
    const q = Math.sqrt(Math.min(1, v*4/VMAX)), r = clamp(Math.max(foot, (0.7 + 2.5*q)*zs), 0.8, 14);
    g.fillStyle = lut(seqLUT, 0.2 + 0.7*q);
    if(!moving){ g.globalAlpha = Math.min(1, (0.3 + 0.7*q)*0.1*fireGain)*a; g.beginPath(); g.arc(PX[0], PX[1], r*2.2, 0, 7); g.fill(); }
    g.globalAlpha = Math.min(1, (0.3 + 0.45*q)*fireGain)*a; g.beginPath(); g.arc(PX[0], PX[1], r, 0, 7); g.fill();
  }
}

/* ---------- fire layer, level 1: 0.05 degree cells for a month, or single detections for the last 7 days ----------
   Fetched for the visible box once the view settles, cached for 12 views, faded in when nothing as sharp was shown before. */
const l1Cache = new Map(), l1Bad = new Set();
let l1Cur = null, l1Pending = null, l1Ctl = null, cellsOff = false, ptsOff = false;
const l1Base = () => state.live ? `p|${state.time}|${state.strong ? 1 : 0}`
  : `c|${ymOf(state.t)}|${mParam().time || 'all'}|${state.harm ? 'h' : 'r'}|${state.view === 'anom' ? 1 : 0}|${state.unit}`;
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
    g.globalAlpha = (count ? Math.min(1, (0.3 + 0.45*q)*fireGain) : 0.8)*a; g.beginPath();
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
  const idx = u16(), harm = u16(), night = u16(), raw = u16(), vharm = h.v ? u16() : null, vnight = h.v ? u16() : null;
  const t = TL[L], b = tileBox(L, x, y), vx = new Float32Array(10000), vy = new Float32Array(10000), vz = new Float32Array(10000);
  for(let r=0;r<100;r++) for(let c=0;c<100;c++){ const v = unitOf(b[0] + (c + .5)*t.cell, b[1] + (r + .5)*t.cell), i = r*100 + c; vx[i] = v[0]; vy[i] = v[1]; vz[i] = v[2]; }
  return {nT, t0:tAt(h.first || '2000-11'), mstart, idx, raw, vx, vy, vz, norm:new Map(),
          u:{aqua:{h:harm, n:night, s:+h.scale || 1}, viirs:h.v ? {h:vharm, n:vnight, s:+h.vscale || 1} : null}};   // per unit: counts, night part, scale
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
// a = the unit's arrays of the tile (d.u[unit]), picked once per tile and frame
const tileVal = (d, a, i, filt) => filt === 'raw' ? d.raw[i] : filt === 'night' ? a.n[i]/a.s : filt === 'day' ? Math.max(0, a.h[i] - a.n[i])/a.s : a.h[i]/a.s;
function tileNormal(e, mo, filt, a){
  const d = e.data, key = state.unit + mo + filt; let r = d.norm.get(key); if(r) return r;   // the unit also sets the baseline years
  const ny = BASE.length, buf = new Float32Array(10000*ny), seen = new Uint8Array(10000), ids = [];
  BASE.forEach((Y, yi) => { const t = tOf(Y, mo) - d.t0; if(t < 0 || t >= d.nT) return;
    for(let i=d.mstart[t];i<d.mstart[t + 1];i++){ const id = d.idx[i]; buf[id*ny + yi] = tileVal(d, a, i, filt); if(!seen[id]){ seen[id] = 1; ids.push(id); } } });
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
  const filt = state.harm ? (mParam().time || 'all') : 'raw', ua = d.u[state.unit];
  if(!ua){ cells0(vb, box); return; }   // a tile from before the rebuild has no VIIRS units
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
      const v = tileVal(d, ua, i, filt); if(v*f100 < minDens) continue;
      if(!projU(d.vx[id], d.vy[id], d.vz[id], side)) continue;
      sqPush(PX[0], PX[1], side, Math.min(NB-1, Math.floor(Math.sqrt(Math.min(1, v*f100/VMAX))*NB)), v, L, -1);
    }
    return;
  }
  const nm = tileNormal(e, monOf(state.t), filt, ua), list = [];
  for(let i=a;i<b;i++){ const id = d.idx[i]; if(id > last) break; const col = id % 100; if(col < c0 || col > c1) continue; tCur[id] = tileVal(d, ua, i, filt); tMark[id] = 1; list.push(id); }
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
function drawTiles(g, L, now, a = 1){   // a: paler squares under the single detections
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
  sqFlush(g, from, SQ.n, count, a, false);
  for(const [it, e, f] of fading){   // a new tile fades in over the data it replaces
    let i0 = SQ.n; fallbackSquares(L, it.b, vb); sqFlush(g, i0, SQ.n, count, (1 - f)*a, false);
    i0 = SQ.n; tileSquares(e, L, it.b, it.b, vb); sqFlush(g, i0, SQ.n, count, f*a, false);
    dirty = true;
  }
  tileStat = [ok, vis.length - ok];
}

/* ---------- the last 7 days as one binary file: single detections for the whole world, filtered in the page ---------- */
let PB = null, pbOff = !HAS.live, dayPick = -1;   // dayPick: one day of the last 7 days (0 = the first), or -1 for all
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
    .then(buf => { PB = decodePB(buf); $('dRange').max = PB.h.days || 7; renderTime(); })
    .catch(() => { pbOff = true; });   // keep the per-view request
}
const pbStrong = () => PB && PB.h.strong_mw != null ? +PB.h.strong_mw : strongMW();
function drawPB(g){
  const d = PB, vb = tileView(), smw = pbStrong() || 50, night = state.time === 'night', day = state.time === 'day', strong = state.strong;
  if(qX.length < d.n){ qX = new Float32Array(d.n); qY = new Float32Array(d.n); qI = new Int32Array(d.n); }
  const cls = new Uint8Array(d.n); nQ = 0; l1Shown = {kind:'pb'};
  const visit = (a, b) => { for(let i=a;i<b;i++){
    if(dayPick >= 0 && d.day[i] !== dayPick) continue;
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

/* ---------- a past month at the closest zoom: its single detections, asked for by view (layout in app.py, /api/points.bin) ---------- */
let MP = null, mpWant = '', mpBusy = '', mpHold = 0, mpOff = !HAS.points;
const mpDays = new Map(), mpAsk = new Map();   // the last 12 days loaded and the requests in flight, by month|day|box
const mpOn = () => !mpOff && !playing && isFlat() && PC.k*0.05*RAD >= 12;   // a square of 5 km is at least 12 px wide
const dayOn = () => state.day > 0 && !state.live && !mpOff;   // one day of the record: its raw detections at every zoom
const mpReady = () => MP && MP.m === ymOf(state.t) && MP.d === (dayOn() ? state.day : 0);
const dayBox = () => { const vb = isFlat() && tileView(); return vb && vb[2] - vb[0] < 60 ? vb : [-180, -90, 180, 90]; };   // the whole world on the globe or zoomed out
const daySpan = () => { if(!mpReady()) return 'Loading the detections…';
  const where = MP.box[2] - MP.box[0] >= 359 ? 'in the world' : 'in this view';   // a wide view asks for the whole world
  return MP.h.truncated ? `Strongest ${fmt(MP.n)} detections ${where} shown, as reported` : `${fmt(MP.n)} detections ${where}, as reported`; };
function fetchMP(m, dd, box){   // -> promise of the detections of one month, or one day of it, in a box
  const key = `${m}|${dd}|${box}`;
  if(mpDays.has(key)) return Promise.resolve(mpDays.get(key));
  if(mpAsk.has(key)) return mpAsk.get(key);
  if(performance.now() < mpHold) return Promise.reject(new Error('wait'));   // the last request failed: no new one for 3 s
  const p = fetch(`api/points.bin?month=${m}&bbox=${box}${dd ? '&day=' + dd : ''}`)
    .then(r => { if(!r.ok){ const x = new Error(r.status); x.status = r.status; throw x; } return r.arrayBuffer(); })
    .then(buf => {
      const hl = new DataView(buf).getUint32(0, true), h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl))), n = h.n;
      let off = 4 + hl; off += (-off & 3);
      const take = Type => { const a = new Type(buf, off, n); off += n*Type.BYTES_PER_ELEMENT; off += (-off & 3); return a; };
      const lon = take(Float32Array), lat = take(Float32Array), frp = take(Float32Array), minute = take(Uint16Array), day = take(Uint8Array), flags = take(Uint8Array);
      const vx = new Float32Array(n), vy = new Float32Array(n), vz = new Float32Array(n);
      for(let i=0;i<n;i++){ const v = unitOf(lon[i], lat[i]); vx[i] = v[0]; vy[i] = v[1]; vz[i] = v[2]; }
      const o = {h, m, d:dd, box, n, frp, minute, day, flags, vx, vy, vz};
      if(dd){ mpDays.set(key, o); if(mpDays.size > 12) mpDays.delete(mpDays.keys().next().value); }   // days are kept: Play and stepping back show them at once
      return o;
    })
    .catch(err => { if(err.status !== 404) mpHold = performance.now() + 3000; throw err; })
    .finally(() => mpAsk.delete(key));
  mpAsk.set(key, p); return p;
}
function loadMP(vb){   // on still frames: one request for the view and a margin, kept until the view leaves it or the month (or day) changes
  const m = ymOf(state.t), dd = dayOn() ? state.day : 0;
  if(!vb || (mpReady() && vb[0] >= MP.box[0] && vb[1] >= MP.box[1] && vb[2] <= MP.box[2] && vb[3] <= MP.box[3])) return;
  const dx = (vb[2] - vb[0])/4, dy = (vb[3] - vb[1])/4;
  const box = [Math.max(-180, vb[0] - dx), Math.max(-90, vb[1] - dy), Math.min(180, vb[2] + dx), Math.min(90, vb[3] + dy)].map(v => +v.toFixed(2));
  const key = m + dd + box; if(key === mpWant) return;
  mpWant = key; mpBusy = m + dd;
  fetchMP(m, dd, box).then(o => { if(mpWant !== key) return;   // replaced by a newer request
      MP = o; mpBusy = ''; dirty = true; legend();
      if(dd && dayOn()) $('sensorNow').textContent = daySpan();
      const a = dd && dayAfter(state.t, dd); if(a) fetchMP(ymOf(a[0]), a[1], box).catch(() => {}); })   // the next day, ahead: Play and the next-day arrow then show it at once
    .catch(err => { if(mpWant !== key) return;
      if(err.status !== 404){ setTimeout(() => { if(mpWant === key){ mpWant = mpBusy = ''; dirty = true; } }, 3000); return; }   // server busy or restarting: try again
      mpBusy = '';
      if(dd){ mpWant = ''; toast(`No single detections for ${monthName(state.t)}.`); state.day = 0; renderTime(); }   // only this month has no file
      else { mpOff = true; legend(); } });   // this data folder has no detection files
}
const SATN = {Terra:'Terra, 1 km pixel', Aqua:'Aqua, 1 km pixel', SNPP:'Suomi NPP, 375 m pixel', N20:'NOAA-20, 375 m pixel'};
function drawMP(g, moving, old){   // old: the day asked for is still loading, so the last day stays on screen, faded   // each detection as a square of its pixel size on the ground, at least 2.5 px
  const d = MP, tm = state.harm ? mParam().time : null, wide = d.h.sats.map(s => s === 'Terra' || s === 'Aqua');
  const s375 = Math.max(2.5, PC.k*RAD*0.375/111.2), s1k = Math.max(2.5, PC.k*RAD/111.2);
  if(qX.length < d.n){ qX = new Float32Array(d.n); qY = new Float32Array(d.n); qI = new Int32Array(d.n); }
  nQ = 0; l1Shown = {kind:'mp'};
  if(d.d){   // one day: dots like one day of the last 7 days (drawPB), never smaller than the pixel on the ground
    const smw = pbStrong() || 50, ot = state.time === 'all' ? null : state.time, cls = new Uint8Array(d.n);
    const n = moving ? Math.min(d.n, 40000) : d.n;   // strongest first: a moving map draws the strongest 40,000 only
    for(let i=0;i<n;i++){
      const f = d.flags[i]; if(ot && (ot === 'night') !== !!(f & 1)) continue;
      if(state.strong && !(d.frp[i] >= smw)) continue;
      if(!projU(d.vx[i], d.vy[i], d.vz[i], 6)) continue;
      cls[nQ] = d.frp[i] >= smw ? 2 : d.frp[i] >= smw/4 ? 1 : 0; qX[nQ] = PX[0]; qY[nQ] = PX[1]; qI[nQ++] = i;
    }
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = old ? .3 : .9;
    for(let c=0;c<3;c++){
      const r = [1.8, 2.5, 3.3][c]*clamp(PC.k/700, .25, 1); g.fillStyle = PTC[c]; g.beginPath();   // smaller on the whole world: a day has over 100,000 dots
      for(let j=0;j<nQ;j++){ if(cls[j] !== c) continue; const q = Math.max(r, (wide[d.flags[qI[j]] >> 1] ? s1k : s375)/2); if(q < 2) g.rect(qX[j] - q, qY[j] - q, 2*q, 2*q); else { g.moveTo(qX[j] + q, qY[j]); g.arc(qX[j], qY[j], q, 0, 7); } }   // tiny dots as squares: far cheaper to fill
      g.fill();
    }
    qSide = Math.max(6, s1k/2); return;
  }
  g.globalCompositeOperation = 'source-over'; g.globalAlpha = .9; g.fillStyle = C.fg; g.beginPath();
  for(let i=0;i<d.n;i++){
    const f = d.flags[i]; if(tm && (tm === 'night') !== !!(f & 1)) continue;
    if(!projU(d.vx[i], d.vy[i], d.vz[i], 6)) continue;
    const s = wide[f >> 1] ? s1k : s375; g.rect(PX[0] - s/2, PX[1] - s/2, s, s);
    qX[nQ] = PX[0]; qY[nQ] = PX[1]; qI[nQ++] = i;
  }
  g.fill(); qSide = Math.max(6, s1k/2);
}

function drawFire(g, moving, now){
  nQ = 0; l1Shown = null; SQ.n = 0;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const flat = isFlat(), vb = flat ? viewBounds(0.1) : null, glow = alpha < 0.5 && !moving && LOOK[globeLook].glow;
  let lv = 0;
  if(state.live && PB && (zoom >= 1.8 || dayPick >= 0)){ drawPB(g); lv = 4; }   // one day has no 0.5 degree grid: single detections at every zoom
  else if(dayOn()){ if(!moving || (!mpReady() && mpBusy !== ymOf(state.t) + state.day)) loadMP(dayBox());   // while the map moves, one request at a time: the server finishes every request, also the ones the page drops
    if(mpReady() || (MP && MP.d)){ drawMP(g, moving, !mpReady()); lv = 5; } }   // one day of the record: no monthly squares
  else if(!state.live && state.view !== 'trust' && !tilesOff){
    lv = tileLv = levelFor(PC.k, true);
    const pts = lv === 3 && mpOn();
    if(pts && !moving) loadMP(tileView());
    const mp = pts && mpReady();
    if(lv === 0){ cells0(vb, null); sqFlush(g, 0, SQ.n, state.view !== 'anom', 1, glow); tileStat = [0, 0]; }
    else drawTiles(g, lv, now, mp ? 0.45 : 1);
    if(mp){ drawMP(g); lv = 5; }
  } else {
    // without tiles or the week file: level 0, and the per-view level 1 once the view has settled (as before)
    const L1 = flat && !playing && l1Cur && l1Cur.base === l1Base() && (state.live || state.view !== 'trust') ? l1Cur : null;
    const f = !L1 ? 0 : reduced || !L1.shownAt ? 1 : clamp((now - L1.shownAt)/200, 0, 1);
    if(L1 && f < 1) dirty = true;
    const skip = L1 && f >= 1 ? L1.vb : null, a0 = L1 && f < 1 ? 1 - f : 1;   // after the fade, level 0 only outside the level 1 box
    if(state.live){ const cells = liveCells.get(lcKey()); if(cells && a0 > 0) drawLive0(g, cells, skip, a0, moving); }
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
let perfN = 0, partMs = [0, 0];
const perfBox = PERF ? Object.assign(document.createElement('p'), {className:'perf'}) : null;
if(perfBox) wrap.appendChild(perfBox);
const isMoving = now => !!fly || !!pinch || !!(dragging && dragging.moved) || now - lastWheel < 140 || (spin && !dragging && !drawMode);
// The last sharp base image can stand in for the moving flat map only where moving and scaling it is exact. It is not when the
// view turned in latitude, or when the whole world is in view and wraps around: then the fires moved and the land stayed behind.
const BQ = [[.1, .1], [.9, .9]];
function baseFits(){
  if(2*Math.PI*PC.k < W) return false;
  const p = projection(baseView.c), s = PC.k/baseView.k; if(!p) return false;
  return BQ.every(([fx, fy], i) => { const ll = baseView.q[i], q = ll && !isNaN(ll[0]) && projection(ll);
    return q && Math.hypot(q[0] - (p[0] + s*W*(fx - .5)), q[1] - (p[1] + s*H*(fy - .5))) < 2; });
}
function draw(now = performance.now()){
  if(!W) return;
  const t0 = performance.now(), moving = isMoving(now);
  frameRot();
  const r = projection.rotate(), sig = `${r[0]},${r[1]},${PC.k},${alpha},${W},${H},${dpr},${baseVer}`;
  if(!moving){   // still: full detail, drawn once into the cache, then only copied
    if(sig !== baseSig){ drawBase(bctx, bpath, true, false); baseSig = sig; baseMode = 'full';
      baseView = {k:PC.k, alpha, c:projection.invert([W/2, H/2]), q:BQ.map(([fx, fy]) => projection.invert([W*fx, H*fy]))}; }
    else baseMode = 'blit';
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.drawImage(baseC, 0, 0);
  } else if(alpha > 0.999 && baseView && baseView.alpha > 0.999 && baseView.c && !isNaN(baseView.c[0]) && baseFits()){
    // flat and moving: coarse land underneath, the last sharp image moved and scaled onto the current view
    drawBase(ctx, path, false, true);
    const p = projection(baseView.c), s = PC.k/baseView.k;
    ctx.setTransform(dpr*s, 0, 0, dpr*s, dpr*(p[0] - s*W/2), dpr*(p[1] - s*H/2)); ctx.drawImage(baseC, 0, 0, W, H);
    baseMode = 'transform';
  } else { drawBase(ctx, path, false, false); baseMode = 'direct 110m'; }
  const t1 = performance.now();
  drawFire(ctx, moving, now);
  if(PERF) partMs = [t1 - t0, performance.now() - t1];
  const home = state.sel.kind === 'world' && zoom <= (flatMap ? flatFit()*1.05 : 1.2); if($('worldBtn').hidden !== home) $('worldBtn').hidden = home;   // the way back, whenever you are not looking at the whole planet
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.setLineDash([5, 4]); ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5;
  if(drawRect) ctx.strokeRect(drawRect.x0, drawRect.y0, drawRect.x1 - drawRect.x0, drawRect.y1 - drawRect.y0);
  if(poly.length){ ctx.beginPath(); path({type:'LineString', coordinates:poly}); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = C.accent; for(const p of poly){ const q = projection(p); if(q){ ctx.beginPath(); ctx.arc(q[0], q[1], 3, 0, 7); ctx.fill(); } } }
  ctx.setLineDash([]);
  frameMs.push(performance.now() - t0); if(frameMs.length > 60) frameMs.shift();
  if(perfBox && ++perfN % 10 === 0){
    const s = frameMs.slice().sort((a, b) => a - b);
    perfBox.textContent = `median ${s[s.length >> 1].toFixed(1)} ms, worst ${s.at(-1).toFixed(1)} ms\nbase ${partMs[0].toFixed(0)} ms, fire ${partMs[1].toFixed(0)} ms, ${baseMode}, fire level ${fireLevel === 4 ? 'dots' : fireLevel}
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

const PLAY = {from:0, to:0, speed:1, loop:false};   // Play runs inside from..to, at speed times one month per 110 ms
let last = 0, playing = false, playAcc = 0, lastCheck = 0, lastTileReq = 0;
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
  if(playing && dayOn()){ playAcc += dt; if(playAcc > 110/PLAY.speed && mpReady()){   // one day per step. The next days are asked ahead, and the day on screen stays until the next one is in.
    const nx = dayAfter(state.t, state.day);
    if(!nx) setPlaying(false);
    else {
      const o = mpDays.get(`${ymOf(nx[0])}|${nx[1]}|${MP.box}`);
      if(o){ playAcc = 0; MP = o; mpWant = ''; state.day = nx[1]; setT(nx[0]); }
      for(let a = o ? dayAfter(nx[0], nx[1]) : nx, i = 0; a && i < 2; a = dayAfter(a[0], a[1]), i++)
        fetchMP(ymOf(a[0]), a[1], MP.box).catch(err => { if(err.status === 404 && playing){ setPlaying(false); toast('No single detections for the next month.'); } });
    } } }
  else if(playing){ playAcc += dt; if(playAcc > 110/PLAY.speed){ playAcc = 0; if(state.t >= PLAY.to){ if(PLAY.loop) setT(PLAY.from); else setPlaying(false); } else setT(state.t + 1); } }
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
  if(!(Math.abs(q[0]) <= (flatMap ? Math.PI : Math.PI/2) && Math.abs(q[1]) <= Math.PI/2)) return null;
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
    setZoom(clamp(pinch.z0*d/pinch.d0, 0.8, 150));
    if(pinch.ll && isFlat()) anchor(pinch.ll, mx, my);
    else { const s = 57.3/projection.scale(); projection.rotate([pinch.r[0] + (mx - pinch.mx)*s, clamp(pinch.r[1] - (my - pinch.my)*s, -80, 80)]); }
    dirty = true; return;
  }
  if(drawRect){ drawRect.x1 = x; drawRect.y1 = y; dirty = true; return; }
  if(dragging){
    const dx = x - dragging.x, dy = y - dragging.y;
    if(Math.abs(dx) + Math.abs(dy) > 4){ dragging.moved = true; spin = false; fly = null; }
    if(dragging.moved){ const s = 57.3/projection.scale(); projection.rotate([dragging.l + dx*s, flatOut() ? 0 : clamp(dragging.p - dy*s, -80, 80)]); dirty = true; }
    return;
  }
  if(state.view === 'trust' && !state.live){
    const ll = TR && lonLat(x, y), i = ll ? TR.at.get(Math.floor(ll[1]/TR.deg)*1e4 + Math.floor(ll[0]/TR.deg)) : undefined;
    if(i === undefined || countryAt(ll[0], ll[1]) < 0){ tip.hidden = true; return; }   // the sea part of a coastal unit is not drawn
    showTip(TR.cls[i] === 4 ? `Too few fires here to test (${fmt(TR.n[i])} detections in the test years).`
      : state.unit === 'viirs' ? `In test years, the monthly count estimated from the older satellites for this area (about ${kmOf(TR.deg)} km) was off by ${pct(TR.err[i])}.\nOlder satellite count, not converted: ${pct(TR.raw[i])}.\n${fmt(TR.n[i])} detections in the test.`
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
      else if(d.kind === 'mp'){ const P = MP, mi = P.minute[best], sat = P.h.sats[P.flags[best] >> 1];
        showTip(`${name}${P.day[best]} ${MON[m]} ${yr}, ${String(mi/60 | 0).padStart(2, '0')}:${String(mi%60).padStart(2, '0')} local time${P.flags[best] & 1 ? ' (night)' : ''}
${SATN[sat] || sat}${P.frp[best] > 0 ? `, ${+P.frp[best].toFixed(1)} MW` : ''}`, e.clientX, e.clientY); }
      else if(d.kind === 'p'){ const p = d.pts[best], smw = strongMW();
        showTip(`${dShort(p[2])}, ${p[3]} local time${p[5] === 'N' ? ' (night)' : ''}\n${smw != null && p[4] >= smw ? 'Strong fire. ' : ''}Burning ${p[6]} of ${Math.max(d.days, p[6])} days here`, e.clientX, e.clientY); }
      else { const v = d.v[best];
        showTip(d.anom ? `${name}${ratioText(v, `${MONTHS[m]} in this square`)}`
          : `${name}${v < 10 ? +v.toFixed(1) : fmt(v)} ${unitWord()} in this square of about 5 km, ${MON[m]} ${yr}`, e.clientX, e.clientY); }
      return;
    }
  }
  let best = -1, bd = Infinity;   // squares of any level: the one under the cursor, or the nearest within 6 px
  for(let i=0;i<SQ.n;i++){ const h = Math.max(SQ.s[i]/2, 6), dx = Math.abs(SQ.x[i] - x), dy = Math.abs(SQ.y[i] - y); if(dx > h || dy > h) continue; const dd = dx*dx + dy*dy; if(dd < bd){ bd = dd; best = i; } }
  if(best < 0){ if(st && !drawMode) showTip(`${st.name}\nClick to choose this area`, e.clientX, e.clientY); else tip.hidden = true; return; }
  const u = SQ.u[best], v = SQ.v[best], km = [50, 25, 10, 5][SQ.l[best]], nm = name || (u >= 0 && ctry[u] !== NONE ? COUNTRIES[ctry[u]] + '\n' : '');
  showTip(state.view === 'count' ? `${nm}${v < 10 && SQ.l[best] ? +v.toFixed(1) : fmt(v)} ${unitWord()} in this square of about ${km} km, ${MON[m]} ${yr}`
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
  setZoom(clamp(zoom*Math.exp(-e.deltaY*0.0015), 0.8, 150));
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
  bump(); saveHash(); renderCrumb();   // the selection outline is on the base map
  loadLive(); loadLook();
  return loadMonths();
}
async function loadMonths(){
  const sel = state.sel, unit = state.unit; $('panel').classList.add('busy');
  try {
    const r = await api(...request(mParam()));
    if(state.sel !== sel || state.unit !== unit) return;
    months = r.months; renderStatic(); renderTime();
    if(sel.polygon && r.polygon_exact === false) toast('Exact shapes are not available on this server. The surrounding box was used.');
  } catch(err){
    if(err.status === 409 && HAS.night){ HAS.night = false; syncTimeControls(); return loadMonths(); }   // old data: no day and night split
    if(state.sel === sel) toast('Could not load this area: ' + err.message);
  } finally { if(state.sel === sel) $('panel').classList.remove('busy'); }
}
function loadLive(){
  if(!HAS.live) return;
  const sel = state.sel, k = lcKey();
  api(...request(lParam(), 'api/live')).then(l => { if(state.sel === sel && lcKey() === k){ liveArea = l; renderAnswer(); renderLook(); legend(); dirty = true; } })
    .catch(() => { if(state.sel === sel && lcKey() === k){ liveArea = false; renderAnswer(); } });   // the answer works without it
}
function loadLook(){
  lookList = null; lookAll = false; renderLook();
  if(!HAS.live) return;
  const sel = state.sel, k = lcKey();
  api(...request(lParam(), 'api/live/places')).then(r => { if(state.sel === sel && lcKey() === k){ lookList = Array.isArray(r.places) ? r.places : null; lookFrom = r; renderLook(); } })
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
  flyTo(projection.rotate()[0], flatMap ? 0 : -20, flatMap ? flatFit() : 1);
  select({kind:'world', name:'Earth'}, null);
}
function renderCrumb(){
  const s = state.sel, el = $('crumb'), part = (label, on, act) => `<button type="button" class="${on ? 'on' : ''}" ${act ? `data-act="${act}"` : 'disabled'}>${esc(label)}</button>`;
  let h = part('World', s.kind === 'world', s.kind === 'world' ? '' : 'world');
  if(s.kind === 'country' || s.kind === 'state'){
    const c = s.kind === 'country' ? s.c : s.c;
    h += '<em>›</em>' + part(s.kind === 'country' ? s.name : (s.country || ''), s.kind === 'country', s.kind === 'state' && c >= 0 ? 'c' + c : '');
    if(s.kind === 'state') h += '<em>›</em>' + part(s.name, true, '');
  } else if(s.kind !== 'world') h += '<em>›</em>' + part(s.kind === 'box' ? (s.label || 'Box') : 'Drawn area', true, '');
  el.innerHTML = h;
}
$('crumb').addEventListener('click', e => { const b = e.target.closest('button[data-act]'); if(!b) return;
  if(b.dataset.act === 'world') clearPlace(); else selectCountry(+b.dataset.act.slice(1)); });
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
const unitWord = () => state.harm ? UNIT[state.unit].word : 'detections as reported';
const unitSentence = () => state.harm ? UNIT[state.unit].sentence : 'Counts as the satellites reported them. Years cannot be compared.';
// a month is estimated when the server says so; data from before the units change has no flag, then the era decides
const isEst = t => state.harm && !(months[t].measured ?? !UNIT[state.unit].est(t));
const srcWord = (x, t) => state.unit === 'viirs' ? (isEst(t) ? 'Estimated from the older satellites'
    : x.source === 'snpp_scaled' ? 'Measured by an earlier satellite of the newer kind, scaled to match today\'s' : 'Measured by the newer satellites')
  : x.source === 'aqua' ? 'Measured by the reference satellite' : x.source === 'terra_scaled' ? 'Estimated from an older satellite (less certain)' : 'Estimated from the newer satellites';

/* ---------- answer ---------- */
const cal = $('cal'), Wv = 360, L = 38, Rm = 10, Tp = 8, B = 20, iw = Wv - L - Rm, sfmt = d3.format('~s');
let calColor = [], calTip = [];
for(const id of ['yFrom','yTo']) for(const y of YEARS) $(id).add(new Option(y, y));
$('yFrom').value = YEARS[0]; $('yTo').value = YEARS.at(-1);
$('tRange').max = T - 1;
const yearRange = () => { const a = +$('yFrom').value, b = +$('yTo').value; return [Math.min(a, b), Math.max(a, b)]; };
const tipOf = t => { const m = months[t], est = isEst(t); let s = `${MON[monOf(t)]} ${yearOf(t)}: ${fmt(S[t])} ${unitWord()}`;
  if(state.harm && (est || m.low !== m.high)) s += '\n' + (est ? 'estimated' : '') + (est && m.low !== m.high ? ', ' : '') + (m.low !== m.high ? `likely ${fmt(m.low)} to ${fmt(m.high)}` : '');
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
  $('calEst').hidden = !months.some((_, t) => isEst(t));
  renderCalendar(); renderYears(); renderCheck();
}

function renderCalendar(){
  const [a, b] = yearRange(), tot = YEARS.map(y => d3.sum(d3.range(12), m => S[tOf(y, m)] || 0)), tmax = d3.max(tot) || 1;
  const firstViirs = months.findIndex(m => m.raw.n20 + m.raw.snpp > 0);
  cal.className = state.cal === 'grid' ? 'cal' : 'cal rings';
  if(state.cal === 'rings'){
    const Rr = 180, r0 = 26, dr = (Rr - 18 - r0)/YEARS.length, arc = d3.arc();
    let h = `<svg viewBox="${-Rr} ${-Rr} ${2*Rr} ${2*Rr}" role="img" aria-label="Fire rings: one ring per year, months around like a clock">`
      + '<defs><pattern id="estH" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="1.2" height="4" fill="rgba(6,10,19,.6)"/></pattern></defs>';
    YEARS.forEach((y, i) => { for(let m=0;m<12;m++){ const t = tOf(y, m); if(t < 0 || t >= T) continue;
      const d = arc({innerRadius:r0 + i*dr, outerRadius:r0 + (i + 1)*dr - 0.5, startAngle:m*Math.PI/6 + 0.01, endAngle:(m + 1)*Math.PI/6 - 0.01});
      h += `<path data-t="${t}" class="${t === state.t ? 'now' : ''}" fill="${calColor[t] || C['surface-2']}" data-tip="${calTip[t]}" d="${d}"/>`
        + (isEst(t) ? `<path class="est" fill="url(#estH)" d="${d}"/>` : ''); } });
    MON.forEach((mn, m) => { const an = (m + .5)*Math.PI/6; h += `<text x="${Math.sin(an)*(Rr - 8)}" y="${-Math.cos(an)*(Rr - 8) + 3}" text-anchor="middle">${mn}</text>`; });
    cal.innerHTML = h + `<text text-anchor="middle" y="-2">${YEARS[0]}</text><text text-anchor="middle" y="9">inside</text></svg>`;
    return;
  }
  let h = '<div class="cal-row head"><span></span>' + MON.map(m => `<span>${m[0]}</span>`).join('') + '<span>Year</span></div>';
  YEARS.forEach((y, i) => {
    if(state.harm && y === UNIT[state.unit].mark[0]) h += `<div class="era-mark">${y}: ${UNIT[state.unit].mark[1]}</div>`;
    if(!state.harm && firstViirs >= 0 && y === yearOf(firstViirs)) h += `<div class="era-mark">${y}: a newer satellite starts and sees more small fires</div>`;
    h += `<div class="cal-row${y < a || y > b ? ' out' : ''}"><span class="cal-y">${y}</span>`;
    for(let m=0;m<12;m++){ const t = tOf(y, m);
      h += t < 0 || t >= T ? '<div class="cell none"></div>' : `<div class="cell${t === state.t ? ' now' : ''}${isEst(t) ? ' est' : ''}" data-t="${t}" data-tip="${calTip[t]}" style="background-color:${calColor[t]}"></div>`; }
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
}

const pbDay = d => dShort(new Date(PB.first.getTime() + d*864e5).toISOString().slice(0, 10));   // day d of the week file, as "9 Nov"
const liveLabel = () => dayPick < 0 || !PB ? 'Last 7 days' : `Last 7 days: ${pbDay(dayPick)} only`;
function renderDays(){   // the ruler in the last 7 days: the left end is all days, then one mark per day
  const n = +$('dRange').max, x = v => (100*v/n).toFixed(3) + '%';
  let h = ''; for(let v=0;v<=n;v++) h += `<i class="r-tick major" style="left:${x(v)}"></i><span class="r-lab" style="left:${x(v)}">${v ? pbDay(v - 1) : 'All'}</span>`;
  $('dRuler').innerHTML = h + `<i class="r-now" style="left:${x(dayPick + 1)}"></i>`;
}
function renderTime(){
  const t = state.t;
  $('readout').textContent = state.live ? liveLabel() : `${dayOn() ? state.day + ' ' : ''}${MONTHS[monOf(t)]} ${yearOf(t)}`;
  $('tRange').value = t;
  const tl = state.live ? T-1 : t, dd = $('dDay'), nd = dimOf(tl);   // the dock's day, month and year follow the map
  if(dd.length !== nd + 1){ dd.length = 1; for(let i=1;i<=nd;i++) dd.add(new Option(i, i)); }
  dd.value = state.live ? 0 : state.day; $('dMon').value = monOf(tl); $('dYear').value = yearOf(tl);
  const days = state.live && !!PB;   // in the last 7 days the slider and the ruler pick a day
  $('tRange').hidden = $('ruler').hidden = days; $('dRange').hidden = $('dRuler').hidden = !days; if(days) renderDays();
  $('sensorNow').textContent = state.live ? 'Newer satellite, first numbers' + (!state.harm ? ', as reported' : state.unit === 'viirs' ? '' : ', strict count')
    : dayOn() ? daySpan()
    : state.harm ? UNIT[state.unit].now(t) + (t >= PROV ? ', first numbers' : '')
    : 'Counts as reported' + (months && months[t].raw.n20 + months[t].raw.snpp > 0 ? ', newer satellites included' : '');
  syncWhen(); legend(); dirty = true; renderRuler();
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
function setStatus(icon, dir, level, line, src, ratio){
  $('stIcon').textContent = icon; $('stIcon').className = 'v-icon ' + dir; $('status').className = 'status ' + dir;
  $('stLevel').textContent = level; $('stLine').textContent = line; $('stSrc').textContent = src;
  const g = ratio != null && isFinite(ratio); $('gauge').hidden = !g;   // marker at the ratio, 1/4x to 4x like the map
  if(g) $('gaugeMark').style.left = (100*anomU(ratio)).toFixed(1) + '%';
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
    else { const r = lw.n/Math.max(lw.normal, 1), L = LEVEL[ratioLevel(r)]; setStatus(L[0], L[1], L[2], ratioText(r, `${MONTHS[lw.lm]} week`) + '.', src, r); }
  } else if(!state.harm){
    setStatus('●', 'flat', 'Counts as reported', `${fmt(cur)} fire detections in ${MONTHS[m]} ${yr}.`, `These counts cannot be compared across years. Choose "${UNIT[UNITS[0]].label}" under Counts in the research tools for a verdict.`);
  } else if(d3.max(S) < 1){
    setStatus('', 'flat', 'No fires on record', `Nothing on record in this area since ${Y0}.`, '');
  } else {
    const n = months.filter((_, i) => monOf(i) === m).length;
    const src = `${tm}${srcWord(x, t)}${x.low !== x.high ? `. Likely ${fmt(x.low)} to ${fmt(x.high)}` : ''}. ${fmt(cur)} ${unitWord()}, ${ordinal(x.rank)} highest of ${n} ${MONTHS[m]}s on record.`
      + (x.filled >= 1 ? ` Includes ${fmt(x.filled)} for days when the reference satellite did not record.` : '');
    if(x.anomaly === 'insufficient' && cur < 5) setStatus('●', 'flat', 'Off season', `Hardly any fire in a normal ${MONTHS[m]} here.`, src);
    else if(x.anomaly === 'insufficient') setStatus('▲', 'up', 'Higher than normal', `${fmt(cur)} fire detections in a month that is usually quiet here.`, src);
    else { const L = LEVEL[x.anomaly] || ['●', 'flat', 'Normal'], r = cur/Math.max(x.median, 1); setStatus(L[0], L[1], L[2], ratioText(r, MONTHS[m]) + '.', src, r); }
  }

  const sm = lastSeason = seasonModel(t), tl = [];
  if(HAS.live && liveArea !== false) tl.push(['Last 7 days', lw ? fmt(lw.n) : '…', lw && lw.normal != null ? `${unitWord()}. A normal ${MONTHS[lw.lm]} week has about ${fmt(lw.normal)}.` : unitWord()]);
  tl.push([t === T-1 ? `This month (${MON[m]} ${yr})` : `${MONTHS[m]} ${yr}`, fmt(cur), state.harm ? `${unitWord()}${isEst(t) ? ', estimated' : ''}. Normal is about ${fmt(x.median)}.` : unitWord()]);
  tl.push(['Season so far', sm && sm.ratio != null ? pct(sm.ratio) : '–', sm && sm.ratio != null ? `of a normal season, since ${MON[sm.start]} ${yearOf(sm.t0)}` : 'Too early in the season to tell']);
  lastTiles = tl;
  const big = state.live && tl.length === 3 ? 0 : tl.length - 2;   // the period you are looking at leads
  $('tiles').innerHTML = [tl[big], ...tl.filter((_, i) => i !== big)].map(([a, v, s], i) => i === 0
    ? `<div class="fig"><span class="t-name">${esc(a)}</span><span class="t-val">${esc(v)}</span><span class="t-sub">${esc(s)}</span></div>`
    : `<div class="row-fig"><span class="t-name">${esc(a)}</span><span class="t-val">${esc(v)}</span><span class="t-sub">${esc(s)}</span></div>`).join('');

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
  renderTech(x, cur);
  renderCard();
}
function renderCard(){
  const s = state.sel, fig = document.querySelector('#tiles .fig'), est = state.harm && !state.live && isEst(state.t);
  $('mcPlace').textContent = `${s.kind === 'world' ? 'Earth' : s.name} · ${$('pSub').textContent}`;
  $('mcBig').textContent = fig ? fig.querySelector('.t-val').textContent : '';
  $('mcUnit').textContent = !state.harm ? 'fire detections, as reported' : (state.unit === 'viirs' ? 'fire detections, VIIRS counts' : 'fire detections, strict long record') + (est ? ', estimated' : '');
  $('mcGauge').hidden = $('gauge').hidden; $('mcMark').style.left = $('gaugeMark').style.left;
  $('mcLine').textContent = $('stLine').textContent;
}

// the "source" of a month in the calendar response (app.py): VIIRS units first, then the strict record
const SRC_LONG = {terra_up:'Terra MODIS, estimated in VIIRS counts', modis_up:'Aqua and Terra MODIS, estimated in VIIRS counts', snpp_scaled:'VIIRS Suomi NPP, scaled to NOAA-20',
  n20:'VIIRS NOAA-20, as measured', snpp:'VIIRS Suomi NPP, as measured', terra_scaled:'Terra MODIS, scaled to Aqua', aqua:'Aqua MODIS, as measured',
  n20_model:'VIIRS NOAA-20, adjusted to Aqua', snpp_model:'VIIRS Suomi NPP, adjusted to Aqua'};
const unitName = () => state.unit === 'viirs' ? VAL.viirs.unit : VAL.unit;
const trow = (k, v, note) => `<tr><th scope="row">${k}</th><td>${v}${note ? `<span class="tn">${note}</span>` : ''}</td></tr>`;
const num = v => v == null || !isFinite(v) ? '–' : fmt(v);
function renderTech(x, cur){
  let h = '';
  const vi = state.unit === 'viirs';
  if(state.live){
    $('techSpan').textContent = liveArea ? `${liveArea.from} to ${liveArea.to}` : '';
    if(liveArea) h = trow('Sensor', esc(liveArea.sensor || 'VIIRS NOAA-20, near-real-time'))
      + trow('Detections', num(liveArea.raw), 'after the confidence and static-source filters')
      + trow(vi ? 'In VIIRS counts' : 'In the strict record', num(liveArea.harmonized), vi ? 'the main count is VIIRS, so no conversion' : 'converted to Aqua units with the same tables')
      + (liveArea.night_share != null ? trow('Night share', pct(liveArea.night_share)) : '')
      + (liveArea.strong != null ? trow('Strong detections', `${num(liveArea.strong)}`, `FRP ≥ ${num(liveArea.strong_mw)} MW (90th percentile of the week)`) : '')
      + (liveArea.static_removed != null ? trow('Static sources removed', num(liveArea.static_removed), 'gas flares, volcanoes, industry') : '');
    else h = trow('Status', 'Loading the last 7 days…');
  } else {
    const t = state.t, m = monOf(t), n = months.filter((_, i) => monOf(i) === m).length, P = x.pred || {}, B = UNIT[state.unit].base;
    $('techSpan').textContent = `${MONTHS[m]} ${yearOf(t)}`;
    h = trow('Unit', state.harm ? esc(unitName()) : 'detections as reported')
      + trow(state.harm ? 'Value shown' : 'Value shown (raw)', num(cur), state.time !== 'all' ? `${state.time} fires only` : '')
      + (state.harm ? trow('Likely range', x.low !== x.high ? `${num(x.low)} – ${num(x.high)}` : 'measured, no range', x.low !== x.high ? '10th to 90th percentile of hidden-year errors at this size' : '')
        + trow('Source', esc(SRC_LONG[x.source] || x.source), isEst(t) ? 'estimated' : 'measured') : '')
      + trow('Raw counts', Object.keys(SENSOR).filter(k => x.raw[k]).map(k => `${SENSOR[k]} ${num(x.raw[k])}`).join('<br>') || '0')
      + (x.filled >= 1 ? trow('Filled from Terra', num(x.filled), 'days Aqua did not record') : '')
      + (vi ? (P.modis > 0 && !isEst(t) ? trow('Out-of-sample check', `Estimate from MODIS: ${num(P.modis)}`, 'from ratios fitted without this year') : '')
         : (P.snpp || P.n20 ? trow('Out-of-sample check', `VIIRS adjusted to Aqua: ${num(P.snpp || P.n20)}`, 'from tables fitted without this year') : ''))
      + trow(`Median ${B[0]}–${B[1]}`, num(x.median))
      + trow('Ratio to median', x.median > 0 ? (cur/x.median).toFixed(2) + '×' : '–')
      + trow('Anomaly class', esc((x.anomaly || '–').replace(/_/g, ' ')), 'from the 10/33/67/90 % quantiles of the normal years')
      + trow('Rank', `${ordinal(x.rank)} of ${n} ${MONTHS[m]}s`)
      + (x.night != null && x.harmonized > 0 ? trow('Night share', pct(x.night/x.harmonized), x.night_median != null && x.median > 0 ? `normal ${pct(x.night_median/x.median)}` : '') : '')
      + (x.frp != null ? trow('Fire radiative power', `${num(x.frp)} MW`, x.frp_median > 0 ? `${(x.frp/x.frp_median).toFixed(2)}× the median month` : '') : '');
  }
  $('techTable').innerHTML = h;
  renderAccess();
}
function renderMethod(){   // how the record of the current unit is made, and how it did on years left out of the fit (validation.json)
  const V = VAL.viirs, o = SAT.overall, ag = SAT.anomaly_agreement;
  $('methodTable').innerHTML = state.unit === 'viirs' && V
    ? trow('Unit', esc(V.unit))
      + trow('Reference', SENSOR[V.reference.toLowerCase()] || esc(V.reference), `measured from ${monthName(VSTART)}`
        + (V.ref_start && V.ref_start.slice(0, 7) !== V.start.slice(0, 7) ? `; ${SENSOR.snpp} until ${monthName(tAt(V.ref_start))}, scaled to match` : ''))
      + trow('Earlier months', 'Estimated from MODIS', `ratio of VIIRS to MODIS per 5° tile and calendar month; Aqua weighs ${pct(V.weight_aqua)}, Terra ${pct(1 - V.weight_aqua)}`)
      + trow('Fit window', `${V.window[0]} – ${V.window[1]}`, 'MODIS and VIIRS both flying')
      + trow('Hidden-year error', pct(V.both.error), `Aqua alone ${pct(V.aqua.error)} · Terra alone ${pct(V.terra.error)}`)
      + trow('Total bias', V.both.bias.toFixed(3), 'estimate / measured, all hidden years')
      + (V.both.night != null ? trow('Night error', pct(V.both.night)) : '')
      + (V.twin ? trow('Two VIIRS instruments', pct(V.twin.raw), `as reported; ${pct(V.twin.scaled)} after scaling. No method can do better.`) : '')
      + (V.both.anomaly_agreement ? trow('Same anomaly class', pct(V.both.anomaly_agreement.same), `same or next: ${pct(V.both.anomaly_agreement.within_one)}`) : '')
      + trow('Normal years', `${UNIT.viirs.base[0]}–${UNIT.viirs.base[1]}`, 'measured years only')
    : trow('Unit', esc(VAL.unit))
      + trow('Reference', SENSOR.aqua, `measured ${monthName(AQUA)} to ${monthName(MODEL - 1)}`)
      + trow('Method', 'Conversion tables by fire strength', `then a monthly ratio per region; ${SENSOR[PKEY]} adjusted from ${monthName(MODEL)}`)
      + trow('Fit window', `${SAT.window[0]} – ${SAT.window[1]}`, 'Aqua and VIIRS both flying, stable Aqua orbit')
      + trow('Hidden-year error', pct(o.table), `raw ${pct(o.raw)} · one factor ${pct(o.global_factor)} · ratio ${pct(o.ratio)}`)
      + (o.bias_table != null ? trow('Total bias', o.bias_table.toFixed(3), 'converted / measured, all hidden years') : '')
      + (o.day != null ? trow('Day / night error', `${pct(o.day)} / ${pct(o.night)}`) : '')
      + trow('Terra conversion', pct(VAL.terra.error), 'months before August 2002')
      + (VAL.twin ? trow('Two VIIRS instruments', `${pct(VAL.twin.overlap)} per tile-month`, `after 2021: ${pct(VAL.twin.after)}`) : '')
      + (ag ? trow('Same anomaly class', pct(ag.table), `same or next: ${pct(ag.table_within_one)}`) : '')
      + trow('Normal years', `${UNIT.aqua.base[0]}–${UNIT.aqua.base[1]}`);
  $('methodNote').textContent = 'Error = sum |estimate − measured| / sum measured, per 5° tile and month, on years left out of the fit. Values are for the data this server was built from.';
}
function renderAccess(){
  const [path, opt] = request(mParam()), abs = p => new URL(p, location.href).href;
  const rows = opt.method === 'POST'
    ? `<p>This area is a drawn polygon. Send it as JSON: <code>POST ${esc(abs('api/calendar'))}</code> with <code>{"polygon": …}</code>; add <code>"format": "csv"</code> for a table.</p>`
    : `<p><span class="ak">Monthly record (JSON)</span><a href="${esc(abs(path))}" target="_blank" rel="noopener"><code>${esc(path)}</code></a></p>
       <p><span class="ak">Monthly record (CSV)</span><a href="${esc(abs(path + '&format=csv'))}"><code>${esc(path)}&amp;format=csv</code></a></p>`;
  $('accessBody').innerHTML = rows
    + `<p><span class="ak">Validation results (JSON)</span><a href="${esc(abs('api/validation'))}" target="_blank" rel="noopener"><code>api/validation</code></a></p>
       <p><span class="ak">Single detections</span>Download detections (CSV) at the bottom of this panel, for the selected area and the years of the time range.</p>
       <p><span class="ak">Data</span>NASA FIRMS: MODIS Collection 6.1 (MCD14ML) and VIIRS 375 m (VNP14IMGT, VJ114IMGT), standard processing; last 7 days from the FIRMS near-real-time NOAA-20 file. We acknowledge the use of data from NASA's Fire Information for Resource Management System (FIRMS), part of NASA's Earth Science Data and Information System (ESDIS).</p>
       <p><span class="ak">Cite this record</span>blazeBridge (2026). Harmonized MODIS and VIIRS active-fire record, ${Y0}–${yearOf(T-1)}, in ${esc(state.harm ? unitName() : 'detections as reported')}. Built from NASA FIRMS. Not endorsed by NASA.</p>`;
}

function renderLook(){
  const P = lookList;
  $('lookSec').hidden = !(P && P.length);
  if(!P || !P.length) return;
  $('lookSub').textContent = `Last 7 days${lookFrom && lookFrom.to ? `, up to ${dShort(lookFrom.to)}` : ''}. Most urgent first.`;
  const sr = liveArea ? liveArea.static_removed : null, sea = liveArea ? liveArea.sea_removed : null;
  $('lookNote').textContent = (sr > 0 ? `${fmt(sr)} detections at industrial heat sources are left out.`
    : meta.static_mask === false ? 'Industrial heat sources are not filtered in this data set.' : '') + (sea > 0 ? ` ${fmt(sea)} detections over the sea are left out.` : '');
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
  const x = i => L + 8 + (iw - 16)*i/11, line = d3.line().defined(ok).x((d, i) => x(i)).y(d => sc(d));
  const fy = sm.start === 0 ? `${yearOf(sm.t0)}` : `${yearOf(sm.t0)}–${String(yearOf(sm.t0) + 1).slice(2)}`;
  const est = d3.range(Math.max(0, sm.t0), sm.t0 + sm.k + 1).some(isEst), ec = est ? ' est' : '';
  let h = `<svg viewBox="0 0 ${Wv} ${Hv}" role="img" aria-label="Fire detections added up since ${MONTHS[sm.start]}, this season against a normal season">`;
  sc.ticks(3).forEach(v => { h += `<line class="grid" x1="${L}" x2="${Wv-Rm}" y1="${sc(v)}" y2="${sc(v)}"/><text class="axis" x="${L-6}" y="${sc(v)+4}" text-anchor="end">${sfmt(v)}</text>`; });
  d3.range(12).forEach(i => { h += `<text class="axis" x="${x(i)}" y="${Hv-5}" text-anchor="middle">${lab(i)[0]}</text>`; });
  const bw = Math.min(16, iw/12*0.62);
  d3.range(12).forEach(i => { h += `<line class="range" x1="${x(i)}" x2="${x(i)}" y1="${sc(sm.q10[i])}" y2="${sc(sm.q90[i])}"/>`; });
  d3.range(12).forEach(i => { if(!ok(sm.cur[i])) return; const y = sc(sm.cur[i]);
    h += `<rect class="${i === sm.k ? 'bar-now' : 'bar'}${ec}" x="${x(i) - bw/2}" y="${y}" width="${bw}" height="${Math.max(0, sc(0) - y)}" rx="1.5"/>`; });
  h += `<path class="med" d="${line(sm.q50)}"/>`;
  d3.range(12).forEach(i => { h += `<rect class="hit" x="${x(i)-iw/22}" y="${Tp}" width="${iw/11}" height="${ih}" data-tip="To the end of ${lab(i)}&#10;This season: ${ok(sm.cur[i]) ? fmt(sm.cur[i]) + (est ? ', estimated' : '') : 'not yet'}&#10;Normal: ${fmt(sm.q50[i])}&#10;8 of 10 seasons: ${fmt(sm.q10[i])} to ${fmt(sm.q90[i])}"/>`; });
  $('season').innerHTML = h + '</svg>';
  $('seasonSpan').textContent = `added up since ${MONTHS[sm.start]}`;
  $('keyYear').textContent = `This season (${fy}${est ? ', estimated' : ''})`;
}

function renderYears(){
  const Hv = 140, ih = Hv - Tp - B, [a, b] = yearRange(), ys = YEARS.filter(y => y >= a && y <= b), harm = state.harm, vi = state.unit === 'viirs';
  const rows = ys.map(y => { const ts = d3.range(12).map(m => tOf(y, m)).filter(t => t >= 0 && t < T), ms = ts.map(t => months[t]);
    return {y, n:ms.length, harm:d3.sum(ms, m => m.harmonized), low:d3.sum(ms, m => m.low), high:d3.sum(ms, m => m.high), src:ms.at(-1).source,
            est:ts.some(isEst), raw:Object.fromEntries(Object.keys(SENSOR).map(k => [k, d3.sum(ms, m => m.raw[k])]))}; });   // one estimated month makes the year estimated
  const top = d3.max(rows, r => harm ? Math.max(r.harm, r.high) : d3.sum(Object.values(r.raw))) || 1;
  const sc = d3.scaleLinear().domain([0, top]).nice(3).range([Tp + ih, Tp]), bw = iw/rows.length, x = i => L + i*bw;
  let h = `<svg viewBox="0 0 ${Wv} ${Hv}" role="img" aria-label="Fire detections per year">`;
  sc.ticks(3).forEach(v => { h += `<line class="grid" x1="${L}" x2="${Wv-Rm}" y1="${sc(v)}" y2="${sc(v)}"/><text class="axis" x="${L-6}" y="${sc(v)+4}" text-anchor="end">${sfmt(v)}</text>`; });
  rows.forEach((r, i) => {
    if(r.y % 5 === 0) h += `<text class="axis" x="${x(i) + bw/2}" y="${Hv-5}" text-anchor="middle">${r.y}</text>`;
    const rect = (cls, v0, v1, tipText) => `<rect class="${cls}" x="${x(i) + 1}" width="${Math.max(1, bw - 2)}" y="${sc(v1)}" height="${Math.max(0, sc(v0) - sc(v1))}" data-tip="${tipText}"/>`;
    if(harm){
      const part = r.n < 12 ? ` (${r.n} months)` : '';
      const rng = r.high > r.low ? `likely ${fmt(r.low)} to ${fmt(r.high)}` : '';
      h += rect((vi || !['aqua', 'terra_scaled'].includes(r.src) ? 'bar-viirs' : r.src === 'aqua' ? 'bar-aqua' : 'bar-terra') + (r.est ? ' est' : ''), 0, r.harm,
        `${r.y}${part}: ${fmt(r.harm)} ${unitWord()}` + (r.est ? `&#10;estimated${rng ? ', ' + rng : ''}` : rng ? '&#10;' + rng : ''));
      if(r.high > r.low) h += `<line class="whisk" x1="${x(i) + bw/2}" x2="${x(i) + bw/2}" y1="${sc(r.low)}" y2="${sc(r.high)}"/>`;
    } else { let base = 0; const all = Object.keys(SENSOR).filter(k => r.raw[k]).map(k => `${PLAIN[k]}: ${fmt(r.raw[k])}`).join('&#10;');
      for(const k of Object.keys(SENSOR)){ if(!r.raw[k]) continue; h += rect('bar-' + k, base, base + r.raw[k], `${r.y}&#10;${all}`); base += r.raw[k]; } }
  });
  $('years').innerHTML = h + '</svg>';
  const sq = (c, tx, est) => `<span><span class="sq${est ? ' est' : ''}" style="background:${c}"></span>${tx}</span>`;
  $('yearsUnit').textContent = harm ? unitWord() : 'as reported, all satellites';
  $('yearsKey').innerHTML = !harm ? sq(C.cool, PLAIN.terra) + sq(C.accent, PLAIN.aqua) + sq('#c9662b', PLAIN.snpp) + sq(C['fire-mid'], PLAIN.n20) + '<span>The jump is the new satellite, not more fire.</span>'
    : (vi ? sq(C['fire-mid'], 'Measured') + sq(C['fire-mid'], 'Estimated from older satellites', true)
       : sq(C.cool, 'Older satellite (estimated)', true) + sq(C.accent, 'Reference satellite (measured)') + sq(C['fire-mid'], 'Newer satellites (estimated)', true)) + '<span>White line: likely range</span>';
}

// Sensor check, in the years both flew. Strict record: adjusted VIIRS on top of measured Aqua. Main unit: the estimate from
// MODIS on top of measured VIIRS. The estimates shown here come from tables fitted without the year they are compared in.
function renderCheck(){
  const V = VAL.viirs, v = !!(V && months[0].pred && 'modis' in months[0].pred);   // read from the data, so a unit switch in flight never mixes the two
  const win = v ? V.window : SAT.window, Hv = 120, ih = Hv - Tp - B, t0 = tAt(win[0]), t1 = Math.min(T-1, tAt(win[1])), ts = d3.range(t0, t1 + 1), n = ts.length;
  const aq = ts.map(t => v ? months[t].harmonized : months[t].raw.aqua), cv2 = ts.map(t => v ? months[t].pred.modis : months[t].pred[PKEY]), rw = ts.map(t => months[t].raw[PKEY]);
  $('chkA').textContent = v ? 'VIIRS, measured' : 'Aqua MODIS, measured';
  $('chkB').textContent = v ? 'Estimate from MODIS Aqua and Terra (not used to fit it)' : 'VIIRS, adjusted (not used to fit it)';
  $('limits').innerHTML = [v ? `Months before ${monthName(VSTART)} are estimates from the older satellites. They cannot be checked directly.` : 'Since 2022 the adjusted numbers cannot be checked against the reference satellite.',
    'Clouds hide fires. A cloudy month looks like a quiet month.', PROV < T ? `The months from ${monthName(PROV)} and the last 7 days are first numbers and can change.` : 'The last 7 days are first numbers and can change.'].map(s => `<li>${s}</li>`).join('');
  const tests = v ? ` In hidden-year tests, per 5° tile and month, the estimate was off by ${pct(V.both.error)} from Aqua and Terra together and ${pct(V.terra.error)} from Terra alone.`
    + (V.twin ? ` Two identical satellites differ by about ${pct(V.twin.raw)}: no method can do better.` : '') : '';
  $('checkSpan').textContent = `${yearOf(t0)} to ${yearOf(t1)}`;
  if(v && state.time !== 'all'){   // the estimate exists for all fires only
    $('check').innerHTML = ''; $('checkLine').textContent = 'This check compares all fires. Choose "All fires" under Time of day to see it.' + tests; return;
  }
  const sc = d3.scaleLinear().domain([0, Math.max(1, d3.max(aq), d3.max(cv2))]).nice(3).range([Tp + ih, Tp]);
  const x = i => L + iw*i/(n - 1), line = d3.line().x((d,i) => x(i)).y(d => sc(d));
  let h = `<svg viewBox="0 0 ${Wv} ${Hv}" role="img" aria-label="${v ? 'Monthly detections: VIIRS measured and the estimate from MODIS' : 'Monthly detections: Aqua measured and VIIRS adjusted'}">`;
  sc.ticks(3).forEach(v => { h += `<line class="grid" x1="${L}" x2="${Wv-Rm}" y1="${sc(v)}" y2="${sc(v)}"/><text class="axis" x="${L-6}" y="${sc(v)+4}" text-anchor="end">${sfmt(v)}</text>`; });
  ts.forEach((t, i) => { if(monOf(t) === 0) h += `<text class="axis" x="${x(i)}" y="${Hv-5}" text-anchor="middle">${yearOf(t)}</text>`; });
  h += `<path class="cur" d="${line(aq)}"/><path class="conv" d="${line(cv2)}"/>`;
  ts.forEach((t, i) => { h += `<rect class="hit" x="${x(i)-iw/(2*(n-1))}" y="${Tp}" width="${iw/(n-1)}" height="${ih}" data-tip="${MON[monOf(t)]} ${yearOf(t)}&#10;`
    + (v ? `VIIRS measured: ${fmt(aq[i])}&#10;Estimate from MODIS: ${fmt(cv2[i])}` : `Aqua measured: ${fmt(aq[i])}&#10;VIIRS adjusted: ${fmt(cv2[i])}&#10;VIIRS as reported: ${fmt(rw[i])}`) + '"/>'; });
  $('check').innerHTML = h + '</svg>';
  const tot = d3.sum(aq), err = tot ? d3.sum(aq, (v, i) => Math.abs(cv2[i] - v))/tot : NaN;
  $('checkLine').textContent = (tot < 50 ? 'Too few fire detections here to compare the satellites.'
    : v ? `In the years both flew, the estimate from the older satellites (MODIS) is off by ${pct(err)} of the measured VIIRS total here, month by month.`
    : `In the years both flew, adjusted ${SENSOR[PKEY]} is off by ${pct(err)} of the Aqua total here, month by month. Unadjusted, VIIRS reports ${(d3.sum(rw)/tot).toFixed(1)} times more.`) + tests;
}

/* ---------- controls ---------- */
function setT(t){ state.t = clamp(t, 0, T-1); state.day = Math.min(state.day, dimOf(state.t)); if(state.t !== T-1) state.pick = true; if(state.live) setLive(false); else renderTime(); }
const dayAfter = (t, d) => d < dimOf(t) ? [t, d + 1] : t < PLAY.to ? [t + 1, 1] : PLAY.loop ? [PLAY.from, 1] : null;   // the next day of Play, or null at the end
function stepDay(k){   // one day back or on, rolling into the next or last month
  let t = state.t, d = state.day + k;
  if(d < 1){ if(t <= 0) return; d = dimOf(--t); } else if(d > dimOf(t)){ if(t >= T-1) return; t++; d = 1; }
  state.day = d; setT(t);
}
function setPlaying(p){
  if(p){ setLive(false);
    if(dayOn() && state.t >= PLAY.from && state.t <= PLAY.to){ if(!dayAfter(state.t, state.day) && !PLAY.loop){ state.day = 1; setT(PLAY.from); } }   // a day: go on from it
    else if(state.t < PLAY.from || state.t >= PLAY.to) setT(PLAY.from); }
  playing = p; playAcc = 0; $('play').innerHTML = p ? `<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2.5 1.5h2.4v9H2.5zM7.1 1.5h2.4v9H7.1z" fill="currentColor"/></svg> Pause` : `<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M3 1.5l7 4.5-7 4.5z" fill="currentColor"/></svg> Play`;
  if(!p) saveHash();
}
const check = (name, v) => { const r = document.querySelector(`input[name=${name}][value=${v}]`); if(r) r.checked = true; };
// counts: a unit ('viirs', 'aqua') or 'raw'. A new unit reloads the area's months; place, month and view stay.
function setCounts(v){
  const unit = v === 'raw' ? state.unit : v, changed = unit !== state.unit;
  state.harm = v !== 'raw'; state.unit = unit; useUnit();
  if(changed){ loadMonths(); liveArea = null; loadLive(); loadLook(); if(state.live && !liveCells.has(lcKey())) loadCells(); if(months) renderTime(); }
  else if(months){ renderStatic(); renderTime(); }
  legend(); dirty = true; saveHash();
}
const countsNow = () => state.harm ? state.unit : 'raw';
function useUnit(){   // globe grids, colour scale, baseline years, confidence map and texts of the current unit
  const u = UNIT[state.unit], g = u.grid;
  Hm = g.h; Nt = g.n; VMAX = g.vmax ??= vmaxOf(g.h); BASE = d3.range(u.base[0], u.base[1] + 1);
  TR = TRS ? TRS[state.unit] : null;
  check('counts', countsNow());
  trustScale(); buildAbout(); renderMethod(); bump();
}
function setView(view){
  if(view === 'trust' && trustOff) view = 'count';   // no confidence map on this server
  state.view = view; check('view', view);
  document.querySelectorAll('.vbox[data-view]').forEach(b => b.setAttribute('aria-pressed', b.dataset.view === view));
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
  if(state.live && !liveCells.has(lcKey())) loadCells();
  legend(); dirty = true; saveHash();
}
function loadCells(){
  const k = lcKey();
  api('api/live/cells?' + new URLSearchParams(lParam())).then(r => { liveCells.set(k, r.cells || []); dirty = true; })
    .catch(err => { toast('The last 7 days are not available: ' + err.message); if(state.live) setLive(false); });
}
function setLive(on){
  if(on && !HAS.live) return;
  state.live = on; if(on) state.pick = false;
  syncTimeControls(); renderTime(); bump();   // the confidence map is hidden in the last 7 days
  if(on && !liveCells.has(lcKey())) loadCells();
}
function legend(){
  const tm = state.live || gTime() !== 'all' ? {all:'', day:'day ', night:'night '}[state.time] : '', sq = [50, 25, 10, 5, 5, 5][fireLevel] || 50;
  const dots = fireLevel === 5 && MP ? `<span class="lstep"><span class="box" style="background:${C.fg}"></span>one ${tm}detection, any satellite${MP.h.truncated ? ` (the strongest ${fmt(MP.n)})` : ''}</span>` : '';
  const est = state.harm && UNIT[state.unit].est(state.t) ? '<span class="lest">Estimated month, not measured</span>' : '';
  $('legend').innerHTML = dayOn() ? `<span class="lstep"><span class="dotk" style="background:${PTC[1]}"></span>One ${tm}fire detection, any satellite. Single days are not adjusted between satellites.</span>`
    : state.view === 'trust' && !state.live
    ? !TR ? (TRS ? 'No confidence map for this count yet. Rebuilding the data adds it.' : 'Loading the confidence map…')
      : `How far off the ${state.unit === 'viirs' ? 'monthly estimate from the older satellites' : 'adjusted monthly count'} for an area of about ${kmOf(TR.deg)} km was in test years: ` + TRUST.map(s => `<span class="lstep"><span class="box" style="background:${s[1]}"></span>${s[2]}</span>`).join('')
        + '<span class="lstep"><span class="box hatch"></span>too few fires to test</span>'
    : state.live && fireLevel === 4 ? `Each dot is one ${tm}fire detection in the last 7 days: ` + ['weak', 'medium', 'strong'].map((w, i) => `<span class="lstep"><span class="dotk" style="background:${PTC[i]}"></span>${w}</span>`).join('')
    : state.live ? `<span>Fewer</span><span class="ramp seq"></span><span>More ${tm}fire detections in the last 7 days, per square of about 50 km</span>`
    : state.view === 'anom' ? `<span>Lower than normal</span><span class="ramp div"></span><span>Higher than normal for ${MONTHS[monOf(state.t)]}, per square of about ${sq} km</span>${dots}${est}`
    : `<span>Fewer</span><span class="ramp seq"></span><span>More ${tm}${unitWord()} per square of about ${sq} km</span>${dots}${est}`;
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
  p.set('t', state.live ? 'live' : ymOf(state.t) + (dayOn() ? '-' + String(state.day).padStart(2, '0') : '')); p.set('map', state.view); p.set('only', state.time); p.set('counts', {viirs:'viirs', aqua:'strict', raw:'raw'}[countsNow()]);
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
    const cn = p.get('counts'), counts = ['raw', 'reported'].includes(cn) ? 'raw' : cn === 'strict' ? 'aqua' : UNITS[0];   // old links: adjusted, reported
    if(counts !== countsNow()) setCounts(counts);
    const tt = p.get('t') || '', f = p.get('only'), live = tt === 'live' && HAS.live;
    if(/^\d{4}-\d{2}(-\d{2})?$/.test(tt)){ state.t = clamp(tAt(tt), 0, T-1); state.pick = state.t !== T-1; }
    state.day = tt.length === 10 && !mpOff ? clamp(+tt.slice(8) || 0, 0, dimOf(state.t)) : 0;
    if(live !== state.live) setLive(live);
    state.time = ['day', 'night'].includes(f) && (HAS.night || live) ? f : 'all';   // the area selection below reloads everything for it
    syncTimeControls(); if(state.live && !liveCells.has(lcKey())) loadCells();
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
  try { const r = await fetch(url, opts); if(!r.ok) throw new Error(r.statusText); save(await r.blob(), `blazebridge_${slug()}_${a}-${b}.csv`); toast('Saved the monthly table. ' + unitSentence()); }
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
  const font = (w, s, f) => { g.font = `${w} ${s}px ${f === 'd' ? '"Source Serif 4", Georgia, serif' : '"Source Sans 3", system-ui, sans-serif'}`; };
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
    g.textAlign = 'left'; wrapText(g, `Orange: this season. Dashed: normal. Band: 8 of 10 seasons. Top: ${fmt(top)} ${unitWord()}.`, chartX, y0 + chartH + 40, chartW, 17);
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
  wrapText(g, `Source: NASA FIRMS fire detections. ${unitSentence()} Clouds hide fires. The last 7 days are first numbers and can change. Made with blazeBridge.`, pad, Hb - 46, Wb - 2*pad, 18);
  c.toBlob(blob => { if(blob){ save(blob, `blazebridge_briefing_${slug()}.png`); toast('Saved the briefing as an image.'); } else toast('The briefing could not be made.'); });
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
  const V = UNITS.includes('viirs') ? VAL.viirs : null, vi = V && state.unit === 'viirs', bA = UNIT.aqua.base, bV = V && UNIT.viirs.base;
  const yrs = b => `${b[0]} to ${b[1]}`, refName = V ? {n20:'NOAA-20', snpp:'Suomi NPP'}[String(V.reference).toLowerCase()] || V.reference : '';
  $('aboutBody').innerHTML = `
  <h2>How blazeBridge works</h2>
  <p>Satellites have seen the heat of fires since 2000. Each place where a satellite saw a fire is a fire detection. The record comes from two kinds of instruments. MODIS (on the Terra and Aqua satellites, 1 km pixels) is the long series and is close to retirement. VIIRS (375 m pixels, since 2012) sees many small fires that MODIS misses. Side by side, the counts jump when VIIRS starts, for no real reason. blazeBridge ${V ? 'makes all years comparable in two ways' : 'adjusts all years so they compare'}.</p>
  ${V ? `<h3>Two ways to count</h3>
  <ul>
    <li><b>${UNIT.viirs.label} (the main count).</b> What VIIRS on ${refName} reports. Measured from ${monthName(VSTART)}${V.ref_start && V.ref_start.slice(0, 7) !== V.start.slice(0, 7) ? ` (until ${monthName(tAt(V.ref_start))} from Suomi NPP, matched to ${refName})` : ''}. Earlier months are estimated from MODIS: per region (5° tiles) and calendar month, the ratio of VIIRS to MODIS detections in the years both flew. When Aqua and Terra both recorded, the estimate weighs Aqua ${pct(V.weight_aqua)} and Terra ${pct(1 - V.weight_aqua)}; before August 2002 it uses Terra alone.</li>
    <li><b>${UNIT.aqua.label}.</b> What Aqua MODIS would have reported: fewer small fires. Measured ${monthName(AQUA)} to ${monthName(MODEL - 1)}, converted before and after with the method below.</li>
  </ul>
  <p>Why VIIRS is the main count: Aqua, the reference of the strict record, ends about 2027. After that every new month of the strict record is a conversion nobody can check. VIIRS satellites keep flying, so new months stay measured.</p>
  <h3>Does the main count work?</h3>
  <p>Each year when both kinds flew is hidden in turn. The ratios are learned from the other years, and the estimate from MODIS is compared with measured VIIRS in the hidden year. Error per 5° tile and month (lower is better): ${pct(V.both.error)} from Aqua and Terra together, ${pct(V.aqua.error)} from Aqua alone, ${pct(V.terra.error)} from Terra alone.${V.twin ? ` Two identical VIIRS instruments (Suomi NPP and NOAA-20) differ by ${pct(V.twin.raw)} as reported: no method can do better than that.` : ''}</p>
  <h3>The strict long record</h3>` : '<h3>The method</h3>'}
  <ol>
    <li><b>Same fires only.</b> Keep detections marked as vegetation fire. Drop MODIS confidence below 30 % and VIIRS "low" confidence.</li>
    <li><b>One reference.</b> Aqua MODIS passes at the same local time as VIIRS, so every number is what Aqua would have reported. These are the adjusted detections.</li>
    <li><b>Conversion tables.</b> For the years both flew, every group of VIIRS detections (same 0.05° cell, date, day or night) is matched with the Aqua pixels in that cell. The average depends on fire strength, pixel count, day or night, and region (5° tiles, falling back to 20° tiles and then the globe).</li>
    <li><b>Monthly calibration.</b> A ratio per region and calendar month adds the Aqua pixels that had no VIIRS partner and removes the seasonal difference.</li>
    <li><b>One record.</b> Terra scaled to Aqua before August 2002 (the older satellite), Aqua as measured until 2021 (the reference satellite), adjusted ${SENSOR[PKEY]} from 2022 (the newer satellite), when Aqua's orbit drifts. Days when Aqua did not record are found from the data and filled.</li>
  </ol>
  <h3>Normal, and the season</h3>
  <p>Normal for a month is the middle value of that calendar month in the normal years: ${V ? `${yrs(bV)} for the main count (measured years only), ${yrs(bA)} for the strict record` : yrs(bA)}. The fire season of an area starts after its quietest month. "Season so far" adds up the detections since then and compares them with the same running total in the normal years.</p>
  <h3>Does ${V ? 'the strict record' : 'it'} work?</h3>
  <p>Each year when both flew is hidden in turn. The tables are learned from the other years and the adjusted VIIRS is compared with real Aqua in the hidden year. Error per 5° tile and month (lower is better):</p>
  <table><tr><th>Adjustment</th>${head}</tr>
    ${line('None (VIIRS as reported)', 'raw')}${line('One global factor', 'global_factor')}${line('Monthly ratio per region', 'ratio')}${line('Conversion tables (used)', 'table', true)}
  </table>
  <p>The "compared with normal" level is the same as real Aqua's in ${pct(SAT.anomaly_agreement.table)} of tested tile-months, and the same or the next level in ${pct(SAT.anomaly_agreement.table_within_one)}.
  ${VAL.twin ? ` Two identical VIIRS instruments (Suomi NPP and NOAA-20) disagree by ${pct(VAL.twin.overlap)} after adjustment in the overlap years, and by ${pct(VAL.twin.after)} after 2021. No adjustment can beat the first number.` : ''}
  Choose Confidence under "Colour the fires by" to see the error by place.</p>
  ${TR ? `<h3>The confidence map</h3>
  <p>The map splits the land into squares of about ${kmOf(TR.deg)} km. ${vi ? `For the main count, each square shows how far the monthly estimate from MODIS was from measured VIIRS in the test years ${TR.years[0]} to ${TR.years[1]}.`
    : `Each square shows how far the adjusted monthly count was from real Aqua in the test years ${TR.years[0]} to ${TR.years[1]}, with ${(TR.satellites || []).map(s => SENSOR[s.toLowerCase()] || s).join(' and ')} tested together.`} ${TR.left_out.length ? `${TR.left_out.length} months when a satellite did not record are left out. ` : ''}Hatched squares had fewer than ${fmt(TR.min_n)} detections in those years: too few to test.</p>
  <p>The number depends on the size of the area. In a larger area the errors of small places partly cancel out, so its count is more exact. The same test for squares of other sizes:</p>
  <table><tr><th>Square of about</th><th>Monthly count off by</th></tr>${TR.by_size.map(s => row(`${fmt(kmOf(s.deg))} km`, [pct(s.err)], s.deg === TR.deg)).join('')}</table>` : ''}
  ${gaps.length ? `<p>Aqua outages found and filled: ${gaps.slice(0, 8).map(([a, b]) => `${a} to ${b}`).join('; ')}${gaps.length > 8 ? `; and ${gaps.length - 8} more` : ''}.</p>` : ''}
  <h3>The last 7 days</h3>
  <p>The FIRMS near-real-time file of ${SENSOR.n20}${V ? '. With the main count, the cleaned detections themselves; with the strict record, converted with the same tables' : ', adjusted with the same tables'}. Times are local solar time. A strong fire releases more heat than a set level. "Burning N of 7 days" counts the days with a detection in the same 5 km square. These are first numbers and can change.</p>
  <h3>What to keep in mind</h3>
  <ul>
    <li>A fire detection is a satellite pixel with the heat of a fire, not one fire. A large fire gives many detections.</li>
    <li>Counts are not corrected for clouds. A cloudy month looks like a quiet month.</li>
    ${V ? `<li>In the main count, the months before ${monthName(VSTART)} are estimates. They cannot be checked directly, and small fires that only VIIRS sees are added by a ratio, not seen.</li>` : ''}
    <li>After 2021 the ${V ? 'strict record' : 'adjustment'} cannot be checked against Aqua, because its orbit drifts.</li>
    <li>The months before August 2002 come from Terra, which passes in the morning. They are less certain.</li>
    <li>The monthly record ends in ${MONTHS[monOf(T-1)]} ${yearOf(T-1)}, the last complete yearly archive.</li>
  </ul>
  <h3>Data</h3>
  <p>NASA FIRMS yearly country archives: MODIS Collection 6.1 and VIIRS 375 m, standard processing. Country shapes: Natural Earth. Single detections for any area: Download detections.</p>`;
}

/* ---------- wiring ---------- */
document.querySelectorAll('input[name=view]').forEach(r => r.addEventListener('change', () => setView(r.value)));
document.querySelectorAll('.vbox[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
document.querySelectorAll('input[name=counts]').forEach(r => r.addEventListener('change', () => setCounts(r.value)));
document.querySelectorAll('input[name=time]').forEach(r => r.addEventListener('change', () => setTime(r.value)));
$('strong').onchange = e => { state.strong = e.target.checked; dirty = true; lastCheck = 0; };
$('cGrid').onclick = $('cRings').onclick = e => { state.cal = e.currentTarget.id === 'cGrid' ? 'grid' : 'rings';
  $('cGrid').setAttribute('aria-pressed', state.cal === 'grid'); $('cRings').setAttribute('aria-pressed', state.cal === 'rings'); if(months) renderCalendar(); };
$('worldBtn').onclick = clearPlace;
$('wLive').onclick = () => { setPlaying(false); setLive(true); };
$('wLatest').onclick = () => { setPlaying(false); state.pick = false; setT(T-1); };
$('play').onclick = () => setPlaying(!playing);
// the time bar: a ruler of years with brackets for the range and a line for the month shown; the native slider sits on top
const rulerX = t => ((t + .5)/T*100).toFixed(3) + '%';
let rulerBuilt = false;
function renderRuler(){
  const r = $('ruler'); if(!r || !T) return;
  if(!rulerBuilt){
    rulerBuilt = true;
    let h = '<div class="r-band" id="rBand"></div>';
    YEARS.forEach(y => { const t = tOf(y, 0); if(t < 0 || t >= T) return; const major = y % 5 === 0;
      h += `<i class="r-tick${major ? ' major' : ''}" style="left:${rulerX(t)}"></i>` + (major ? `<span class="r-lab" style="left:${rulerX(t)}">${y}</span>` : ''); });
    h += `<i class="r-tick era" style="left:${rulerX(VSTART)}" title="VIIRS starts, ${monthName(VSTART)}"></i><span class="r-lab era" style="left:${rulerX(VSTART)}">VIIRS</span>`;
    h += '<button type="button" class="r-hd" id="rFrom" aria-label="Start of the range"></button><button type="button" class="r-hd" id="rTo" aria-label="End of the range"></button><i class="r-now" id="rNow"></i>';
    r.innerHTML = h;
    for(const id of ['rFrom', 'rTo']){
      const hd = $(id);
      hd.addEventListener('pointerdown', e => { e.preventDefault(); hd.setPointerCapture(e.pointerId); hd.dataset.drag = '1'; });
      hd.addEventListener('pointermove', e => {
        if(!hd.dataset.drag) return; const b = r.getBoundingClientRect(), t = clamp(Math.round((e.clientX - b.left)/b.width*T - .5), 0, T-1);
        if(id === 'rFrom') setRange(Math.min(t, PLAY.to - 1), PLAY.to, 'custom'); else setRange(PLAY.from, Math.max(t, PLAY.from + 1), 'custom');
      });
      hd.addEventListener('pointerup', () => { delete hd.dataset.drag; });
      hd.addEventListener('keydown', e => { const d = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0; if(!d) return; e.preventDefault();
        if(id === 'rFrom') setRange(Math.min(PLAY.from + d, PLAY.to - 1), PLAY.to, 'custom'); else setRange(PLAY.from, Math.max(PLAY.to + d, PLAY.from + 1), 'custom'); });
    }
  }
  $('rBand').style.left = rulerX(PLAY.from); $('rBand').style.right = `calc(100% - ${rulerX(PLAY.to)})`;
  $('rFrom').style.left = rulerX(PLAY.from); $('rTo').style.left = rulerX(PLAY.to);
  $('rFrom').title = `Range starts ${MON[monOf(PLAY.from)]} ${yearOf(PLAY.from)}`; $('rTo').title = `Range ends ${MON[monOf(PLAY.to)]} ${yearOf(PLAY.to)}`;
  $('rNow').style.left = rulerX(state.t); $('rNow').hidden = !!state.live;
}
// playback and fire filter card on the map
PLAY.to = T - 1;
for(const id of ['pfM', 'ptM', 'dMon']) MONTHS.forEach((m, i) => $(id).add(new Option(m.slice(0, 3), i)));
for(const id of ['pfY', 'ptY', 'dYear']) YEARS.forEach(y => $(id).add(new Option(y, y)));
$('dDay').disabled = mpOff;
const putPlay = () => { $('pfM').value = monOf(PLAY.from); $('pfY').value = yearOf(PLAY.from); $('ptM').value = monOf(PLAY.to); $('ptY').value = yearOf(PLAY.to); };
// one time range drives playback, the calendar's highlighted years and the download years
function setRange(a, b, preset){
  a = clamp(a, 0, T-1); b = clamp(b, 0, T-1); if(a > b) [a, b] = [b, a];
  if(b - a < 1){ if(b < T-1) b = a + 1; else a = b - 1; }
  PLAY.from = a; PLAY.to = b; putPlay();
  const yf = String(yearOf(a)), yt = String(yearOf(b));
  if($('yFrom').value !== yf || $('yTo').value !== yt){ $('yFrom').value = yf; $('yTo').value = yt; if(months){ renderCalendar(); renderYears(); } }
  document.querySelectorAll('#presets button').forEach(x => x.setAttribute('aria-pressed', x.dataset.preset === preset));
  renderRuler(); setPlaying(playing);
}
const readPlay = () => setRange(tOf(+$('pfY').value, +$('pfM').value), tOf(+$('ptY').value, +$('ptM').value), 'custom');
$('presets').addEventListener('click', e => { const b = e.target.closest('button'); if(!b) return; const p = b.dataset.preset, ly = yearOf(T-1);
  if(p === 'all') setRange(0, T-1, 'all'); else if(p === 'custom'){ setRange(PLAY.from, PLAY.to, 'custom'); $('pfM').focus(); }
  else setRange(tOf(ly - +p + 1, 0), T-1, p); });
$('tPrev').onclick = () => { setPlaying(false); if(dayOn()) stepDay(-1); else setT((state.live ? T : state.t) - 1); };
$('tNext').onclick = () => { setPlaying(false); if(dayOn()) stepDay(1); else if(!state.live) setT(state.t + 1); };
['dDay', 'dMon', 'dYear'].forEach(id => $(id).addEventListener('change', () => { setPlaying(false); state.day = +$('dDay').value; setT(tOf(+$('dYear').value, +$('dMon').value)); }));
['pfM', 'pfY', 'ptM', 'ptY'].forEach(id => $(id).addEventListener('change', readPlay));
putPlay(); renderRuler();
$('speedSeg').addEventListener('click', e => { const b = e.target.closest('button'); if(!b) return; PLAY.speed = +b.dataset.speed;
  $('speedSeg').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); });
$('pLoop').addEventListener('change', e => { PLAY.loop = e.target.checked; });
$('dens').addEventListener('input', e => { minDens = DENS[+e.target.value]; $('densV').textContent = minDens <= 1 ? 'all squares' : `${fmt(minDens)} or more`; dirty = true; });
$('gain').addEventListener('input', e => { fireGain = +e.target.value/100; $('gainV').textContent = e.target.value + ' %'; dirty = true; });
$('dRange').addEventListener('input', e => { dayPick = +e.target.value - 1; renderTime(); });   // 0 = all days
$('tRange').addEventListener('input', e => { setPlaying(false); setT(+e.target.value); });
$('dlCsv').onclick = downloadCsv; $('dlHot').onclick = downloadDetections; $('dlBrief').onclick = briefing; $('copyLink').onclick = copyLink;
$('yFrom').onchange = $('yTo').onchange = () => { if(months){ renderCalendar(); renderYears(); } };
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
const qr = $('qResults');
let qHits = [], qActive = -1;
function searchHits(text){
  const q = text.trim().toLowerCase(); if(!q) return [];
  const score = n => { n = n.toLowerCase(); return n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : -1; };
  const by = (a, b) => a.s - b.s || a.name.localeCompare(b.name);
  const cs = names.map(([n, i]) => ({kind:'country', name:n, i, s:score(n)})).filter(h => h.s >= 0).sort(by).slice(0, 6);
  const ss = [], seen = new Set();
  for(const v of stateMap.values()){ const sc = score(v.name), k = v.country + '|' + v.name; if(sc < 0 || seen.has(k)) continue; seen.add(k); ss.push({kind:'state', name:v.name, country:v.country, st:v, s:sc}); }
  return [...cs, ...ss.sort(by).slice(0, 6)];
}
function showHits(){
  qHits = searchHits($('q').value); qActive = qHits.length ? 0 : -1;
  if(!$('q').value.trim()){ qr.hidden = true; $('q').setAttribute('aria-expanded', 'false'); return; }
  const group = (kind, title) => { const g = qHits.map((h, i) => [h, i]).filter(([h]) => h.kind === kind); if(!g.length) return '';
    return `<p class="qr-k">${title}</p>` + g.map(([h, i]) => `<button type="button" role="option" class="qr-it${i === qActive ? ' on' : ''}" data-i="${i}">${esc(h.name)}${h.kind === 'state' ? ` <span>· ${esc(h.country)}</span>` : ''}</button>`).join(''); };
  qr.innerHTML = (group('country', 'Countries') + group('state', 'States and provinces')) || '<p class="qr-k">No country or loaded state matches.</p>';
  if(!qHits.some(h => h.kind === 'state')) qr.innerHTML += '<p class="qr-note">States can be searched for countries you have opened or zoomed into. Pick a country first to list all its states.</p>';
  qr.hidden = false; $('q').setAttribute('aria-expanded', 'true');
}
function pickHit(h){
  qr.hidden = true; $('q').setAttribute('aria-expanded', 'false'); if(!h) return false;
  if(h.kind === 'country') selectCountry(h.i); else selectState(h.st);
  return true;
}
$('q').addEventListener('input', showHits);
$('q').addEventListener('focus', () => { if($('q').value.trim() && document.activeElement === $('q')) showHits(); });
$('q').addEventListener('keydown', e => {
  if(qr.hidden || !qHits.length) return;
  if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){ e.preventDefault(); qActive = (qActive + (e.key === 'ArrowDown' ? 1 : qHits.length - 1)) % qHits.length;
    qr.querySelectorAll('.qr-it').forEach(b => b.classList.toggle('on', +b.dataset.i === qActive)); }
  else if(e.key === 'Escape'){ qr.hidden = true; }
});
qr.addEventListener('pointerdown', e => e.preventDefault());   // keep focus in the field while choosing
qr.addEventListener('click', e => { const b = e.target.closest('.qr-it'); if(b) pickHit(qHits[+b.dataset.i]); });
$('q').addEventListener('blur', () => { qr.hidden = true; $('q').setAttribute('aria-expanded', 'false'); });
$('searchForm').addEventListener('submit', e => {
  e.preventDefault();
  if(!$('q').value.trim()) return;
  if(!qHits.length) qHits = searchHits($('q').value);
  if(!pickHit(qHits[Math.max(0, qActive)])) toast(`No country or loaded state matches "${$('q').value.trim()}".`);
});
// display: borders, names, reset
$('optStates').addEventListener('change', e => { disp.states = e.target.checked; bump(); });
$('optPlaces').addEventListener('change', e => { disp.places = e.target.checked; bump(); });
// shortcut: the colours are read once at load, so a change reloads the page (the address keeps the view); redraw in place if the reload gets slow
$('cvd').value = CVD;
$('cvd').onchange = e => { const v = e.target.value || 'standard', u = new URL(location.href);
  try { localStorage.setItem('fp-cvd', v); } catch(err){}
  u.searchParams.set('colors', v); location.replace(u); };
$('resetDisp').onclick = () => {
  setGlobeLook('minimal'); setView('count');
  for(const [id, v] of [['dens', 0], ['gain', 100]]){ $(id).value = v; $(id).dispatchEvent(new Event('input')); }
  for(const id of ['optStates', 'optPlaces']){ $(id).checked = true; $(id).dispatchEvent(new Event('change')); }
};

addEventListener('hashchange', () => { if(location.hash !== ownHash) restore(); });   // a pasted link; our own writes use replaceState

$('wLive').hidden = !HAS.live;
$('strongWrap').hidden = !HAS.live;
$('cViirs').hidden = !UNITS.includes('viirs');
$('hViirs').textContent = UNIT.viirs.help; $('hAqua').textContent = UNIT.aqua.help;
useUnit(); syncTimeControls(); legend(); loadPB(); loadTrust();
resize(); if(pageQ.get('flat') === '1' || lookStore.get2('fp-flat') === '1') setFlat(true, false); setPlaying(false); renderTime();
requestAnimationFrame(tick);
if(!(await restore())) select({kind:'world', name:'Earth'}, null);
})();
