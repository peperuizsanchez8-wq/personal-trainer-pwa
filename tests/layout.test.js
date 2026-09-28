// Prueba de diseño: abre la app en un Chromium REAL con el tamaño de un iPhone (390 px de ancho)
// y comprueba que ninguna pantalla se sale de los bordes. Un desbordamiento horizontal hace que
// el iPhone encoja toda la página (texto pequeño, botones cortados), que es justo el fallo que
// las pruebas sin navegador real no pueden ver.
//
// Ejecutar (desde la carpeta del proyecto):
//   npm install jsdom puppeteer-core @sparticuz/chromium     (una sola vez)
//   node tests/layout.test.js
// Con la opción --capturas guarda PNG de cada pantalla en tests/capturas/.

const http = require("http");
const fs = require("fs");
const path = require("path");
const chromium = require("@sparticuz/chromium").default || require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const { responder } = require("./servidor-falso");

const RAIZ = path.join(__dirname, "..");
const GUARDAR = process.argv.includes("--capturas");
let ANCHO = 390; // se cambia por pantalla en la prueba de varios anchos
const ahora = () => Math.floor(Date.now() / 1000);
const TIPOS = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

function servirEstatico() {
  return new Promise((resolver) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(RAIZ, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html"));
      if (!p.startsWith(RAIZ) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": TIPOS[path.extname(p)] || "application/octet-stream" });
      fs.createReadStream(p).pipe(res);
    }).listen(0, () => resolver(srv));
  });
}

let fallos = 0;
function comprobar(nombre, ok, detalle) {
  if (!ok) fallos++;
  console.log(`${ok ? "OK   " : "FALLO"} ${nombre}${ok ? "" : "  -> " + detalle}`);
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Mide desbordes: la página no puede ser más ancha que la pantalla y nada relevante puede quedar cortado.
async function medir(page) {
  return page.evaluate((ANCHO) => {
    const de = document.documentElement;
    const ofensores = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest("svg[style*='display:none']") || el.closest(".pill-row") || el.closest("svg")) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > ANCHO + 0.5 || r.left < -0.5) {
        ofensores.push(`${el.tagName.toLowerCase()}.${(el.className && el.className.baseVal === undefined ? el.className : "").toString().split(" ")[0]} [${Math.round(r.left)}..${Math.round(r.right)}]`);
      }
    }
    return { scrollWidth: de.scrollWidth, innerWidth: window.innerWidth, escala: window.visualViewport ? window.visualViewport.scale : 1, ofensores: [...new Set(ofensores)].slice(0, 6) };
  }, ANCHO);
}

async function pantalla(page, nombre, preparar) {
  await preparar();
  await esperar(250);
  const m = await medir(page);
  const ok = m.scrollWidth <= ANCHO && m.innerWidth === ANCHO && m.ofensores.length === 0;
  comprobar(`${nombre}: cabe en ${ANCHO}px`, ok, `scrollWidth=${m.scrollWidth} innerWidth=${m.innerWidth} escala=${m.escala} fuera: ${m.ofensores.join(", ")}`);
  if (GUARDAR) {
    fs.mkdirSync(path.join(__dirname, "capturas"), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, "capturas", nombre.replace(/[^a-z0-9]+/gi, "_").toLowerCase() + ".png") });
  }
  return m;
}

(async () => {
  const srv = await servirEstatico();
  const puerto = srv.address().port;
  const navegador = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: [...chromium.args, "--no-sandbox"], headless: "shell" });

  async function nuevaPagina(sesion, registradas = [], ancho = 390) {
    ANCHO = ancho;
    const page = await navegador.newPage();
    await page.setViewport({ width: ancho, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.setRequestInterception(true);
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (url.hostname.endsWith("supabase.co")) {
        if (req.method() === "OPTIONS") return req.respond({ status: 204, headers: cors });
        const cuerpo = req.postData() ? JSON.parse(req.postData()) : null;
        const r = responder(req.method(), decodeURIComponent(url.pathname + url.search), cuerpo, { registradas });
        return req.respond({ status: r.status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(r.cuerpo) });
      }
      if (url.hostname === "cdnjs.cloudflare.com") return req.respond({ status: 200, contentType: "text/javascript", body: "window.XLSX={};" });
      req.continue();
    });
    if (sesion) await page.evaluateOnNewDocument((s) => localStorage.setItem("sesion", JSON.stringify(s)), sesion);
    await page.goto(`http://localhost:${puerto}/index.html`);
    return page;
  }

  const base = { entrenador_id: "e1", access_token: "tok1", refresh_token: "ref1", expires_at: ahora() + 3600, autenticado_en: Date.now() };
  const alumno = { ...base, usuario_id: "u-alumno", rol: "alumno", nombre: "Pepe Ruiz" };
  const entrenador = { ...base, usuario_id: "u-ent", rol: "entrenador", nombre: "Javier Mirete" };
  const admin = { ...base, usuario_id: "u-admin", rol: "admin", entrenador_id: null, nombre: "Pepe" };

  // pesos con muchas cifras para comprobar que caben
  const registradas = [
    { serie_prescrita_id: "sp1", numero_serie: 1, peso_real: 102.5, valor_real: 12, completada: true, comentario: null, rir_real: 2, sin_tiempo: false },
    { serie_prescrita_id: "sp1", numero_serie: 2, peso_real: 100, valor_real: 10, completada: false, comentario: null, rir_real: null, sin_tiempo: false },
  ];

  // --- login
  let p = await nuevaPagina(null);
  await p.waitForSelector("#form-login");
  await pantalla(p, "Login", async () => {});
  await p.close();

  // --- alumno
  p = await nuevaPagina(alumno, registradas);
  await p.waitForSelector("[data-semana-id]");
  await pantalla(p, "Alumno resumen", async () => {});
  await p.click("[data-semana-id]");
  await p.waitForSelector(".stepper input.value");
  const m = await pantalla(p, "Alumno día con ejercicios", async () => {});
  const anchoInput = await p.$eval(".stepper input.value", (e) => e.getBoundingClientRect().width);
  comprobar("Alumno día: el campo del peso es lo bastante ancho para 102.5", anchoInput >= 44, `ancho=${Math.round(anchoInput)}px`);
  const check = await p.$eval(".check-btn", (e) => e.getBoundingClientRect().right);
  comprobar("Alumno día: el círculo de 'hecho' se ve entero", check <= ANCHO - 8, `borde derecho=${Math.round(check)}px`);
  // abrir desplegables
  await p.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
  await esperar(200);
  await pantalla(p, "Alumno día con desplegables abiertos", async () => {});
  await p.close();

  // --- el entreno en distintos móviles (iPhone SE, mini, estándar, Plus/Max)
  for (const ancho of [320, 360, 375, 430]) {
    p = await nuevaPagina(alumno, registradas, ancho);
    await p.waitForSelector("[data-semana-id]");
    await p.click("[data-semana-id]");
    await p.waitForSelector(".stepper input.value");
    await pantalla(p, `Alumno día a ${ancho}px`, async () => {});
    const w = await p.$eval(".stepper input.value", (e) => e.getBoundingClientRect().width);
    comprobar(`Alumno día a ${ancho}px: el campo del peso cabe 102.5 (${Math.round(w)}px)`, w >= 44, `ancho=${Math.round(w)}px`);
    const nota = await p.$eval(".note-input", (e) => e.getBoundingClientRect().width);
    comprobar(`Alumno día a ${ancho}px: el campo de la nota no queda diminuto (${Math.round(nota)}px)`, nota >= 70, `ancho=${Math.round(nota)}px`);
    await p.close();
  }
  ANCHO = 390;

  // --- entrenador
  p = await nuevaPagina(entrenador);
  await p.waitForSelector("#btn-alta-alumno");
  await pantalla(p, "Entrenador panel", async () => {});
  await p.click("#btn-alta-alumno");
  await p.waitForSelector("#modal-nombre");
  await pantalla(p, "Entrenador ventana nuevo alumno", async () => {});
  await p.click("#modal-cancelar");
  await p.click("[data-alumno]");
  await p.waitForSelector("#select-ejercicio-progresion");
  await pantalla(p, "Entrenador detalle de alumno", async () => {});
  await p.click("[data-dia-idx]");
  await p.waitForSelector(".exercise");
  await pantalla(p, "Entrenador detalle de día", async () => {});
  await p.close();

  p = await nuevaPagina(entrenador);
  await p.waitForSelector("#btn-historial");
  await p.click("#btn-historial");
  await p.waitForSelector("[data-editar]");
  await pantalla(p, "Entrenador planes anteriores", async () => {});
  await p.click("[data-editar]");
  await p.waitForSelector(".e-guardar");
  await pantalla(p, "Entrenador editor de plan", async () => {});
  await p.close();

  p = await nuevaPagina(entrenador);
  await p.waitForSelector("#btn-importar");
  await p.click("#btn-importar");
  await p.waitForSelector("#input-excel");
  await pantalla(p, "Entrenador subir plan", async () => {});
  await p.close();

  // --- admin
  p = await nuevaPagina(admin);
  await p.waitForSelector("[data-alta]");
  await pantalla(p, "Admin panel", async () => {});
  await p.click("[data-alta]");
  await p.waitForSelector("#modal-nombre");
  await p.type("#modal-nombre", "Nuevo Alumno");
  await p.click("#modal-crear");
  await p.waitForSelector(".pin-grande");
  await pantalla(p, "Admin PIN nuevo en ventana", async () => {});
  await p.close();

  await navegador.close();
  srv.close();
  console.log(fallos === 0 ? "\nTODAS LAS PRUEBAS DE DISEÑO PASARON" : `\n${fallos} PRUEBA(S) DE DISEÑO FALLARON`);
  process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => { console.error("Error en la propia prueba:", e); process.exit(2); });
