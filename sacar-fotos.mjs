#!/usr/bin/env node
// Fotos de la primera página de los resúmenes del banco de El Santo Resumen (migración 015 del servicio, contrato en
// ESPEC-SERVICIO.md, «Fotos de la primera página»). Le pide al servicio lo pendiente, abre cada archivo en un Chrome
// de verdad, saca la foto de su primera página y la sube. Corre en GitHub Actions (.github/workflows/fotos.yml) cuando
// el servicio lo pide, después de una subida, una versión nueva o una aprobación, o a mano. Sin cron.
//
//   node sacar-fotos.mjs     Pide UTN_API_URL (la base de la función utn) y UTN_FOTOS_SECRETO. CHROME es la ruta del
//                            navegador: en ubuntu-latest ya viene en /usr/bin/google-chrome y no se baja ninguno.
//
// Un PDF se dibuja con pdf.js (la página 1 en un canvas), nunca con el visor de Chrome. Un HTML es la copia limpia que
// guarda el servicio: se abre sin JavaScript y sin red, solo con lo propio, en una hoja con la proporción de un A4 y el
// ancho de una pantalla. Antes se le dibujan las fórmulas como MathML, igual que en el lector del banco. Un HTML con
// sus scripts prendidos por el panel (`js` en lo pendiente) se arma con ellos, desde su original, porque sin ellos la
// página queda vacía. Corren igual sin red, sin ventanas ni descargas. Si el servicio no da el original, va la copia
// limpia. La foto empieza en lo primero que se ve: un menú escondido arriba no deja la hoja vacía. Una hoja en blanco
// no se sube y la tarjeta sigue con su carátula.
// Lo que viene del banco es hostil. Cada archivo va en contextos nuevos que se cierran al terminar o al pasarse del
// tiempo. El navegador no hereda los secretos ni tiene red: Playwright sirve lo del taller y corta el resto, y lo que
// se escape va a un proxy que no existe. Nada de lo que trae un archivo se imprime: los logs llevan solo ids y conteos.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const requerir = createRequire(import.meta.url);
const PDFJS = path.dirname(requerir.resolve('pdfjs-dist/package.json'));
const KATEX = path.join(path.dirname(requerir.resolve('katex/package.json')), 'dist');

// La foto: 480 px de ancho, lo que pide una tarjeta nítida en una pantalla de alta densidad. El alto es el de la
// página, entre un cuarto y 1,75 veces el ancho: una página más larga se corta abajo y una más ancha se completa.
const ANCHO = 480;
const PROPORCION_MIN = 0.25;
const PROPORCION_MAX = 1.75;
// La hoja de un HTML: proporción A4 al ancho de una pantalla chica, como lo lee alguien en una notebook.
const HOJA_HTML = { width: 900, height: Math.round(900 * Math.SQRT2) };
const TOPE_FOTO = 140 * 1024; // El servicio acepta hasta 150 KiB.
const CALIDADES = [0.82, 0.72, 0.6, 0.5, 0.4];
const TOPE_ARCHIVO = 16 * 1024 * 1024; // PDF hasta 15 MB y HTML hasta 5 MB, más margen.
const TIEMPO_POR_PEDIDO_MS = 60_000;
const TIEMPO_POR_ARCHIVO_MS = 45_000;
const TIEMPO_TOTAL_MS = 12 * 60_000; // Menos que `timeout-minutes` del workflow.
// Lo que esperan los scripts de un HTML para armar su página antes de la foto.
const ESPERA_SCRIPTS_MS = 2500;
const TOPE_POR_CORRIDA = 200;
const TALLER = 'https://taller.invalid';

class Fallo extends Error {}

// ---------- El servicio ----------

function configuracion() {
  const base = process.env.UTN_API_URL ?? '';
  const secreto = process.env.UTN_FOTOS_SECRETO ?? '';
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Fallo('UTN_API_URL no es una dirección.');
  }
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new Fallo('UTN_API_URL tiene que ser https.');
  if (!secreto) throw new Fallo('Falta UTN_FOTOS_SECRETO.');
  return { base: url, secreto };
}

// Nunca sigue una redirección: el secreto no viaja a otra dirección.
async function pedir(cfg, consulta, init = {}) {
  const url = new URL(cfg.base);
  for (const [k, v] of new URLSearchParams(consulta.replace(/^\?/, ''))) url.searchParams.set(k, v);
  return fetch(url, {
    ...init,
    redirect: 'error',
    headers: { ...init.headers, 'x-utn-fotos': cfg.secreto },
    signal: AbortSignal.timeout(TIEMPO_POR_PEDIDO_MS),
  });
}

async function leerConTope(res, tope) {
  const declarado = Number(res.headers.get('content-length') ?? 0);
  if (declarado > tope) throw new Error('archivo demasiado grande');
  const partes = [];
  let total = 0;
  for await (const parte of res.body ?? []) {
    total += parte.length;
    if (total > tope) throw new Error('archivo demasiado grande');
    partes.push(parte);
  }
  return Buffer.concat(partes);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function pendientes(cfg) {
  const res = await pedir(cfg, 'a=fotos-pendientes', { method: 'POST' });
  if (res.status === 403) throw new Fallo('El servicio no aceptó UTN_FOTOS_SECRETO.');
  if (res.status === 404) throw new Fallo('El servicio todavía no tiene las fotos (015).');
  if (!res.ok) throw new Fallo(`El servicio respondió ${res.status} a fotos-pendientes.`);
  const datos = await res.json();
  if (!Array.isArray(datos?.pendientes)) throw new Fallo('fotos-pendientes no trajo una lista.');
  return datos.pendientes.filter(
    (p) => UUID.test(p?.id) && Number.isInteger(p?.version) && p.version > 0 && ['pdf', 'html'].includes(p?.tipo),
  );
}

// { bytes, js }: el archivo, y si es el original de un HTML con sus scripts. null si ya no espera su foto.
async function bajar(cfg, p) {
  if (p.tipo === 'html' && p.js === true) {
    const res = await pedir(cfg, `a=fotos-archivo&id=${p.id}&version=${p.version}&js=1`);
    if (res.status === 409) return null;
    if (res.ok) return { bytes: await leerConTope(res, TOPE_ARCHIVO), js: true };
    // Sin el original (404 sin-js), la copia limpia.
    if (res.status !== 404) throw new Error(`fotos-archivo respondió ${res.status}`);
  }
  const res = await pedir(cfg, `a=fotos-archivo&id=${p.id}&version=${p.version}`);
  if (res.status === 404 || res.status === 409) return null;
  if (!res.ok) throw new Error(`fotos-archivo respondió ${res.status}`);
  return { bytes: await leerConTope(res, TOPE_ARCHIVO), js: false };
}

async function subir(cfg, p, foto) {
  const res = await pedir(cfg, `a=fotos-subir&id=${p.id}&version=${p.version}`, {
    method: 'POST',
    headers: { 'content-type': foto.tipo },
    body: foto.bytes,
  });
  if (res.status === 201) return 'subida';
  // Mientras se sacaba, el resumen se ocultó, cambió de versión o ya tiene una.
  if (res.status === 404 || res.status === 409) return 'sin-cambios';
  let motivo = '';
  try {
    const cuerpo = await res.json();
    motivo = typeof cuerpo?.motivo === 'string' ? cuerpo.motivo.slice(0, 20) : '';
  } catch {
    // Sin cuerpo legible.
  }
  throw new Error(`fotos-subir respondió ${res.status}${motivo ? ` (${motivo})` : ''}`);
}

// ---------- El taller ----------

// La página del taller es nuestra (taller.mjs): pdf.js, KaTeX y el canvas que arma la foto.
const PAGINA_TALLER = `<!doctype html><html><head><meta charset="utf-8"><title>taller</title></head><body>
<script src="/katex/katex.min.js"></script>
<script src="/katex/contrib/auto-render.min.js"></script>
<script type="module" src="/taller.mjs"></script></body></html>`;

const TIPOS = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };

// Solo lo que el taller necesita, desde node_modules. Cualquier otro pedido se corta.
async function servirTaller(route, archivo) {
  const url = new URL(route.request().url());
  if (url.origin !== TALLER) return route.abort('blockedbyclient');
  if (url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: PAGINA_TALLER });
  if (url.pathname === '/archivo' && archivo) return route.fulfill({ status: 200, contentType: 'application/pdf', body: archivo });
  if (url.pathname === '/taller.mjs') return route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(path.join(AQUI, 'taller.mjs')) });
  const [, raiz, ...resto] = url.pathname.split('/');
  const base = raiz === 'pdfjs' ? PDFJS : raiz === 'katex' ? KATEX : null;
  const relativo = path.normalize(resto.map(decodeURIComponent).join('/'));
  if (!base || relativo.startsWith('..') || path.isAbsolute(relativo)) return route.abort('blockedbyclient');
  try {
    const cuerpo = await readFile(path.join(base, relativo));
    const tipo = TIPOS[path.extname(relativo)] ?? 'application/octet-stream';
    return route.fulfill({ status: 200, contentType: tipo, body: cuerpo });
  } catch {
    return route.fulfill({ status: 404, body: '' });
  }
}

// ---------- Cada archivo ----------

const OPCIONES_FOTO = { tope: TOPE_FOTO, calidades: CALIDADES, proporcionMin: PROPORCION_MIN, proporcionMax: PROPORCION_MAX, final: ANCHO };

// `abrir` crea un contexto nuevo y lo anota: sacarFoto los cierra todos al terminar o al pasarse del tiempo, así un
// archivo colgado no sigue gastando el navegador.
async function abrirTaller(abrir, archivo = null) {
  const contexto = await abrir({ viewport: { width: 1000, height: 800 }, serviceWorkers: 'block', acceptDownloads: false });
  await contexto.route('**/*', (route) => servirTaller(route, archivo));
  const pagina = await contexto.newPage();
  await pagina.goto(`${TALLER}/`, { waitUntil: 'load', timeout: TIEMPO_POR_ARCHIVO_MS });
  await pagina.waitForFunction(() => window.tallerListo === true, null, { timeout: TIEMPO_POR_ARCHIVO_MS });
  return pagina;
}

async function fotoDePdf(abrir, bytes) {
  const taller = await abrirTaller(abrir, bytes);
  return taller.evaluate((o) => window.fotoDePdf(o), OPCIONES_FOTO);
}

// Dónde empieza lo que se ve: el borde de arriba del primer texto o imagen visible dentro del ancho de la hoja. Un menú
// lateral que en una pantalla chica se esconde corrido a un costado deja su lugar arriba, vacío.
function dondeEmpieza() {
  const ancho = window.innerWidth;
  let arriba = Infinity;
  const anotar = (r) => {
    if (r.width >= 1 && r.height >= 1 && r.right > 0 && r.left < ancho) arriba = Math.min(arriba, r.top + window.scrollY);
  };
  const visible = (el) => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const textos = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  const rango = document.createRange();
  for (let n = textos.nextNode(); n; n = textos.nextNode()) {
    if (!n.textContent.trim() || !n.parentElement || !visible(n.parentElement)) continue;
    rango.selectNodeContents(n);
    for (const r of rango.getClientRects()) anotar(r);
  }
  for (const el of document.querySelectorAll('img, svg, canvas, video, math')) {
    const r = el.getBoundingClientRect();
    if (r.width >= 16 && r.height >= 16 && visible(el)) anotar(r);
  }
  return { arriba: Number.isFinite(arriba) ? arriba : 0, alto: document.documentElement.scrollHeight };
}

async function fotoDeHtml(abrir, { bytes, js }) {
  const taller = await abrirTaller(abrir);
  const html = await taller.evaluate(([t, s]) => window.prepararHtml(t, { conScripts: s }), [bytes.toString('utf8'), js]);
  // La hoja: sin red, sin descargas ni ventanas nuevas. JavaScript solo para los scripts que prendió el panel.
  const contexto = await abrir({
    viewport: HOJA_HTML,
    deviceScaleFactor: 1,
    javaScriptEnabled: js,
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  await contexto.route('**/*', (route) => route.abort('blockedbyclient'));
  const pagina = await contexto.newPage();
  pagina.on('popup', (otra) => otra.close().catch(() => {}));
  await pagina.setContent(html, { waitUntil: 'load', timeout: TIEMPO_POR_ARCHIVO_MS });
  if (js) await pagina.waitForTimeout(ESPERA_SCRIPTS_MS);
  const { arriba, alto } = await pagina.evaluate(dondeEmpieza);
  // Lo primero que se ve, con un respiro arriba. Cerca del principio, desde el principio.
  const desde = arriba > 48 ? Math.max(0, Math.min(arriba - 24, alto - HOJA_HTML.height)) : 0;
  const png = await pagina.screenshot({
    type: 'png',
    animations: 'disabled',
    timeout: TIEMPO_POR_ARCHIVO_MS,
    ...(desde ? { fullPage: true, clip: { x: 0, y: desde, width: HOJA_HTML.width, height: HOJA_HTML.height } } : {}),
  });
  return taller.evaluate(([d, o]) => window.fotoDePng(d, o), [png.toString('base64'), OPCIONES_FOTO]);
}

function conTiempo(promesa, ms) {
  let reloj;
  return Promise.race([
    promesa,
    new Promise((_, falla) => {
      reloj = setTimeout(() => falla(new Error('se pasó del tiempo')), ms);
    }),
  ]).finally(() => clearTimeout(reloj));
}

async function sacarFoto(navegador, p, bytes) {
  const abiertos = [];
  let terminado = false;
  const abrir = async (opciones) => {
    const contexto = await navegador.newContext(opciones);
    abiertos.push(contexto);
    // Si se pasó del tiempo mientras se abría, no sigue.
    if (terminado) {
      await contexto.close().catch(() => {});
      throw new Error('se pasó del tiempo');
    }
    return contexto;
  };
  try {
    const hecha = await conTiempo(p.tipo === 'pdf' ? fotoDePdf(abrir, bytes.bytes) : fotoDeHtml(abrir, bytes), TIEMPO_POR_ARCHIVO_MS);
    if (typeof hecha?.datos !== 'string' || hecha.tipo !== 'image/webp') throw new Error('el taller no devolvió una foto');
    return { bytes: Buffer.from(hecha.datos, 'base64'), tipo: hecha.tipo, ancho: hecha.ancho, alto: hecha.alto };
  } finally {
    terminado = true;
    await Promise.all(abiertos.map((c) => c.close().catch(() => {})));
  }
}

// ---------- El navegador ----------

// Chrome no hereda el entorno: ni el secreto ni la dirección del servicio llegan a un proceso que abre lo subido.
function entornoLimpio() {
  const pasan = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TZ', 'SystemRoot', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'XDG_RUNTIME_DIR'];
  return Object.fromEntries(pasan.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
}

async function abrirNavegador() {
  const opciones = {
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    headless: true,
    env: entornoLimpio(),
    args: [
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--no-first-run',
      '--disable-background-networking',
      '--disable-sync',
      '--mute-audio',
      // Sin red de verdad. Lo que se escape del filtro de Playwright (un prefetch lo pide el propio navegador) va a un
      // proxy que no existe, también lo local, y ningún nombre se resuelve.
      '--proxy-server=http://127.0.0.1:9',
      '--proxy-bypass-list=<-loopback>',
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
  };
  // Con el sandbox de Chrome si el sistema lo deja, que es lo que separa a un archivo hostil del resto.
  try {
    return await chromium.launch({ ...opciones, chromiumSandbox: true });
  } catch {
    console.log('Chrome sin sandbox: el sistema no lo deja.');
    return chromium.launch({ ...opciones, chromiumSandbox: false });
  }
}

// ---------- Principal ----------

async function principal() {
  const cfg = configuracion();
  const inicio = Date.now();
  const cuenta = { subida: 0, 'sin-cambios': 0, fallida: 0 };
  const vistos = new Set();
  let navegador = null;
  try {
    while (Date.now() - inicio < TIEMPO_TOTAL_MS && vistos.size < TOPE_POR_CORRIDA) {
      const lista = (await pendientes(cfg)).filter((p) => !vistos.has(`${p.id}/${p.version}`));
      if (!lista.length) break;
      navegador ??= await abrirNavegador();
      for (const p of lista) {
        vistos.add(`${p.id}/${p.version}`);
        if (Date.now() - inicio > TIEMPO_TOTAL_MS) break;
        try {
          const bytes = await bajar(cfg, p);
          if (!bytes) {
            cuenta['sin-cambios']++;
            continue;
          }
          const foto = await sacarFoto(navegador, p, bytes);
          const resultado = await subir(cfg, p, foto);
          cuenta[resultado]++;
          console.log(`${p.id} v${p.version} ${p.tipo}: ${resultado === 'subida' ? `${foto.ancho}x${foto.alto}, ${Math.round(foto.bytes.length / 1024)} KiB` : 'ya no hacía falta'}.`);
        } catch (e) {
          cuenta.fallida++;
          // Solo el id y un motivo nuestro: nada del archivo.
          const motivo = e instanceof Error ? e.message.split('\n')[0].slice(0, 80) : 'error';
          console.log(`::warning::${p.id} v${p.version} ${p.tipo}: no salió la foto (${motivo.replace(/[^\p{L}\p{N} ()._:-]/gu, '')}).`);
          // Si el navegador se cayó, el próximo archivo arranca con uno nuevo.
          if (navegador && !navegador.isConnected()) navegador = null;
        }
      }
    }
  } finally {
    await navegador?.close().catch(() => {});
  }
  console.log(`Fotos: ${cuenta.subida} subidas, ${cuenta['sin-cambios']} sin cambios, ${cuenta.fallida} fallidas.`);
}

principal().catch((e) => {
  console.error(e instanceof Fallo ? e.message : 'Falló la corrida.');
  process.exitCode = 1;
});
