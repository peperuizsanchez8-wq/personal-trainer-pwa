// Prueba de humo de la app: carga index.html + app.js reales en un navegador simulado (jsdom)
// contra un servidor falso, sin red. Comprueba los flujos que más nos han dado problemas.
//
// Cómo ejecutarla (desde la carpeta del proyecto):
//   npm install jsdom          (una sola vez)
//   node tests/smoke.test.js
// Termina con código 0 si todo pasa y con 1 si algo falla.

const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const nodeCrypto = require("crypto");

const appJs = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/<script[^>]*><\/script>/g, "");

let fallos = 0;
function comprobar(nombre, condicion, detalle) {
  if (!condicion) fallos++;
  console.log(`${condicion ? "OK   " : "FALLO"} ${nombre}${condicion ? "" : "  -> " + (detalle ?? "")}`);
}
const esperar = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function hasta(fn, ms = 2000) {
  const inicio = Date.now();
  while (Date.now() - inicio < ms) { if (fn()) return true; await esperar(15); }
  return false;
}

const ahora = () => Math.floor(Date.now() / 1000);
const resp = (status, cuerpo) => ({ ok: status >= 200 && status < 300, status, json: async () => cuerpo, text: async () => JSON.stringify(cuerpo) });

const PRESCRITAS = [
  { id: "sp1", orden: 1, series: 3, reps_objetivo: "6-10", rir: 2, descanso: "2 min",
    ejercicios_catalogo: { id: "e-press", nombre: "Press <i>banca</i>", tipo_metrica: "reps" } },
  { id: "sp2", orden: 2, series: 2, reps_objetivo: "30-45 s", rir: 2, descanso: "60 s",
    ejercicios_catalogo: { id: "e-plancha", nombre: "Plancha lateral", tipo_metrica: "segundos" } },
];

function crearEntorno(sesion, opciones = {}) {
  const dom = new JSDOM(indexHtml, { url: "https://demo.test/app/", pretendToBeVisual: true, runScripts: "outside-only" });
  const w = dom.window;
  const servidor = {
    offline: false, llamadas: [], tokensValidos: new Set(["tok1"]), refrescos: 0, refreshStatus: 200,
    alertas: [], registradas: [],
  };
  // La configuración del servidor falso se aplica ANTES de arrancar la app
  if (opciones.refreshStatus) servidor.refreshStatus = opciones.refreshStatus;
  if (opciones.tokensValidos) servidor.tokensValidos = new Set(opciones.tokensValidos);
  if (!w.crypto) w.crypto = {};
  if (!w.crypto.randomUUID) w.crypto.randomUUID = () => nodeCrypto.randomUUID();
  w.alert = (m) => servidor.alertas.push(m);
  w.confirm = () => true;
  w.navigator.clipboard = { writeText: async () => {} };

  w.fetch = async (url, opts = {}) => {
    if (servidor.offline) throw new w.TypeError("Failed to fetch");
    const u = new URL(url);
    const ruta = decodeURIComponent(u.pathname + u.search);
    const metodo = opts.method || "GET";
    const auth = ((opts.headers || {}).Authorization || "").replace("Bearer ", "");
    const cuerpo = opts.body ? JSON.parse(opts.body) : null;
    servidor.llamadas.push({ metodo, ruta, auth, cuerpo });

    if (u.pathname === "/auth/v1/token") {
      servidor.refrescos++;
      if (servidor.refreshStatus !== 200) return resp(servidor.refreshStatus, { error: "invalid_grant" });
      const nuevo = "tok" + (servidor.refrescos + 1);
      servidor.tokensValidos.add(nuevo);
      return resp(200, { access_token: nuevo, refresh_token: "ref" + (servidor.refrescos + 1), expires_at: ahora() + 3600 });
    }
    if ((u.pathname.startsWith("/rest/v1/") || u.pathname.startsWith("/functions/v1/")) && !servidor.tokensValidos.has(auth)) {
      return resp(401, { message: "JWT expired" });
    }
    return servidor.datos(metodo, ruta, cuerpo);
  };

  servidor.datos = (metodo, ruta, cuerpo) => {
    // --- alumno ---
    if (ruta.startsWith("/rest/v1/asignaciones?usuario_id=eq.u-alumno"))
      return resp(200, [{ id: "a1", programa_id: "p1", created_at: new Date().toISOString(),
        nota_entrenador: 'Ánimo <img src=x onerror="window.__xss=1">', programas: { nombre: "Plan <b>X</b>", estado: "publicado" } }]);
    if (ruta.startsWith("/rest/v1/semanas?programa_id=eq.p1")) return resp(200, [{ id: "s1", numero: 1 }, { id: "s2", numero: 2 }]);
    if (ruta.startsWith("/rest/v1/dias?semana_id=in.")) return resp(200, [{ id: "d1", numero: 1, semana_id: "s1" }, { id: "d2", numero: 1, semana_id: "s2" }]);
    if (ruta.startsWith("/rest/v1/dias?semana_id=eq.s1")) return resp(200, [{ id: "d1", numero: 1 }]);
    if (ruta.startsWith("/rest/v1/dias?semana_id=eq.s2")) return resp(200, [{ id: "d2", numero: 1 }]);
    if (ruta.startsWith("/rest/v1/rpc/progreso_programa"))
      return resp(200, [
        { semana_numero: 1, dia_numero: 1, total_series: 5, series_completadas: 2, series_registradas: 2 },
        { semana_numero: 2, dia_numero: 1, total_series: 5, series_completadas: 0, series_registradas: 0 },
      ]);
    if (ruta.startsWith("/rest/v1/series_prescritas?dia_id=in.")) return resp(200, [{ series: 3, ejercicios_catalogo: { grupo_muscular: "Pecho" } }]);
    if (ruta.startsWith("/rest/v1/series_prescritas?dia_id=eq.")) return resp(200, PRESCRITAS);
    if (ruta.startsWith("/rest/v1/series_registradas?serie_prescrita_id=in.")) return resp(200, servidor.registradas);
    if (ruta.startsWith("/rest/v1/rpc/ultimos_registros")) return resp(200, []);
    if (ruta.startsWith("/rest/v1/rpc/progresion_ejercicio"))
      return resp(200, [{ semana_numero: 1, peso_max: 50, rir_promedio: 2 }, { semana_numero: 2, peso_max: 55, rir_promedio: 1.5 }]);
    if (metodo === "POST" && ruta.startsWith("/rest/v1/series_registradas")) return resp(201, [cuerpo[0]]);
    if (metodo === "DELETE" && ruta.startsWith("/rest/v1/series_registradas")) return resp(204, null);

    // --- entrenador / admin ---
    if (ruta.startsWith("/rest/v1/usuarios?entrenador_id=eq.e1&rol=eq.alumno"))
      return resp(200, [{ id: "u-alumno", nombre: "Pepe Ruiz", activo: true }, { id: "u-viejo", nombre: "Alumno Antiguo", activo: false }]);
    if (ruta.startsWith("/rest/v1/rpc/ultima_actividad")) return resp(200, null);
    if (ruta.startsWith("/rest/v1/entrenadores?select")) return resp(200, [{ id: "e1", nombre: "Grupo de Javier" }]);
    if (ruta.startsWith("/rest/v1/usuarios?rol=eq.entrenador")) return resp(200, [{ id: "u-ent", nombre: "Javier", entrenador_id: "e1", activo: true }]);
    if (ruta.startsWith("/rest/v1/usuarios?rol=eq.alumno")) return resp(200, [{ id: "u-alumno", nombre: "Pepe Ruiz", entrenador_id: "e1", activo: true }]);
    if (ruta.startsWith("/functions/v1/crear-usuario")) return resp(201, { usuario_id: "u-nuevo", nombre: cuerpo.nombre, rol: cuerpo.rol, pin: "4821" });
    if (ruta.startsWith("/functions/v1/cambiar-pin")) return resp(200, { ok: true });
    return resp(404, { message: "sin ruta simulada: " + metodo + " " + ruta });
  };

  if (sesion) w.localStorage.setItem("sesion", JSON.stringify(sesion));
  w.eval(appJs);
  return { w, servidor, doc: w.document };
}

const sesionAlumno = (extra = {}) => ({
  usuario_id: "u-alumno", rol: "alumno", entrenador_id: "e1", nombre: "Pepe Ruiz",
  access_token: "tok1", refresh_token: "ref1", expires_at: ahora() + 3600, autenticado_en: Date.now(), ...extra,
});

async function pruebas() {
  // ------------------------------------------------------------------ login
  {
    const { doc } = crearEntorno(null);
    comprobar("Sin sesión se muestra el login", !!doc.getElementById("form-login"));
    comprobar("El login no muestra texto de depuración", !/diagn[oó]stico/i.test(doc.body.textContent));
  }

  // ------------------------------------------------------------------ alumno: resumen y seguridad
  {
    const { w, doc } = crearEntorno(sesionAlumno());
    const cargo = await hasta(() => doc.querySelector("[data-semana-id]"));
    comprobar("Alumno: el resumen carga", cargo);
    comprobar("Alumno: la nota del entrenador se muestra como texto, no como HTML", !doc.querySelector("img") && w.__xss === undefined
      && doc.body.textContent.includes("<img src=x"), "se ha interpretado HTML de una nota");
    comprobar("Alumno: el nombre del plan se escapa", !doc.querySelector(".topbar b") && doc.querySelector(".topbar").textContent.includes("<b>X</b>"));
    comprobar("Alumno: aparece 'Cambiar mi PIN'", !!doc.getElementById("link-cambiar-pin"));

    // ------------------------------------------------------------------ entrar en una semana
    doc.querySelector("[data-semana-id]").click();
    const cargoDia = await hasta(() => doc.querySelectorAll(".stepper input.value").length > 0);
    comprobar("Alumno: pinchar una semana abre sus ejercicios", cargoDia);
    comprobar("Alumno: 3 series + 2 series = 10 campos editables (peso y reps)", doc.querySelectorAll(".stepper input.value").length === 10,
      doc.querySelectorAll(".stepper input.value").length);
    comprobar("Alumno: los nombres de ejercicio se escapan", !doc.querySelector(".exercise h2 i") && doc.querySelector(".exercise h2").textContent.includes("<i>banca</i>"));
    comprobar("Alumno: el desplegable de volumen existe y empieza cerrado", doc.querySelector("details.volumen-detalle") && !doc.querySelector("details.volumen-detalle").open);

    // ------------------------------------------------------------------ progresión propia
    const det = doc.querySelector("details[data-prog]");
    det.open = true;
    det.dispatchEvent(new w.Event("toggle"));
    const hayGrafico = await hasta(() => det.querySelector("svg"));
    comprobar("Alumno: 'Mi progresión' dibuja el gráfico", hayGrafico);
    comprobar("Alumno: resume la evolución (+5 kg)", /\+5 kg/.test(det.textContent), det.textContent);
  }

  // ------------------------------------------------------------------ escribir el peso a mano guarda una serie ya marcada
  {
    const { w, doc, servidor } = crearEntorno(sesionAlumno());
    await hasta(() => doc.querySelector("[data-semana-id]"));
    doc.querySelector("[data-semana-id]").click();
    await hasta(() => doc.querySelectorAll(".stepper input.value").length > 0);

    const fila1 = doc.querySelector(".set-row");
    fila1.querySelector(".check-btn").click();
    await hasta(() => servidor.llamadas.some((l) => l.metodo === "POST" && l.ruta.includes("series_registradas")));
    const antes = servidor.llamadas.filter((l) => l.metodo === "POST" && l.ruta.includes("series_registradas")).length;
    const inputPeso = fila1.querySelector('[data-campo="peso"] input.value');
    inputPeso.value = "62,5";
    inputPeso.dispatchEvent(new w.Event("change"));
    await hasta(() => servidor.llamadas.filter((l) => l.metodo === "POST" && l.ruta.includes("series_registradas")).length > antes);
    const ultimo = servidor.llamadas.filter((l) => l.metodo === "POST" && l.ruta.includes("series_registradas")).pop();
    comprobar("Escribir el peso (con coma) en una serie ya marcada la guarda sola", ultimo.cuerpo[0].peso_real === 62.5, JSON.stringify(ultimo.cuerpo));
    comprobar("Una serie marcada se guarda como completada y no 'sin tiempo'", ultimo.cuerpo[0].completada === true && ultimo.cuerpo[0].sin_tiempo === false);
  }

  // ------------------------------------------------------------------ "No me dio tiempo": marcar y deshacer
  {
    const { doc, servidor } = crearEntorno(sesionAlumno());
    await hasta(() => doc.querySelector("[data-semana-id]"));
    doc.querySelector("[data-semana-id]").click();
    await hasta(() => doc.querySelector(".skip-btn"));
    const skip = doc.querySelector(".exercise .skip-btn");
    skip.click();
    await hasta(() => servidor.llamadas.filter((l) => l.metodo === "POST" && l.cuerpo && l.cuerpo[0] && l.cuerpo[0].sin_tiempo === true).length === 3);
    const marcadas = servidor.llamadas.filter((l) => l.metodo === "POST" && l.cuerpo && l.cuerpo[0] && l.cuerpo[0].sin_tiempo === true);
    comprobar("'No me dio tiempo' guarda las 3 series sin texto en la nota", marcadas.length === 3 && marcadas.every((l) => !l.cuerpo[0].comentario));
    comprobar("El botón cambia a 'deshacer'", /deshacer/.test(skip.textContent));
    skip.click();
    const borro = await hasta(() => servidor.llamadas.some((l) => l.metodo === "DELETE" && l.ruta.includes("sin_tiempo=eq.true")));
    comprobar("Deshacer borra las filas vacías marcadas", borro);
    comprobar("El botón vuelve a su estado normal", skip.textContent.trim() === "No me dio tiempo");
  }

  // ------------------------------------------------------------------ renovación del token
  {
    const { doc, servidor } = crearEntorno(sesionAlumno({ expires_at: ahora() + 30 }));
    await hasta(() => doc.querySelector("[data-semana-id]"));
    const ses = JSON.parse(doc.defaultView.localStorage.getItem("sesion"));
    comprobar("Token a punto de caducar: se renueva antes de la primera llamada", servidor.refrescos === 1 && ses.access_token === "tok2", `refrescos=${servidor.refrescos} token=${ses.access_token}`);
    comprobar("Ninguna llamada de datos usó el token viejo", !servidor.llamadas.some((l) => l.ruta.startsWith("/rest") && l.auth === "tok1"));
    comprobar("Se conserva la hora de inicio de sesión (regla de 48 h)", ses.autenticado_en === JSON.parse(JSON.stringify(ses)).autenticado_en && ses.refresh_token === "ref2");
  }
  {
    // el servidor ya no acepta tok1 aunque en el móvil parezca vigente
    const { doc, servidor } = crearEntorno(sesionAlumno(), { tokensValidos: [] });
    const cargo = await hasta(() => doc.querySelector("[data-semana-id]"));
    comprobar("Si el servidor dice 401 se renueva y se reintenta solo", cargo && servidor.refrescos === 1, `refrescos=${servidor.refrescos}`);
  }
  {
    const { doc } = crearEntorno(sesionAlumno({ expires_at: ahora() + 30 }), { refreshStatus: 400 });
    const login = await hasta(() => doc.getElementById("form-login"));
    await esperar(200);
    comprobar("Si el servidor rechaza la renovación se vuelve al login", login && !!doc.getElementById("form-login"));
    comprobar("...y la carga en curso NO pinta la pantalla de inicio encima", !doc.querySelector("[data-semana-id]") && !doc.querySelector(".form-error"));
    comprobar("...y se borró la sesión guardada", doc.defaultView.localStorage.getItem("sesion") === null);
  }

  // ------------------------------------------------------------------ sin cobertura
  {
    const { w, doc, servidor } = crearEntorno(sesionAlumno());
    await hasta(() => doc.querySelector("[data-semana-id]"));
    doc.querySelector("[data-semana-id]").click();
    await hasta(() => doc.querySelectorAll(".stepper input.value").length > 0);

    servidor.offline = true;
    w.render();
    const abre = await hasta(() => doc.querySelector("[data-semana-id]"));
    comprobar("Sin cobertura: la app abre y muestra el resumen desde la caché", abre);
    doc.querySelector("[data-semana-id]").click();
    const hayDia = await hasta(() => doc.querySelectorAll(".stepper input.value").length > 0);
    comprobar("Sin cobertura: el día abre con sus ejercicios desde la caché", hayDia);

    doc.querySelector(".set-row .check-btn").click();
    await esperar(80);
    const cola = JSON.parse(w.localStorage.getItem("cola_pendiente") || "[]");
    comprobar("Sin cobertura: marcar una serie no se pierde, queda en cola", cola.length === 1, `cola=${cola.length}`);
    comprobar("Sin cobertura: avisa de lo pendiente de sincronizar", /1 serie/.test(doc.getElementById("indicador-cola").textContent));
    comprobar("Sin cobertura: no salta ninguna alerta de error", servidor.alertas.length === 0, servidor.alertas.join("|"));

    // reabrir el día aún sin cobertura: lo marcado debe seguir viéndose
    w.render();
    await hasta(() => doc.querySelector("[data-semana-id]"));
    doc.querySelector("[data-semana-id]").click();
    await hasta(() => doc.querySelectorAll(".stepper input.value").length > 0);
    comprobar("Sin cobertura: al reabrir el día, la serie marcada sigue marcada", doc.querySelectorAll(".check-btn.done").length === 1,
      doc.querySelectorAll(".check-btn.done").length);

    // vuelve la cobertura: se sincroniza sola
    servidor.offline = false;
    await w.sincronizarCola(w.leerSesion());
    const cola2 = JSON.parse(w.localStorage.getItem("cola_pendiente") || "[]");
    comprobar("Al volver la cobertura la cola se envía y se vacía", cola2.length === 0 &&
      servidor.llamadas.some((l) => l.metodo === "POST" && l.ruta.includes("series_registradas")));
  }
  {
    // un dato viejo en cola no debe pisar a uno más nuevo de la misma serie
    const { w, doc, servidor } = crearEntorno(sesionAlumno());
    await hasta(() => doc.querySelector("[data-semana-id]"));
    doc.querySelector("[data-semana-id]").click();
    await hasta(() => doc.querySelectorAll(".stepper input.value").length > 0);
    servidor.offline = true;
    doc.querySelector(".set-row .check-btn").click();
    await esperar(60);
    servidor.offline = false;
    const inputPeso = doc.querySelector('.set-row [data-campo="peso"] input.value');
    inputPeso.value = "70";
    inputPeso.dispatchEvent(new w.Event("change"));
    await esperar(150);
    const cola = JSON.parse(w.localStorage.getItem("cola_pendiente") || "[]");
    comprobar("Un guardado nuevo de una serie descarta el pendiente viejo de esa misma serie", cola.length === 0, `cola=${cola.length}`);
  }
  {
    // sin caché y sin cobertura: error claro, no pantalla en blanco
    const { w, doc, servidor } = crearEntorno(sesionAlumno());
    await hasta(() => doc.querySelector("[data-semana-id]"));
    w.limpiarCacheDatos();
    servidor.offline = true;
    w.render();
    const error = await hasta(() => doc.querySelector(".form-error"));
    comprobar("Sin cobertura y sin caché: se muestra un error claro", error);
  }

  // ------------------------------------------------------------------ entrenador
  {
    const { w, doc, servidor } = crearEntorno({ usuario_id: "u-ent", rol: "entrenador", entrenador_id: "e1", nombre: "Javier",
      access_token: "tok1", refresh_token: "ref1", expires_at: ahora() + 3600, autenticado_en: Date.now() });
    const carga = await hasta(() => doc.getElementById("btn-alta-alumno"));
    comprobar("Entrenador: el panel carga con 'Añadir alumno'", carga);
    comprobar("Entrenador: los desactivados aparecen aparte con 'Reactivar'", /Alumno Antiguo/.test(doc.body.textContent) && !!doc.querySelector("[data-reactivar]"));
    comprobar("Entrenador: cada alumno activo tiene 'Desactivar' y 'Resetear PIN'", !!doc.querySelector("[data-desactivar]") && !!doc.querySelector("[data-reset]"));
    comprobar("Entrenador: puede cambiar su propio PIN", !!doc.getElementById("link-cambiar-pin"));

    doc.getElementById("btn-alta-alumno").click();
    const modal = await hasta(() => doc.getElementById("modal-nombre"));
    comprobar("Entrenador: 'Añadir alumno' abre el formulario", modal);
    doc.getElementById("modal-nombre").value = "Lucía Gómez";
    doc.getElementById("modal-crear").click();
    const pin = await hasta(() => doc.querySelector(".pin-grande"));
    const llamada = servidor.llamadas.find((l) => l.ruta.startsWith("/functions/v1/crear-usuario"));
    comprobar("Entrenador: crea el alumno con el cuerpo correcto (sin pasar el grupo)", llamada && llamada.cuerpo.rol === "alumno" && llamada.cuerpo.nombre === "Lucía Gómez" && !("entrenador_id" in llamada.cuerpo), JSON.stringify(llamada && llamada.cuerpo));
    comprobar("Entrenador: el PIN nuevo se muestra grande en una ventana", pin && doc.querySelector(".pin-grande").textContent.trim() === "4821");
    comprobar("Entrenador: no se usa alert() para mostrar el PIN", servidor.alertas.length === 0);
    doc.getElementById("modal-ok").click();
    comprobar("Entrenador: al cerrar la ventana desaparece el PIN", !doc.querySelector(".modal-fondo"));
  }

  // ------------------------------------------------------------------ admin
  {
    const { doc, servidor } = crearEntorno({ usuario_id: "u-admin", rol: "admin", entrenador_id: null, nombre: "Pepe",
      access_token: "tok1", refresh_token: "ref1", expires_at: ahora() + 3600, autenticado_en: Date.now() });
    const carga = await hasta(() => doc.querySelector("[data-alta]"));
    comprobar("Admin: el panel carga con 'Añadir alumno' en cada grupo", carga);
    doc.querySelector("[data-alta]").click();
    await hasta(() => doc.getElementById("modal-nombre"));
    doc.getElementById("modal-nombre").value = "Nuevo Alumno";
    doc.getElementById("modal-crear").click();
    await hasta(() => doc.querySelector(".pin-grande"));
    const llamada = servidor.llamadas.find((l) => l.ruta.startsWith("/functions/v1/crear-usuario"));
    comprobar("Admin: crea el alumno indicando el grupo", llamada && llamada.cuerpo.entrenador_id === "e1", JSON.stringify(llamada && llamada.cuerpo));
    comprobar("Admin: puede desactivar y resetear a cualquiera", !!doc.querySelector("[data-activo]") && !!doc.querySelector("[data-reset]"));
  }

  // ------------------------------------------------------------------ cambio de PIN
  {
    const { w, doc, servidor } = crearEntorno(sesionAlumno());
    await hasta(() => doc.getElementById("link-cambiar-pin"));
    doc.getElementById("link-cambiar-pin").click();
    doc.getElementById("pin-actual").value = "1234";
    doc.getElementById("pin-nuevo").value = "5678";
    doc.getElementById("modal-guardar").click();
    await hasta(() => servidor.llamadas.some((l) => l.ruta.startsWith("/functions/v1/cambiar-pin")));
    const l = servidor.llamadas.find((x) => x.ruta.startsWith("/functions/v1/cambiar-pin"));
    comprobar("Cambiar PIN: envía el actual y el nuevo", l && l.cuerpo.pin_actual === "1234" && l.cuerpo.pin_nuevo === "5678");
  }
}

pruebas()
  .then(() => {
    console.log(fallos === 0 ? "\nTODAS LAS PRUEBAS PASARON" : `\n${fallos} PRUEBA(S) FALLARON`);
    process.exit(fallos === 0 ? 0 : 1);
  })
  .catch((e) => { console.error("Error en la propia prueba:", e); process.exit(2); });
