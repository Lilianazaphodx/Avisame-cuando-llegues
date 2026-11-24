"""Genera las capas web del mapa de calor de oportunidades (EPSG:4326)."""
import json, math, sys, os, collections
from shapely.geometry import shape, mapping, Point, MultiPolygon
from shapely.ops import unary_union, transform
from shapely import STRtree
from pyproj import Transformer

SRC = sys.argv[1]; OUT = sys.argv[2]; os.makedirs(OUT, exist_ok=True)
A = SRC + '/Agentes/02_QGIS_Analista:'
fw = Transformer.from_crs(4326, 32614, always_xy=True).transform
bw = Transformer.from_crs(32614, 4326, always_xy=True).transform
load = lambda p: json.load(open(p, encoding='utf-8'))

def rnd(o, nd=5):
    if isinstance(o, float): return round(o, nd)
    if isinstance(o, (list, tuple)): return [rnd(x, nd) for x in o]
    if isinstance(o, dict): return {k: rnd(v, nd) for k, v in o.items()}
    return o

def save(name, feats):
    fc = {"type": "FeatureCollection", "features": feats}
    with open(f'{OUT}/{name}', 'w', encoding='utf-8') as f:
        json.dump(rnd(fc), f, ensure_ascii=False, separators=(',', ':'))
    print(name, len(feats), os.path.getsize(f'{OUT}/{name}')//1024, 'KB')

def simp(g, tol_m):
    return transform(bw, transform(fw, g).simplify(tol_m, preserve_topology=True))

# ---------- límites ----------
alc = load(A + '/mapa_base_grises/alcaldias_cdmx.geojson')['features']
eca = load(A + '/mapa_base_grises/municipio_ecatepec.geojson')['features']
limites = []
for f in alc:
    limites.append({"type": "Feature", "properties": {"nombre": f['properties']['nombre'], "entidad": "CDMX"},
                    "geometry": mapping(simp(shape(f['geometry']), 15))})
for f in eca:
    limites.append({"type": "Feature", "properties": {"nombre": "Ecatepec", "entidad": "Edomex"},
                    "geometry": mapping(simp(shape(f['geometry']), 15))})
save('limites.geojson', limites)
lim_geo = [(f['properties']['nombre'], shape(f['geometry'])) for f in limites]
lim_tree = STRtree([g for _, g in lim_geo])
def donde(pt):
    for i in lim_tree.query(pt):
        if lim_geo[i][1].contains(pt): return lim_geo[i][0]
    return None

# ---------- etiquetas de alcaldías + Ecatepec ----------
et = load(A + '/mapa_base_grises/etiquetas_alcaldias.geojson')['features']
et = [{"type": "Feature", "properties": {"nombre": f['properties']['nombre']}, "geometry": f['geometry']} for f in et]
save('etiquetas_alcaldias.geojson', et)

# ---------- vialidades principales (solo vía rápida y primaria) ----------
cp = load(A + '/mapa_base_grises/calles_principales.geojson')['features']
vias = []
for f in cp:
    c = f['properties']['clase']
    if c.startswith('1') or c.startswith('2'):
        g = simp(shape(f['geometry']), 8)
        vias.append({"type": "Feature", "properties": {"nombre": f['properties']['nombre'] or '', "clase": int(c[0])}, "geometry": mapping(g)})
save('vialidades.geojson', vias)

# ---------- agua y áreas verdes grandes ----------
ag = load(A + '/mapa_base_grises/agua.geojson')['features']
agua = [{"type": "Feature", "properties": {}, "geometry": mapping(simp(shape(f['geometry']), 10))}
        for f in ag if transform(fw, shape(f['geometry'])).area > 20000]
save('agua.geojson', agua)
av = load(A + '/mapa_base_grises/areas_verdes.geojson')['features']
verdes = []
for f in av:
    g = shape(f['geometry'])
    if transform(fw, g).area > 250000:
        verdes.append({"type": "Feature", "properties": {"nombre": f['properties'].get('nombre') or ''}, "geometry": mapping(simp(g, 20))})
save('areas_verdes.geojson', verdes)

# ---------- transporte: Metro, Mexibús, Mexicable ----------
lt = load(A + '/experimentos/mapa_transporte/geojson/lineas_transporte.geojson')['features']
trans = []
for f in lt:
    p = f['properties']
    if p['sistema'] in ('Metro', 'Mexibús', 'Mexicable'):
        trans.append({"type": "Feature", "properties": {"sistema": p['sistema'], "linea": str(p['linea']), "nombre": p['nombre']},
                      "geometry": mapping(simp(shape(f['geometry']), 10))})
save('transporte.geojson', trans)

# ---------- malla hexagonal de oportunidades ----------
R = 300.0   # radio del hexágono en m (distancia centro-vértice); separación entre centros ≈ 520 m
W = math.sqrt(3) * R; H = 1.5 * R
def hexid(x, y):
    # coordenadas axiales (hexágonos con punta arriba)
    q = (math.sqrt(3)/3 * x - 1/3 * y) / R; r = (2/3 * y) / R
    xx, zz = q, r; yy = -xx - zz
    rx, ry, rz = round(xx), round(yy), round(zz)
    dx, dy, dz = abs(rx-xx), abs(ry-yy), abs(rz-zz)
    if dx > dy and dx > dz: rx = -ry - rz
    elif dy > dz: ry = -rx - rz
    else: rz = -rx - ry
    return rx, rz
def hexcentro(q, r):
    return R * math.sqrt(3) * (q + r/2), R * 1.5 * r

celdas = collections.defaultdict(lambda: {"e": 0, "esc": 0, "sal": 0, "cul": 0})
op = load(A + '/Mapa_de_oportunidades/web/oportunidades.geojson')['features']
for f in op:
    lon, lat = f['geometry']['coordinates']; p = f['properties']
    c = celdas[hexid(*fw(lon, lat))]
    c['e'] += p.get('empleo_est') or 0
    t = p['tipo']
    if t == 'Escuelas y educación': c['esc'] += 1
    elif t == 'Salud y asistencia social': c['sal'] += 1
    elif t == 'Cultura, deporte y recreación': c['cul'] += 1
mic = load(A + '/Mapa_de_oportunidades/web/micronegocios_rejilla.geojson')['features']
for f in mic:
    lon, lat = f['geometry']['coordinates']
    celdas[hexid(*fw(lon, lat))]['e'] += f['properties']['empleo_est']

# quintiles (sobre celdas con dato) → clase 1..5; 0 = sin dato
def cortes(vals):
    v = sorted(x for x in vals if x > 0)
    cs = [v[int(len(v) * k / 5)] for k in (1, 2, 3, 4)]
    # en conteos pequeños los quintiles se repiten: se fuerzan cortes crecientes (mínimo 2 para la clase 2)
    out = []
    for c in cs:
        c = max(c, 2, (out[-1] + 1) if out else 2)
        out.append(c)
    return out
def clase(x, cs):
    if x <= 0: return 0
    return 1 + sum(x >= c for c in cs)
campos = ['e', 'esc', 'sal', 'cul']
K = {k: cortes([c[k] for c in celdas.values()]) for k in campos}
print('cortes', K)

# isócrona 60 min (unión de las 20 colonias, acceso en combi, día)
iso = load(A + '/Mapa_de_ISOCRONAS/isocronas.geojson')['features']
por_col = collections.defaultdict(list)
for f in iso:
    p = f['properties']
    if p['acceso'] == 'combi' and p['horario'] == 'dia' and p['t_max'] <= 60:
        por_col[p['colonia']].append(shape(f['geometry']).buffer(0))
col60 = {k: unary_union(v) for k, v in por_col.items()}
iso60 = unary_union(list(col60.values()))
iso60_m = transform(fw, iso60).buffer(60).buffer(-60).simplify(60)
iso60_m = MultiPolygon([p for p in (iso60_m.geoms if hasattr(iso60_m, 'geoms') else [iso60_m]) if p.area > 2e6]) if True else iso60_m
iso60 = transform(bw, iso60_m)
save('isocrona_60min.geojson', [{"type": "Feature", "properties": {"minutos": 60, "acceso": "combi + transporte público", "horario": "día laborable, salida 6:30–7:30",
      "descripcion": "Zona a la que se llega en 60 minutos o menos desde al menos una de las 20 colonias más pobladas de Ecatepec"}, "geometry": mapping(iso60)}])

malla = []; total_e = 0; en60 = 0
for (q, r), c in celdas.items():
    x, y = hexcentro(q, r); lon, lat = bw(x, y); pt = Point(lon, lat)
    zona = donde(pt)
    if zona is None:  # fuera de CDMX/Ecatepec: se asigna a la zona más cercana
        zona = lim_geo[lim_tree.nearest(pt)][0]
    props = {"empleos": int(round(c['e'])), "escuelas": c['esc'], "salud": c['sal'], "cultura": c['cul'], "zona": zona}
    for k, n in zip(campos, ['c_empleo', 'c_escuelas', 'c_salud', 'c_cultura']):
        props[n] = clase(c[k], K[k])
    malla.append({"type": "Feature", "properties": props, "geometry": {"type": "Point", "coordinates": [lon, lat]}})
save('oportunidades_malla.geojson', malla)

# % de empleos alcanzables en 60 min por colonia de origen
pts = [(Point(f['geometry']['coordinates']), f['properties']['empleos']) for f in malla]
tot = sum(e for _, e in pts)
co = load(A + '/Mapa_de_ISOCRONAS/colonias_origen.geojson')['features']
out = []
for f in co:
    p = f['properties']; g = col60.get(p['colonia'])
    alc_e = sum(e for pt, e in pts if g is not None and g.contains(pt))
    out.append({"type": "Feature", "properties": {"colonia": p['colonia'], "poblacion": p['poblacion'], "mujeres": int(p['mujeres']),
        "t_mediana": p['t_mediana'], "pct_empleo_60": round(100 * alc_e / tot, 1), "destinos_60min": p['destinos_60min']},
        "geometry": mapping(simp(shape(f['geometry']), 10))})
save('colonias_origen.geojson', out)
pct = sorted(x['properties']['pct_empleo_60'] for x in out)
alc_any = sum(e for pt, e in pts if iso60.contains(pt))
print('pct por colonia', pct, 'union', round(100*alc_any/tot, 1), 'total empleos', tot)
# empleo dentro de cada alcaldía (para comparar con lo alcanzable)

# metadatos de la malla (cortes de cada clase) para la leyenda
fc = load(f'{OUT}/oportunidades_malla.geojson')
fc['metadatos'] = {"cortes": {"c_empleo": K['e'], "c_escuelas": K['esc'], "c_salud": K['sal'], "c_cultura": K['cul']},
                   "separacion_m": round(math.sqrt(3) * R), "total_empleos": int(tot),
                   "pct_empleo_60_union": round(100 * alc_any / tot, 1),
                   "fuente": "INEGI, DENUE 05/2025 (CDMX y Ecatepec). Empleo estimado con el punto medio del rango de personal ocupado."}
json.dump(fc, open(f'{OUT}/oportunidades_malla.geojson', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

# lugares para etiquetas (estación Indios Verdes, Ecatepec, zonas de destino)
est = load(A + '/experimentos/mapa_transporte/geojson/estaciones.geojson')['features']
iv = next(f for f in est if f['properties']['nombre'] == 'Indios Verdes' and f['properties']['sistema'] == 'Metro')
lug = [{"type": "Feature", "properties": {"nombre": "Indios Verdes", "tipo": "estacion"}, "geometry": iv['geometry']}]
ep = shape(eca[0]['geometry']).representative_point()
lug.append({"type": "Feature", "properties": {"nombre": "Ecatepec", "tipo": "municipio"}, "geometry": mapping(ep)})
for f in load(A + '/Mapa_de_ISOCRONAS/destinos.geojson')['features']:
    p = f['properties']
    lug.append({"type": "Feature", "properties": {"nombre": p['nombre'], "tipo": "destino_" + p['tipo'], "t_mediana": p['t_mediana_desde_ecatepec']}, "geometry": f['geometry']})
save('lugares.geojson', lug)
