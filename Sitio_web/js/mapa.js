/* ==========================================================================
   mapa.js · Avísame cuando llegues
   Crea el mapa (MapLibre GL) y sabe prender/apagar capas, cambiar la categoría
   del mapa de calor y moverse a un encuadre. No escucha el scroll: eso lo hace
   scrollytelling.js, que solo llama a Mapa.escena({...}).

   Uso desde otros archivos:
     await Mapa.listo;
     Mapa.escena({ capas:['base','oportunidades','isocrona60','linea3','ecatepec'],
                   encuadre:'zmvm', categoria:'empleo' });
     Mapa.categoria('escuelas');      // empleo | escuelas | salud | cultura
     Mapa.mostrar('isocrona60'); Mapa.ocultar('isocrona60');
     Mapa.encuadre('ecatepec');       // o [[oeste,sur],[este,norte]]

   Formato sugerido para data/guion_escenas.json (una entrada por escena):
     { "id":"02", "capas":[...], "encuadre":"zmvm", "categoria":"empleo" }

   Criterio ético: este archivo nunca dibuja puntos exactos de personas ni de
   hechos de violencia. Las capas de riesgo que se agreguen deben venir ya
   agregadas (malla o colonia), como la malla de oportunidades.
   ========================================================================== */
(function () {
  'use strict';

  const RUTA = 'mapas/';
  const GLIFOS = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';

  // Encuadres con nombre (lon/lat, EPSG:4326)
  const ENCUADRES = {
    zmvm:     [[-99.26, 19.28], [-98.96, 19.66]],
    ecatepec: [[-99.12, 19.50], [-98.96, 19.67]],
    centro:   [[-99.21, 19.38], [-99.10, 19.47]],
    trayecto: [[-99.21, 19.37], [-98.97, 19.67]]
  };

  // Categorías del mapa de calor → campo de clase y de valor en oportunidades_malla.geojson
  const CATEGORIAS = {
    empleo:   { clase: 'c_empleo',   valor: 'empleos',  titulo: 'Empleos estimados por hexágono' },
    escuelas: { clase: 'c_escuelas', valor: 'escuelas', titulo: 'Escuelas por hexágono' },
    salud:    { clase: 'c_salud',    valor: 'salud',    titulo: 'Clínicas, hospitales y asistencia por hexágono' },
    cultura:  { clase: 'c_cultura',  valor: 'cultura',  titulo: 'Espacios de cultura y deporte por hexágono' }
  };

  // Grupos de capas que se prenden/apagan juntos
  const GRUPOS = {
    base:          ['verdes', 'agua', 'vias-rapidas', 'vias-primarias', 'limites', 'vias-nombre'],
    transporte:    ['transporte'],
    linea3:        ['linea3-borde', 'linea3'],
    ecatepec:      ['ecatepec-achurado', 'ecatepec-borde'],
    oportunidades: ['malla'],
    isocrona60:    ['isocrona60']
  };
  const GRUPOS_HTML = { etiquetas: [], ecatepec: [], linea3: [], oportunidades: [], isocrona60: [] };

  // Tamaño relativo de cada clase (fracción de la separación entre hexágonos)
  const TAM_CLASE = [0, 0.16, 0.24, 0.32, 0.40, 0.47];

  const nf = new Intl.NumberFormat('es-MX');
  let mapa, contenedor, metadatos = {}, categoriaActual = 'empleo', popup;
  const visibles = new Set();

  /* ---------- tokens del design system ---------- */
  const token = (n) => getComputedStyle(contenedor).getPropertyValue(n).trim();
  function colores() {
    return {
      fondo: token('--map-fondo'), etiqueta: token('--map-etiqueta'), halo: token('--map-halo'),
      linea: token('--c-linea'), superficie: token('--c-superficie'), texto: token('--c-texto'),
      texto2: token('--c-texto-2'), limite: token('--map-limite'), foco: token('--map-zona-foco'),
      l3: token('--map-linea3'), tinta: token('--p-tinta'), isocrona: token('--c-texto'),
      seq: [1, 2, 3, 4, 5].map((i) => token('--data-seq-' + i))
    };
  }

  /* ---------- utilidades ---------- */
  const cargar = (n) => fetch(RUTA + n).then((r) => {
    if (!r.ok) throw new Error('No se pudo leer ' + RUTA + n);
    return r.json();
  });

  // separación de la malla (m) → píxeles en cada zoom, a la latitud de la CDMX
  function radio(sepM) {
    const pxPorM = (z) => Math.pow(2, z) / (156543.03 * Math.cos(19.43 * Math.PI / 180));
    const porClase = (z, k) => ['*', ['at', ['get', k], ['literal', TAM_CLASE]], sepM * pxPorM(z)];
    return (k) => ['interpolate', ['exponential', 2], ['zoom'],
      9, ['*', 2.3, porClase(9, k)],     // de lejos se agrandan un poco para que la malla se lea
      11, ['*', 1.35, porClase(11, k)],
      13, ['*', 1.0, porClase(13, k)],
      16, porClase(16, k)];
  }

  function achurado(color) {
    const n = 10, c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d');
    g.strokeStyle = color; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(0, n); g.lineTo(n, 0); g.moveTo(-n / 2, n / 2); g.lineTo(n / 2, -n / 2);
    g.moveTo(n / 2, n * 1.5); g.lineTo(n * 1.5, n / 2); g.stroke();
    return g.getImageData(0, 0, n, n);
  }

  function marcador(html, lngLat, ancla, grupo, offset) {
    const el = document.createElement('div');
    el.innerHTML = html;
    const m = new maplibregl.Marker({ element: el.firstElementChild, anchor: ancla || 'center', offset: offset || [0, 0] })
      .setLngLat(lngLat).addTo(mapa);
    if (grupo) GRUPOS_HTML[grupo].push(m);
    return m;
  }

  /* ---------- capas ---------- */
  function agregarCapas(datos, C) {
    const sep = (datos.malla.metadatos && datos.malla.metadatos.separacion_m) || 520;
    const r = radio(sep);
    const fuentes = ['verdes', 'agua', 'vialidades', 'limites', 'transporte', 'isocrona', 'malla'];
    const archivo = { verdes: datos.verdes, agua: datos.agua, vialidades: datos.vialidades, limites: datos.limites,
      transporte: datos.transporte, isocrona: datos.isocrona, malla: datos.malla };
    fuentes.forEach((f) => mapa.addSource(f, { type: 'geojson', data: archivo[f] }));
    mapa.addImage('achurado', achurado(C.foco), { pixelRatio: 2 });

    const capas = [
      { id: 'verdes', type: 'fill', source: 'verdes', paint: { 'fill-color': C.texto2, 'fill-opacity': 0.12 } },
      { id: 'agua', type: 'fill', source: 'agua', paint: { 'fill-color': C.texto2, 'fill-opacity': 0.22 } },
      { id: 'vias-primarias', type: 'line', source: 'vialidades', filter: ['==', ['get', 'clase'], 2],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.superficie, 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 10, 0.5, 13, 1.6, 16, 5] } },
      { id: 'vias-rapidas', type: 'line', source: 'vialidades', filter: ['==', ['get', 'clase'], 1],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.superficie, 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 10, 1, 13, 2.6, 16, 8] } },
      { id: 'transporte', type: 'line', source: 'transporte', filter: ['!=', ['get', 'linea'], '3'],
        paint: { 'line-color': C.texto2, 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [4, 2] } },
      { id: 'limites', type: 'line', source: 'limites', filter: ['==', ['get', 'entidad'], 'CDMX'],
        paint: { 'line-color': C.limite, 'line-width': 1, 'line-opacity': 0.8, 'line-dasharray': [3, 2] } },
      // malla de oportunidades: tamaño y color dicen lo mismo (redundancia = accesible)
      { id: 'malla', type: 'circle', source: 'malla', filter: ['>', ['get', CATEGORIAS.empleo.clase], 0],
        paint: {
          'circle-radius': r(CATEGORIAS.empleo.clase),
          'circle-color': ['match', ['get', CATEGORIAS.empleo.clase], 1, C.seq[0], 2, C.seq[1], 3, C.seq[2], 4, C.seq[3], C.seq[4]],
          'circle-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.95, 14, 0.75]
        } },
      { id: 'ecatepec-achurado', type: 'fill', source: 'limites', filter: ['==', ['get', 'entidad'], 'Edomex'],
        paint: { 'fill-pattern': 'achurado', 'fill-opacity': 0.55 } },
      { id: 'ecatepec-borde', type: 'line', source: 'limites', filter: ['==', ['get', 'entidad'], 'Edomex'],
        paint: { 'line-color': C.foco, 'line-width': 2.5 } },
      { id: 'isocrona60', type: 'line', source: 'isocrona', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.isocrona, 'line-width': 2.2, 'line-dasharray': [0.1, 2.2] } },
      { id: 'linea3-borde', type: 'line', source: 'transporte', filter: ['all', ['==', ['get', 'sistema'], 'Metro'], ['==', ['get', 'linea'], '3']],
        layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': C.fondo, 'line-width': 8 } },
      { id: 'linea3', type: 'line', source: 'transporte', filter: ['all', ['==', ['get', 'sistema'], 'Metro'], ['==', ['get', 'linea'], '3']],
        layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': C.l3, 'line-width': 5 } },
      // nombres de avenidas: solo de cerca (si los glifos no cargan, el mapa sigue funcionando)
      { id: 'vias-nombre', type: 'symbol', source: 'vialidades', minzoom: 13.5,
        layout: { 'text-field': ['get', 'nombre'], 'text-font': ['Noto Sans Medium'], 'text-size': 11,
          'symbol-placement': 'line', 'text-letter-spacing': 0.04, 'symbol-spacing': 350 },
        paint: { 'text-color': C.texto2, 'text-halo-color': C.fondo, 'text-halo-width': 1.6 } }
    ];
    capas.forEach((c) => mapa.addLayer(c));
  }

  function agregarEtiquetas(datos) {
    // alcaldías
    // nombres largos en dos renglones para que no choquen entre sí
    const CORTO = { 'Cuajimalpa de Morelos': 'Cuajimalpa', 'La Magdalena Contreras': 'Magdalena<br>Contreras' };
    const partir = (n) => CORTO[n] || (n.length > 12 ? n.replace(' ', '<br>') : n);
    datos.etiquetas.features.forEach((f) =>
      marcador(`<div class="etq alcaldia">${partir(f.properties.nombre)}</div>`, f.geometry.coordinates, 'center', 'etiquetas'));
    // destinos (solo se ven al acercarse)
    datos.lugares.features.filter((f) => f.properties.tipo.startsWith('destino')).forEach((f) =>
      marcador(`<div class="etq destino">${f.properties.nombre}</div>`, f.geometry.coordinates, 'left', 'etiquetas', [-4, 0]));
    // Ecatepec (sello con cinta) e Indios Verdes (estación + sello Línea 3)
    const eca = datos.lugares.features.find((f) => f.properties.tipo === 'municipio');
    marcador('<div class="sello cinta">Ecatepec</div>', eca.geometry.coordinates, 'center', 'ecatepec');
    const iv = datos.lugares.features.find((f) => f.properties.tipo === 'estacion');
    marcador('<div class="estacion" aria-hidden="true"></div>', iv.geometry.coordinates, 'center', 'linea3');
    marcador('<div class="sello l3">Indios Verdes</div>', iv.geometry.coordinates, 'left', 'linea3', [16, 4]);
    // la zona con más empleo
    marcador('<div class="sello claro">+ empleo · Centro / Reforma</div>', [-99.150, 19.427], 'right', 'oportunidades', [-6, 0]);
    // rótulo de la isócrona: en su punto más al sur
    const g = datos.isocrona.features[0].geometry;
    const anillos = g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map((p) => p[0]);
    let sur = anillos[0][0];
    anillos.forEach((a) => a.forEach((p) => { if (p[1] < sur[1]) sur = p; }));
    marcador('<div class="etq isocrona">60 min →</div>', sur, 'top', 'isocrona60', [0, 6]);
  }

  /* ---------- leyenda ---------- */
  function leyenda(C) {
    let el = contenedor.querySelector('.leyenda');
    if (!el) {
      el = document.createElement('details');
      el.className = 'leyenda';
      if (window.matchMedia('(min-width: 768px)').matches) el.open = true;
      contenedor.appendChild(el);
    }
    const cat = CATEGORIAS[categoriaActual];
    const cortes = (metadatos.cortes && metadatos.cortes[cat.clase]) || [];
    const etiquetasCortes = ['1', ...cortes.map((c) => nf.format(c))];
    const pts = TAM_CLASE.slice(1).map((t, i) =>
      `<i style="width:${Math.round(8 + t * 44)}px;height:${Math.round(8 + t * 44)}px;background:${C.seq[i]}"></i>`).join('');
    el.innerHTML = `
      <summary>Leyenda</summary>
      <div class="titulo">${cat.titulo} <span style="color:var(--p-vapor)">(≈${metadatos.separacion_m || 520} m)</span></div>
      <div class="rampa-pts" role="img" aria-label="Cinco tamaños, de menos a más">${pts}</div>
      <div class="cortes">${etiquetasCortes.map((t) => `<span>${t}+</span>`).join('')}</div>
      <ul>
        <li><i style="background:repeating-linear-gradient(135deg,${C.foco} 0 1.5px,transparent 1.5px 5px);outline:2px solid ${C.foco};outline-offset:-2px"></i>Ecatepec</li>
        <li><i style="height:0;border-top:5px solid ${token('--p-l3')}"></i>Metro Línea 3</li>
        <li><i style="height:0;border-top:2px dashed ${token('--p-vapor')}"></i>Otras líneas de Metro y Mexibús</li>
        <li><i style="height:0;border-top:3px dotted ${token('--p-luz')}"></i>60 min desde Ecatepec</li>
      </ul>
      <div class="fuente">Fuente: INEGI, DENUE 2025 · isócronas en transporte público (GTFS CDMX, combi aproximada) · © OpenStreetMap</div>`;
  }

  /* ---------- ventana emergente (sin nombres crudos de INEGI) ---------- */
  function emergente(e) {
    const p = e.features[0].properties;
    const fila = (t, v) => `<dt>${t}</dt><dd>${nf.format(v)}</dd>`;
    const principal = categoriaActual === 'empleo'
      ? `<div class="grande">≈ ${nf.format(p.empleos)} <small>empleos</small></div>`
      : `<div class="grande">${nf.format(p[CATEGORIAS[categoriaActual].valor])} <small>${categoriaActual === 'salud' ? 'lugares de salud' : categoriaActual}</small></div>`;
    popup.setLngLat(e.features[0].geometry.coordinates).setHTML(`
      <div class="pop"><h4>${p.zona}</h4>${principal}
      <dl>${categoriaActual !== 'empleo' ? fila('Empleos (aprox.)', p.empleos) : ''}${fila('Escuelas', p.escuelas)}${fila('Salud', p.salud)}${fila('Cultura y deporte', p.cultura)}</dl>
      <div class="nota" style="margin-top:6px">Hexágono de ≈${metadatos.separacion_m || 520} m</div></div>`).addTo(mapa);
  }

  /* ---------- API pública ---------- */
  function fijarVisibilidad(grupo, ver) {
    (GRUPOS[grupo] || []).forEach((id) => mapa.getLayer(id) && mapa.setLayoutProperty(id, 'visibility', ver ? 'visible' : 'none'));
    (GRUPOS_HTML[grupo] || []).forEach((m) => { m.getElement().style.display = ver ? '' : 'none'; });
    ver ? visibles.add(grupo) : visibles.delete(grupo);
  }
  const mostrar = (g) => fijarVisibilidad(g, true);
  const ocultar = (g) => fijarVisibilidad(g, false);

  function categoria(nombre) {
    if (!CATEGORIAS[nombre]) return;
    categoriaActual = nombre;
    const C = colores(), k = CATEGORIAS[nombre].clase, sep = metadatos.separacion_m || 520;
    mapa.setFilter('malla', ['>', ['get', k], 0]);
    mapa.setPaintProperty('malla', 'circle-radius', radio(sep)(k));
    mapa.setPaintProperty('malla', 'circle-color', ['match', ['get', k], 1, C.seq[0], 2, C.seq[1], 3, C.seq[2], 4, C.seq[3], C.seq[4]]);
    GRUPOS_HTML.oportunidades.forEach((m) => { m.getElement().style.visibility = nombre === 'empleo' ? '' : 'hidden'; });
    leyenda(C);
    popup && popup.remove();
    contenedor.dispatchEvent(new CustomEvent('mapa:categoria', { detail: nombre }));
  }

  function encuadre(e, opciones) {
    const b = typeof e === 'string' ? ENCUADRES[e] : e;
    if (!b) return;
    const ancho = contenedor.clientWidth;
    const izq = ancho >= 1100 ? 480 : ancho >= 768 ? Math.round(ancho * 0.45) : 24;
    mapa.fitBounds(b, Object.assign({ padding: { top: ancho < 768 ? 220 : 40, bottom: 90, left: izq, right: ancho >= 768 ? 40 : 24 },
      duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1600 }, opciones || {}));
  }

  function escena(cfg) {
    cfg = cfg || {};
    if (cfg.capas) {
      Object.keys(Object.assign({}, GRUPOS, GRUPOS_HTML)).forEach((g) => fijarVisibilidad(g, cfg.capas.includes(g)));
    }
    if (cfg.categoria) categoria(cfg.categoria);
    if (cfg.encuadre) encuadre(cfg.encuadre);
  }

  function iniciar(id) {
    contenedor = document.getElementById(id || 'mapa');
    if (!contenedor.dataset.modo) contenedor.dataset.modo = 'dia';
    const C = colores();
    mapa = new maplibregl.Map({
      container: contenedor,
      style: { version: 8, glyphs: GLIFOS, sources: {}, layers: [{ id: 'fondo', type: 'background', paint: { 'background-color': C.fondo } }] },
      bounds: ENCUADRES.zmvm, minZoom: 9, maxZoom: 16, maxBounds: [[-99.65, 18.95], [-98.6, 19.9]],
      attributionControl: false, dragRotate: false, pitchWithRotate: false, cooperativeGestures: false
    });
    mapa.touchZoomRotate.disableRotation();
    mapa.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapa.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'INEGI DENUE 2025 · SEMOVI GTFS · © OpenStreetMap' }), 'top-right');
    popup = new maplibregl.Popup({ closeButton: true, maxWidth: '260px', offset: 8 });

    const archivos = { verdes: 'areas_verdes.geojson', agua: 'agua.geojson', vialidades: 'vialidades.geojson', limites: 'limites.geojson',
      transporte: 'transporte.geojson', isocrona: 'isocrona_60min.geojson', malla: 'oportunidades_malla.geojson',
      etiquetas: 'etiquetas_alcaldias.geojson', lugares: 'lugares.geojson' };
    const datosP = Promise.all(Object.entries(archivos).map(([k, f]) => cargar(f).then((d) => [k, d])))
      .then((pares) => Object.fromEntries(pares));
    const cargado = new Promise((ok) => mapa.on('load', ok));

    return Promise.all([datosP, cargado]).then(([datos]) => {
      metadatos = datos.malla.metadatos || {};
      agregarCapas(datos, C);
      agregarEtiquetas(datos);
      Object.keys(GRUPOS).concat(['etiquetas']).forEach((g) => visibles.add(g));
      leyenda(C);
      const zoomClase = () => contenedor.classList.toggle('mapa-cerca', mapa.getZoom() >= 11.6);
      mapa.on('zoom', zoomClase); zoomClase();
      mapa.on('click', 'malla', emergente);
      mapa.on('mouseenter', 'malla', () => { mapa.getCanvas().style.cursor = 'pointer'; });
      mapa.on('mouseleave', 'malla', () => { mapa.getCanvas().style.cursor = ''; });
      encuadre('zmvm', { duration: 0 });
      return mapa;
    }).catch((err) => {
      console.error('[mapa]', err);
      contenedor.insertAdjacentHTML('beforeend', `<div class="panel" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9">
        No se pudo cargar el mapa. Abre el sitio con un servidor local (no con doble clic).<br><span class="nota">${err.message}</span></div>`);
      throw err;
    });
  }

  let resolver;
  const listo = new Promise((r) => { resolver = r; });
  window.Mapa = {
    listo, ENCUADRES, CATEGORIAS,
    iniciar: (id) => iniciar(id).then((m) => { resolver(m); return m; }),
    escena, mostrar, ocultar, categoria, encuadre,
    get mapa() { return mapa; },
    get visibles() { return [...visibles]; }
  };
})();
