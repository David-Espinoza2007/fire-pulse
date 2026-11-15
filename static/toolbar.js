/* Interface modes and panels: presentation only. The controls are the same elements app.js drives, so switching
   mode, folding a panel or hiding the controls never changes the selection, the time or the playback. */
(() => {
  const $ = id => document.getElementById(id), app = $('app');
  const store = {get(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }, set(k, v){ try { localStorage.setItem(k, v); } catch(e){} }};
  const narrow = matchMedia('(max-width: 899.98px)');
  const relayout = () => dispatchEvent(new Event('resize'));   // the globe follows its box through a ResizeObserver; this is a nudge

  // research tools: fold to a rail of section letters (desktop) or slide away as a drawer (phones)
  function setSide(open, save = true){
    app.classList.toggle('side-off', !open);
    $('sideBtn').setAttribute('aria-expanded', open); $('sideOpen').setAttribute('aria-expanded', open);
    if(save && !narrow.matches) store.set('fp-side', open ? '1' : '0');
    relayout();
  }

  // Presentation (default) or Research: a class on the app, kept per browser and in ?mode=research
  function setMode(research, save = true){
    app.classList.toggle('mode-res', research); app.classList.toggle('mode-pres', !research);
    $('modeBtn').setAttribute('aria-checked', research);
    if(research && narrow.matches) setSide(false, false);   // on phones the tools open as a drawer, on demand
    if(save) store.set('fp-mode', research ? 'research' : 'presentation');
    const q = new URLSearchParams(location.search); if(research) q.set('mode', 'research'); else q.delete('mode');
    history.replaceState(history.state, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
    relayout();
  }
  $('modeBtn').addEventListener('click', () => setMode(!app.classList.contains('mode-res')));

  $('sideBtn').addEventListener('click', () => setSide(app.classList.contains('side-off')));
  $('sideOpen').addEventListener('click', () => setSide(app.classList.contains('side-off')));
  document.querySelectorAll('.sb-rail button').forEach(b => b.addEventListener('click', () => {
    setSide(true); const sec = $(b.dataset.sec); sec.open = true; sec.scrollIntoView({block:'nearest'}); sec.querySelector('summary').focus();
  }));
  setSide(narrow.matches ? false : store.get('fp-side') !== '0', false);
  narrow.addEventListener('change', e => setSide(e.matches ? false : store.get('fp-side') !== '0', false));
  document.addEventListener('pointerdown', e => {   // a tap outside the drawer closes it on phones
    if(narrow.matches && !app.classList.contains('side-off') && !e.target.closest('#sidebar, #sideOpen')) setSide(false, false);
  });
  const want = new URLSearchParams(location.search).get('mode') || store.get('fp-mode');
  setMode(want === 'research', false);

  // analysis panel folds to a strip and gives its width to the globe
  const pb = $('panelBtn');
  function setPanel(open, save = true){
    app.classList.toggle('panel-off', !open); pb.setAttribute('aria-expanded', open);
    pb.title = open ? 'Hide the analysis panel' : 'Show the analysis panel'; pb.querySelector('.sr').textContent = pb.title;
    if(save) store.set('fp-panel', open ? '1' : '0'); relayout();
  }
  pb.addEventListener('click', () => setPanel(app.classList.contains('panel-off')));
  if(store.get('fp-panel') === '0') setPanel(false, false);

  // hide every control on the map and the time bar, to watch only the Earth; H toggles it too
  const gb = $('gizmoBtn');
  const setBare = on => { app.classList.toggle('bare', on); gb.setAttribute('aria-pressed', on); gb.textContent = on ? 'Show controls' : 'Hide controls'; relayout(); };
  gb.addEventListener('click', () => setBare(!app.classList.contains('bare')));
  document.addEventListener('keydown', e => {
    if(e.key === 'Escape' && narrow.matches && !app.classList.contains('side-off')) setSide(false, false);
    if((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.closest('input, select, textarea')) setBare(!app.classList.contains('bare'));
  });
})();
