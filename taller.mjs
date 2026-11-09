// Lo que corre dentro de Chrome, en la página del taller (sacar-fotos.mjs): pdf.js para dibujar un PDF, KaTeX para las
// fórmulas de un HTML y el canvas que arma la foto. Esta página es nuestra y nunca muestra lo subido: un PDF se lee
// como datos, y un HTML se procesa con DOMParser, que no corre ni carga nada, y se fotografía en otra página, sin red y
// sin JavaScript salvo sus scripts prendidos por el panel.
import * as pdfjs from '/pdfjs/build/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.min.mjs';

const aBase64 = async (blob) => {
  const b = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

// Una hoja casi sin nada: menos del 8 % de los renglones tiene tinta, algo que se aparta del color más común. Una
// página vacía, o solo una barra arriba, queda afuera. La de un resumen tiene renglones en toda la hoja.
function enBlanco(c, ancho, alto) {
  const { data } = c.getImageData(0, 0, ancho, alto);
  const veces = new Map();
  for (let i = 0; i < data.length; i += 4 * 7) {
    const clave = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    veces.set(clave, (veces.get(clave) ?? 0) + 1);
  }
  const fondo = [...veces].sort((a, b) => b[1] - a[1])[0][0];
  const [fr, fg, fb] = [((fondo >> 8) & 15) * 16 + 8, ((fondo >> 4) & 15) * 16 + 8, (fondo & 15) * 16 + 8];
  let conTinta = 0;
  for (let y = 0; y < alto; y += 1) {
    let puntos = 0;
    for (let x = 0; x < ancho && puntos < 3; x += 2) {
      const i = (y * ancho + x) * 4;
      if (Math.abs(data[i] - fr) + Math.abs(data[i + 1] - fg) + Math.abs(data[i + 2] - fb) > 60) puntos += 1;
    }
    if (puntos >= 3) conTinta += 1;
  }
  return conTinta / alto < 0.08;
}

// Lleva la imagen al ancho final sobre blanco, con el alto entre los topes (una página más larga se corta abajo, una
// más ancha se completa con blanco), y la pasa a WebP con la mejor calidad que entre en el tope. Con `revisarBlanco`
// (la hoja de un HTML), una hoja vacía no sale: la portada de un PDF puede tener poco y sigue siendo su foto.
async function armarFoto(origen, ancho, alto, { tope, calidades, proporcionMin, proporcionMax, final }, revisarBlanco = false) {
  const altoFinal = Math.round((final * alto) / ancho);
  const lienzo = document.createElement('canvas');
  lienzo.width = final;
  lienzo.height = Math.min(Math.max(altoFinal, Math.round(final * proporcionMin)), Math.round(final * proporcionMax));
  const c = lienzo.getContext('2d', { alpha: false });
  c.fillStyle = '#fff';
  c.fillRect(0, 0, lienzo.width, lienzo.height);
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(origen, 0, 0, ancho, alto, 0, 0, final, altoFinal);
  if (revisarBlanco && enBlanco(c, lienzo.width, lienzo.height)) throw new Error('la hoja está en blanco');
  for (const calidad of calidades) {
    const blob = await new Promise((listo) => lienzo.toBlob(listo, 'image/webp', calidad));
    if (blob && blob.type === 'image/webp' && blob.size <= tope) {
      return { datos: await aBase64(blob), tipo: 'image/webp', ancho: lienzo.width, alto: lienzo.height };
    }
  }
  throw new Error('la foto no entra en el tope');
}

// La página 1 del PDF que sirve /archivo, al doble del ancho final y después achicada: los renglones finos quedan
// parejos. Solo se dibuja lo que entra en la foto.
window.fotoDePdf = async (opciones) => {
  const tarea = pdfjs.getDocument({
    url: '/archivo',
    cMapUrl: '/pdfjs/cmaps/',
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    wasmUrl: '/pdfjs/wasm/',
    iccUrl: '/pdfjs/iccs/',
    // Lo fijo lo pide esta página, así pasa por el mismo filtro de red que todo lo demás.
    useWorkerFetch: false,
    enableXfa: false,
    maxImageSize: 50_000_000,
    disableAutoFetch: true,
    disableStream: true,
  });
  try {
    const doc = await tarea.promise;
    const pagina = await doc.getPage(1);
    const base = pagina.getViewport({ scale: 1 });
    const vista = pagina.getViewport({ scale: (opciones.final * 2) / base.width });
    const lienzo = document.createElement('canvas');
    lienzo.width = Math.round(vista.width);
    lienzo.height = Math.round(Math.min(vista.height, vista.width * opciones.proporcionMax));
    await pagina.render({ canvas: lienzo, viewport: vista, background: '#fff' }).promise;
    return await armarFoto(lienzo, lienzo.width, lienzo.height, opciones);
  } finally {
    await tarea.destroy();
  }
};

// La captura de la hoja de un HTML, que llega como PNG.
window.fotoDePng = async (datos, opciones) => {
  const img = new Image();
  img.src = `data:image/png;base64,${datos}`;
  await img.decode();
  return armarFoto(img, img.naturalWidth, img.naturalHeight, opciones, true);
};

// La hoja de un HTML, lista para la foto. Sale todo lo que pide algo a la red o cambia la página (link, base, meta salvo
// el charset, scripts, marcos) y entra la misma política que trae la copia limpia del servicio, por si llegara algo que
// no lo es. Las fórmulas van como MathML, igual que en el lector del banco (armarHtml en banco.js). DOMParser no corre
// ni carga nada. Con `conScripts` (el original de un HTML con sus scripts prendidos por el panel) quedan sus scripts y
// la política los deja correr. Los de afuera no cargan: la hoja no tiene red.
const POLITICA = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'";
const POLITICA_CON_SCRIPTS = "default-src 'none'; img-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'";
const FUERA = 'link, base, meta:not([charset]), iframe, frame, frameset, object, embed, portal';
const FORMULA = /\\\[|\\\(|\$\$|\\begin\{/;
window.prepararHtml = (texto, { conScripts = false } = {}) => {
  const doc = new DOMParser().parseFromString(texto, 'text/html');
  for (const el of doc.querySelectorAll(conScripts ? FUERA : `${FUERA}, script`)) el.remove();
  if (FORMULA.test(texto)) {
    window.renderMathInElement(doc.body, { output: 'mathml', throwOnError: false, trust: false, strict: 'ignore' });
  }
  const politica = doc.createElement('meta');
  politica.httpEquiv = 'Content-Security-Policy';
  politica.content = conScripts ? POLITICA_CON_SCRIPTS : POLITICA;
  doc.head.prepend(politica);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
};

window.tallerListo = true;
