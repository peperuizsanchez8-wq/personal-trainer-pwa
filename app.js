// ---------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------
const SUPABASE_URL = "https://kdnbmckjvkrwuwxyqfgk.supabase.co";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtkbmJtY2tqdmtyd3V3eHlxZmdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0MzMyOTksImV4cCI6MjEwNjAwOTI5OX0.CTPwfVasNNcs01QxsaZDhMFku-MHkwSiOePJp4zUbJk";
const SESION_MAXIMA_HORAS = 48;

const app = document.getElementById("app");

// ---------------------------------------------------------------
// Sesión (localStorage) y renovación automática del token
// ---------------------------------------------------------------
const MARGEN_RENOVACION_S = 300; // se renueva cuando quedan menos de 5 min
let renovacionEnCurso = null;

function leerSesionCruda() {
  try { return JSON.parse(localStorage.getItem("sesion") || "null"); } catch { return null; }
}

function leerSesion() {
  const sesion = leerSesionCruda();
  if (!sesion) return null;
  const horasDesdeLogin = (Date.now() - sesion.autenticado_en) / 3_600_000;
  if (horasDesdeLogin > SESION_MAXIMA_HORAS) {
    localStorage.removeItem("sesion");
    return null;
  }
  return sesion;
}

function guardarSesion(datos) {
  localStorage.setItem("sesion", JSON.stringify({ ...datos, autenticado_en: Date.now() }));
}

function limpiarCacheDatos() {
  Object.keys(localStorage).filter((k) => k.startsWith("cache:")).forEach((k) => localStorage.removeItem(k));
}

function cerrarSesion() {
  localStorage.removeItem("sesion");
  limpiarCacheDatos();
  render();
}

function entrenadorIdGuardado() {
  const params = new URLSearchParams(location.search);
  const desdeUrl = params.get("e");
  if (desdeUrl) localStorage.setItem("entrenador_id", desdeUrl);
  return desdeUrl || localStorage.getItem("entrenador_id") || "";
}

function esErrorDeRed(err) {
  return err instanceof TypeError || (err && err.name === "AbortError");
}

async function renovarTokenSiHaceFalta(forzar = false) {
  const s = leerSesionCruda();
  if (!s || !s.refresh_token) return;
  const ahora = Date.now() / 1000;
  if (!forzar && s.expires_at && s.expires_at - ahora > MARGEN_RENOVACION_S) return;
  if (renovacionEnCurso) return renovacionEnCurso;
  renovacionEnCurso = (async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: s.refresh_token }),
      });
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        // El servidor rechaza el refresh token: hay que volver a entrar con el PIN.
        localStorage.removeItem("sesion");
        limpiarCacheDatos();
        render();
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      const actual = leerSesionCruda() || s;
      localStorage.setItem("sesion", JSON.stringify({
        ...actual,
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      }));
    } catch {
      // Sin red: no se cierra la sesión, se reintentará en cuanto haya conexión.
    } finally {
      renovacionEnCurso = null;
    }
  })();
  return renovacionEnCurso;
}

// ---------------------------------------------------------------
// API
// ---------------------------------------------------------------
async function login(nombre, pin) {
  const entrenador_id = entrenadorIdGuardado() || null;
  const res = await fetch(`${SUPABASE_URL}/functions/v1/login-pin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entrenador_id, nombre, pin }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) return { ok: false, ...data };
  return data;
}

function headersRest(sesion) {
  // Siempre el token más reciente guardado, no el que tenía el objeto al pintar la pantalla.
  const actual = leerSesionCruda();
  const token = (actual && actual.access_token) || sesion.access_token;
  return { apikey: ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// Todas las llamadas autenticadas pasan por aquí: renueva el token si hace falta,
// reintenta una vez si el servidor dice que caducó, y corta si la red se cuelga.
async function fetchSupabase(sesion, url, opciones = {}) {
  const { timeoutMs, headers, ...resto } = opciones;
  await renovarTokenSiHaceFalta();
  if (!leerSesionCruda()) {
    // La sesión se cerró (el servidor rechazó la renovación): se corta lo que estaba en curso.
    throw Object.assign(new Error("sesion_expirada"), { sesionExpirada: true });
  }
  const intentar = () => {
    const controlador = new AbortController();
    const temporizador = setTimeout(() => controlador.abort(), timeoutMs || 12000);
    return fetch(url, {
      ...resto,
      headers: { ...headersRest(sesion), ...(headers || {}) },
      signal: controlador.signal,
    }).finally(() => clearTimeout(temporizador));
  };
  let res = await intentar();
  if (res.status === 401) {
    await renovarTokenSiHaceFalta(true);
    res = await intentar();
  }
  return res;
}

async function fetchSupabaseOk(sesion, url, opciones) {
  const res = await fetchSupabase(sesion, url, opciones);
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res;
}

async function llamarFuncion(sesion, nombre, body) {
  const res = await fetchSupabase(sesion, `${SUPABASE_URL}/functions/v1/${nombre}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "error_desconocido"), { detalle: data.detalle });
  return data;
}

// Caché de lecturas: si no hay red, se sirve lo último que se vio, así la app
// abre y muestra el entreno aunque en el gimnasio no haya cobertura.
function cacheClave(tipo, id, args) {
  return `cache:${tipo}:${id}${args ? ":" + JSON.stringify(args) : ""}`;
}
function cacheGuardar(clave, datos) {
  try { localStorage.setItem(clave, JSON.stringify(datos)); } catch { /* sin espacio: se ignora */ }
}
function cacheLeer(clave) {
  try {
    const raw = localStorage.getItem(clave);
    return raw === null ? undefined : JSON.parse(raw);
  } catch { return undefined; }
}

async function restGet(sesion, path) {
  const clave = cacheClave("get", path);
  try {
    const res = await fetchSupabase(sesion, `${SUPABASE_URL}/rest/v1/${path}`);
    if (!res.ok) throw new Error(`Error de red (${res.status})`);
    const datos = await res.json();
    cacheGuardar(clave, datos);
    return datos;
  } catch (err) {
    const guardado = esErrorDeRed(err) ? cacheLeer(clave) : undefined;
    if (guardado !== undefined) return guardado;
    throw err;
  }
}

async function rpc(sesion, nombre, args) {
  const clave = cacheClave("rpc", nombre, args);
  try {
    const res = await fetchSupabase(sesion, `${SUPABASE_URL}/rest/v1/rpc/${nombre}`, {
      method: "POST",
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`Error de red (${res.status})`);
    const datos = await res.json();
    cacheGuardar(clave, datos);
    return datos;
  } catch (err) {
    const guardado = esErrorDeRed(err) ? cacheLeer(clave) : undefined;
    if (guardado !== undefined) return guardado;
    throw err;
  }
}

// ---------------------------------------------------------------
// Cola de guardado offline: si falla la red, se encola y se reintenta
// automáticamente en cuanto vuelva la conexión.
// ---------------------------------------------------------------
function colaLeer() {
  try { return JSON.parse(localStorage.getItem("cola_pendiente") || "[]"); } catch { return []; }
}
function colaGuardar(cola) {
  localStorage.setItem("cola_pendiente", JSON.stringify(cola));
  actualizarIndicadorCola();
}
function actualizarIndicadorCola() {
  const n = colaLeer().length;
  const el = document.getElementById("indicador-cola");
  if (el) el.textContent = n > 0 ? `${n} serie${n > 1 ? "s" : ""} pendiente${n > 1 ? "s" : ""} de sincronizar` : "";
}

function mismaSerie(a, b) {
  return a.serie_prescrita_id === b.serie_prescrita_id && a.usuario_id === b.usuario_id && a.numero_serie === b.numero_serie;
}

async function enviarSerieRegistrada(sesion, fila) {
  const res = await fetchSupabase(
    sesion,
    `${SUPABASE_URL}/rest/v1/series_registradas?on_conflict=serie_prescrita_id,usuario_id,numero_serie`,
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify([fila]),
    }
  );
  if (!res.ok) throw new Error(`No se pudo guardar (${res.status})`);
  return res.json();
}

let sincronizando = false;
async function sincronizarCola(sesion) {
  if (sincronizando) return;
  sincronizando = true;
  try {
    const enviados = new Set();
    for (const item of colaLeer()) {
      try {
        await enviarSerieRegistrada(sesion, item.fila);
        enviados.add(item.id);
      } catch (err) {
        if (esErrorDeRed(err)) break; // sigue sin haber red: se para y se reintenta luego
      }
    }
    // Se quitan solo los enviados, releyendo la cola: así no se pierde nada
    // de lo que se haya guardado mientras se sincronizaba.
    if (enviados.size) colaGuardar(colaLeer().filter((i) => !enviados.has(i.id)));
  } finally {
    sincronizando = false;
  }
}

async function guardarSerieRegistrada(sesion, fila) {
  try {
    const resultado = await enviarSerieRegistrada(sesion, fila);
    // Si había algo más viejo de esta misma serie esperando en la cola, ya no vale:
    // no debe llegar después y pisar lo que acabamos de guardar.
    const cola = colaLeer();
    const restante = cola.filter((i) => !mismaSerie(i.fila, fila));
    if (restante.length !== cola.length) colaGuardar(restante);
    return resultado;
  } catch (err) {
    if (esErrorDeRed(err)) {
      // Fallo de red real (sin conexión): se guarda en el móvil y se
      // reintenta solo en cuanto vuelva a haber señal, sin perder el dato.
      const cola = colaLeer().filter((i) => !mismaSerie(i.fila, fila));
      cola.push({ id: crypto.randomUUID(), fila });
      colaGuardar(cola);
      return { encolado: true };
    }
    throw err;
  }
}

// ---------------------------------------------------------------
// Utilidades de UI
// ---------------------------------------------------------------
function esc(texto) {
  return String(texto ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function icon(name, extraClass) {
  return `<svg class="icon${extraClass ? " " + extraClass : ""}"><use href="#i-${name}"/></svg>`;
}

function topbar(titulo, sesion) {
  return `
    <div class="topbar">
      <div class="brand">${icon("dumbbell")}<span>${esc(titulo)}</span></div>
      ${sesion ? `<button class="ghost" id="btn-salir">${icon("logout")} Cambiar</button>` : ""}
    </div>`;
}

function medioDeRango(texto) {
  const m = /(\d+)\s*-\s*(\d+)/.exec(texto || "");
  if (m) return Math.round((parseInt(m[1]) + parseInt(m[2])) / 2);
  const solo = /(\d+)/.exec(texto || "");
  return solo ? parseInt(solo[1]) : 10;
}

// ---------------------------------------------------------------
// Ventanas reutilizables: mostrar PIN, alta de alumno, cambio de PIN
// ---------------------------------------------------------------
function abrirModal(html) {
  const fondo = document.createElement("div");
  fondo.className = "modal-fondo";
  fondo.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(fondo);
  return { el: fondo.firstElementChild, cerrar: () => fondo.remove() };
}

function mostrarPinNuevo(titulo, nombre, pin, alCerrar) {
  const { el, cerrar } = abrirModal(`
    <h2>${esc(titulo)}</h2>
    <p class="lead" style="margin:6px 0 0">PIN de ${esc(nombre)}. No se puede volver a ver: cópialo o apúntalo ahora.</p>
    <div class="pin-grande num">${esc(pin)}</div>
    <div class="modal-acciones">
      <button class="secundario" id="modal-copiar">Copiar</button>
      <button class="primary" id="modal-ok">Ya lo he apuntado</button>
    </div>`);
  el.querySelector("#modal-copiar").addEventListener("click", async (e) => {
    try { await navigator.clipboard.writeText(pin); e.target.textContent = "Copiado"; }
    catch { e.target.textContent = "No se pudo copiar"; }
  });
  el.querySelector("#modal-ok").addEventListener("click", () => { cerrar(); if (alCerrar) alCerrar(); });
}

function abrirAltaAlumno(sesion, entrenadorId, alTerminar) {
  const { el, cerrar } = abrirModal(`
    <h2>Nuevo alumno</h2>
    <div class="field" style="margin-top:12px">
      <label for="modal-nombre">Nombre y apellidos</label>
      <input id="modal-nombre" autocomplete="off" />
    </div>
    <p class="form-error hidden" id="modal-error"></p>
    <div class="modal-acciones">
      <button class="secundario" id="modal-cancelar">Cancelar</button>
      <button class="primary" id="modal-crear">Crear</button>
    </div>`);
  const input = el.querySelector("#modal-nombre");
  const errorEl = el.querySelector("#modal-error");
  const boton = el.querySelector("#modal-crear");
  input.focus();
  el.querySelector("#modal-cancelar").addEventListener("click", cerrar);

  const crear = async () => {
    const nombre = input.value.trim();
    errorEl.classList.add("hidden");
    if (!nombre) { errorEl.textContent = "Escribe un nombre."; errorEl.classList.remove("hidden"); return; }
    boton.disabled = true;
    try {
      const cuerpo = { rol: "alumno", nombre };
      if (entrenadorId) cuerpo.entrenador_id = entrenadorId; // solo lo necesita el admin
      const r = await llamarFuncion(sesion, "crear-usuario", cuerpo);
      cerrar();
      mostrarPinNuevo("Alumno creado", r.nombre, r.pin, alTerminar);
    } catch (err) {
      boton.disabled = false;
      const duplicado = /duplicate|unique/i.test(err.detalle || "");
      errorEl.textContent = duplicado
        ? "Ya hay un alumno con ese nombre en este grupo (puede estar desactivado)."
        : "No se pudo crear. Revisa la conexión e inténtalo de nuevo.";
      errorEl.classList.remove("hidden");
    }
  };
  boton.addEventListener("click", crear);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") crear(); });
}

function abrirCambioPin(sesion) {
  const { el, cerrar } = abrirModal(`
    <h2>Cambiar mi PIN</h2>
    <div class="field" style="margin-top:12px">
      <label for="pin-actual">PIN actual</label>
      <input id="pin-actual" class="pin-input" inputmode="numeric" pattern="[0-9]*" maxlength="4" />
    </div>
    <div class="field">
      <label for="pin-nuevo">PIN nuevo (4 dígitos)</label>
      <input id="pin-nuevo" class="pin-input" inputmode="numeric" pattern="[0-9]*" maxlength="4" />
    </div>
    <p class="form-error hidden" id="modal-error"></p>
    <div class="modal-acciones">
      <button class="secundario" id="modal-cancelar">Cancelar</button>
      <button class="primary" id="modal-guardar">Guardar</button>
    </div>`);
  const errorEl = el.querySelector("#modal-error");
  const boton = el.querySelector("#modal-guardar");
  el.querySelector("#modal-cancelar").addEventListener("click", cerrar);

  boton.addEventListener("click", async () => {
    const actual = el.querySelector("#pin-actual").value.trim();
    const nuevo = el.querySelector("#pin-nuevo").value.trim();
    const mostrarError = (t) => { errorEl.textContent = t; errorEl.classList.remove("hidden"); };
    errorEl.classList.add("hidden");
    if (!/^\d{4}$/.test(actual) || !/^\d{4}$/.test(nuevo)) return mostrarError("Los dos PIN deben tener 4 dígitos.");
    boton.disabled = true;
    try {
      await llamarFuncion(sesion, "cambiar-pin", { pin_actual: actual, pin_nuevo: nuevo });
      cerrar();
      alert("PIN cambiado. Úsalo la próxima vez que entres.");
    } catch (err) {
      boton.disabled = false;
      const mensajes = {
        pin_incorrecto: "El PIN actual no es correcto.",
        bloqueado: "Demasiados intentos. Espera unos minutos.",
        pin_igual: "El PIN nuevo tiene que ser distinto del actual.",
        pin_invalido: "El PIN nuevo debe tener 4 dígitos.",
      };
      mostrarError(mensajes[err.message] || "No se pudo cambiar el PIN. Inténtalo de nuevo.");
    }
  });
}

// ---------------------------------------------------------------
// Pantalla: login
// ---------------------------------------------------------------
function renderLogin(error) {
  app.innerHTML = `
    <div class="screen-center">
      <h1>${icon("user")} Entrenamiento</h1>
      <p class="lead">Introduce tu nombre y tu PIN para registrar tu sesión de hoy.</p>
      ${error ? `<div class="form-error">${error}</div>` : ""}
      <form id="form-login">
        <div class="field">
          <label for="nombre">Nombre</label>
          <input id="nombre" name="nombre" autocomplete="name" required />
        </div>
        <div class="field">
          <label for="pin">PIN</label>
          <input id="pin" name="pin" class="pin-input" inputmode="numeric" pattern="[0-9]*" maxlength="4" required />
        </div>
        <button type="submit" class="primary" id="btn-entrar">Entrar</button>
      </form>
      <p class="form-note">Si es tu primera vez, pídele el enlace y tu PIN a tu entrenador.</p>
    </div>`;

  document.getElementById("form-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const boton = document.getElementById("btn-entrar");
    boton.disabled = true;
    boton.innerHTML = `<span class="spinner"></span>`;
    const nombre = document.getElementById("nombre").value.trim();
    const pin = document.getElementById("pin").value.trim();
    try {
      const resultado = await login(nombre, pin);
      if (!resultado.ok) {
        const mensajes = {
          no_existe: "No encontramos ese nombre. Revisa cómo lo escribiste.",
          pin_incorrecto: `PIN incorrecto${resultado.intentos_restantes ? ` (${resultado.intentos_restantes} intentos restantes)` : ""}.`,
          bloqueado: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.",
          desactivado: "Tu cuenta está desactivada. Habla con tu entrenador.",
        };
        renderLogin(mensajes[resultado.motivo] || "No se pudo iniciar sesión.");
        return;
      }
      guardarSesion(resultado);
      render();
    } catch {
      renderLogin("No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.");
    }
  });
}

// ---------------------------------------------------------------
// Panel del entrenador: lista de alumnos + progreso de cada uno
// ---------------------------------------------------------------
async function calcularDiasConEstado(sesion, usuarioId, programaId) {
  const semanas = await restGet(sesion, `semanas?programa_id=eq.${programaId}&select=id,numero&order=numero`);
  if (semanas.length === 0) return { semanas: [], dias: [] };
  const diasPlanos = await restGet(
    sesion,
    `dias?semana_id=in.(${semanas.map((s) => s.id).join(",")})&select=id,numero,semana_id&order=numero`
  );
  const progreso = await rpc(sesion, "progreso_programa", { p_usuario_id: usuarioId, p_programa_id: programaId });

  const dias = [];
  for (const semana of semanas) {
    for (const dia of diasPlanos.filter((d) => d.semana_id === semana.id)) {
      const fila = progreso.find((p) => p.semana_numero === semana.numero && p.dia_numero === dia.numero);
      dias.push({
        semanaId: semana.id, semanaNumero: semana.numero,
        diaId: dia.id, diaNumero: dia.numero,
        estado: estadoDia(fila),
        total: fila ? Number(fila.total_series) : 0,
        completadas: fila ? Number(fila.series_completadas) : 0,
      });
    }
  }
  return { semanas, dias };
}

function porcentaje(dias) {
  const total = dias.reduce((acc, d) => acc + d.total, 0);
  const completadas = dias.reduce((acc, d) => acc + d.completadas, 0);
  return total > 0 ? Math.round((completadas / total) * 100) : 0;
}

function semanaEsperadaActual(creadaEn, totalSemanas) {
  const diasTranscurridos = (Date.now() - new Date(creadaEn).getTime()) / 86_400_000;
  const semanas = Math.floor(diasTranscurridos / 7) + 1;
  return Math.min(semanas, totalSemanas);
}

function formatearDesde(fechaIso) {
  if (!fechaIso) return "sin actividad";
  const dias = Math.floor((Date.now() - new Date(fechaIso).getTime()) / 86_400_000);
  if (dias <= 0) return "hoy";
  if (dias === 1) return "ayer";
  return `hace ${dias} días`;
}

async function renderPanelEntrenador(sesion) {
  app.innerHTML = `${topbar("Panel de " + sesion.nombre, sesion)}<main><p class="lead">Cargando tus alumnos…</p></main>`;

  let todos;
  try {
    todos = await restGet(sesion, `usuarios?entrenador_id=eq.${sesion.entrenador_id}&rol=eq.alumno&select=id,nombre,activo&order=nombre`);
  } catch {
    if (!leerSesionCruda()) return;
    app.innerHTML = `${topbar("Panel de " + sesion.nombre, sesion)}<main><p class="form-error" style="margin-top:16px">No se pudo cargar el panel. Revisa la conexión e inténtalo de nuevo.</p></main>`;
    document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
    return;
  }
  const alumnos = todos.filter((a) => a.activo);
  const desactivados = todos.filter((a) => !a.activo);

  const filas = [];
  for (const alumno of alumnos) {
    const ultimaActividad = await rpc(sesion, "ultima_actividad", { p_usuario_id: alumno.id }).catch(() => null);
    const asignaciones = await restGet(
      sesion,
      `asignaciones?usuario_id=eq.${alumno.id}&activa=eq.true&select=id,programa_id,created_at,nota_entrenador,programas(nombre,estado)&order=created_at.desc&limit=1`
    );
    const asignacion = asignaciones.find((a) => a.programas && a.programas.estado === "publicado");
    if (!asignacion) {
      filas.push({ alumno, programaNombre: null, pct: 0, dias: [], ultimaActividad });
      continue;
    }
    const { semanas, dias } = await calcularDiasConEstado(sesion, alumno.id, asignacion.programa_id);
    const semanaEsperada = semanaEsperadaActual(asignacion.created_at, semanas.length);
    const atrasado = dias.some((d) => d.semanaNumero < semanaEsperada && d.estado !== "completo");
    filas.push({
      alumno, programaNombre: asignacion.programas.nombre, programaId: asignacion.programa_id,
      asignacionId: asignacion.id, notaEntrenador: asignacion.nota_entrenador,
      pct: porcentaje(dias), dias, semanaEsperada, atrasado, ultimaActividad,
    });
  }

  app.innerHTML = `
    ${topbar("Panel de " + sesion.nombre, sesion)}
    <main>
      <div style="margin-top:16px"><button class="primary" id="btn-importar">Subir nuevo plan (Excel)</button></div>
      <div style="display:flex;gap:16px;margin-top:10px;flex-wrap:wrap">
        <button class="skip-btn" id="btn-alta-alumno">+ Añadir alumno</button>
        <button class="skip-btn" id="btn-historial">Ver planes anteriores</button>
      </div>
      <p class="pill-label" style="margin-top:20px">Tus alumnos</p>
      ${filas.map((f, i) => `
        <div class="week-row" data-alumno="${i}" style="cursor:pointer">
          <div class="week-row-top">
            <span>${esc(f.alumno.nombre)}${f.atrasado ? ' <span style="color:var(--danger);font-size:12px;font-weight:600">· atrasado</span>' : ""}</span>
            <span class="week-status">${f.programaNombre ? f.pct + "%" : "Sin programa"}</span>
          </div>
          ${f.programaNombre ? `<div class="week-bar-track"><div class="week-bar-fill ${f.pct === 100 ? "completo" : "en_progreso"}" style="width:${f.pct}%"></div></div>` : ""}
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:6px">
            <p class="form-note" style="text-align:left;margin:0">Última actividad: ${formatearDesde(f.ultimaActividad)}</p>
            <span style="display:flex;gap:12px">
              <button class="skip-btn" data-reset="${f.alumno.id}" data-nombre="${esc(f.alumno.nombre)}">Resetear PIN</button>
              <button class="skip-btn" data-desactivar="${f.alumno.id}" data-nombre="${esc(f.alumno.nombre)}">Desactivar</button>
            </span>
          </div>
        </div>`).join("") || `<p class="lead">Todavía no tienes alumnos. Añade el primero con "+ Añadir alumno".</p>`}

      ${desactivados.length ? `
        <p class="pill-label" style="margin-top:24px">Desactivados</p>
        ${desactivados.map((a) => `
          <div class="week-row">
            <div class="week-row-top">
              <span style="color:var(--steel)">${esc(a.nombre)}</span>
              <button class="skip-btn" data-reactivar="${a.id}" data-nombre="${esc(a.nombre)}">Reactivar</button>
            </div>
          </div>`).join("")}` : ""}

      <p class="form-note"><a href="#" id="link-cambiar-pin" style="color:inherit">Cambiar mi PIN</a></p>
    </main>`;

  const refrescar = () => renderPanelEntrenador(sesion);
  document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
  document.getElementById("btn-importar").addEventListener("click", () => renderImportarExcel(sesion));
  document.getElementById("btn-historial").addEventListener("click", () => renderHistorialPlanes(sesion));
  document.getElementById("btn-alta-alumno").addEventListener("click", () => abrirAltaAlumno(sesion, null, refrescar));
  document.getElementById("link-cambiar-pin").addEventListener("click", (e) => { e.preventDefault(); abrirCambioPin(sesion); });
  document.querySelectorAll("[data-reset]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      resetearPinConfirmando(sesion, { id: btn.dataset.reset, nombre: btn.dataset.nombre }, refrescar);
    });
  });
  document.querySelectorAll("[data-desactivar]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      cambiarActivo(sesion, { id: btn.dataset.desactivar, nombre: btn.dataset.nombre }, false, refrescar);
    });
  });
  document.querySelectorAll("[data-reactivar]").forEach((btn) => {
    btn.addEventListener("click", () => cambiarActivo(sesion, { id: btn.dataset.reactivar, nombre: btn.dataset.nombre }, true, refrescar));
  });
  document.querySelectorAll("[data-alumno]").forEach((row) => {
    row.addEventListener("click", () => {
      const f = filas[parseInt(row.dataset.alumno)];
      if (f.programaNombre) renderDetalleAlumno(sesion, f);
    });
  });
}

function renderDetalleAlumno(sesion, f) {
  const semanasAgrupadas = f.dias.reduce((acc, d) => {
    let semana = acc.find((s) => s.numero === d.semanaNumero);
    if (!semana) { semana = { numero: d.semanaNumero, dias: [] }; acc.push(semana); }
    semana.dias.push(d);
    return acc;
  }, []);

  const filasSemana = semanasAgrupadas.map((semana) => {
    const completos = semana.dias.filter((d) => d.estado === "completo").length;
    const total = semana.dias.reduce((a, d) => a + d.total, 0);
    const completadas = semana.dias.reduce((a, d) => a + d.completadas, 0);
    const pct = total > 0 ? Math.round((completadas / total) * 100) : 0;
    const atrasada = f.semanaEsperada && semana.numero < f.semanaEsperada && completos < semana.dias.length;
    let etiqueta = "Sin empezar";
    if (completos === semana.dias.length) etiqueta = "Completada";
    else if (semana.dias.some((d) => d.estado !== "pendiente")) etiqueta = `En progreso · ${completos}/${semana.dias.length} días`;
    if (atrasada) etiqueta += " · atrasada";
    return `
      <div class="week-row">
        <div class="week-row-top"><span>Semana ${semana.numero}</span><span class="week-status${atrasada ? " danger" : ""}">${etiqueta}</span></div>
        <div class="week-bar-track"><div class="week-bar-fill ${atrasada ? "danger" : completos === semana.dias.length ? "completo" : "en_progreso"}" style="width:${pct}%"></div></div>
        <div class="pill-row" style="padding-top:10px">
          ${semana.dias.map((d) => `<button class="pill" data-dia-idx="${f.dias.indexOf(d)}">Día ${d.diaNumero}</button>`).join("")}
        </div>
      </div>`;
  }).join("");

  app.innerHTML = `
    ${topbar(f.alumno.nombre, sesion)}
    <main>
      <p class="form-note" style="text-align:left;margin:16px 0 0"><a href="#" id="link-volver" style="color:inherit">‹ Alumnos</a></p>
      <div style="display:flex;justify-content:center;margin-top:12px">${anilloProgreso(f.pct, f.programaNombre)}</div>

      <p class="pill-label" style="margin-top:20px">Nota para ${esc(f.alumno.nombre)}</p>
      <textarea id="nota-entrenador" placeholder="Ej. baja el peso en sentadilla, muy buen progreso en press banca…" style="width:100%;min-height:70px;border:1px solid var(--line);background:var(--surface);border-radius:var(--radius);padding:10px 12px;font-family:inherit;font-size:14px">${esc(f.notaEntrenador)}</textarea>
      <button class="skip-btn" id="btn-guardar-nota" style="margin-top:6px">Guardar nota</button>

      <p class="pill-label" style="margin-top:20px">Progresión de peso</p>
      <select id="select-ejercicio-progresion" style="width:100%;border:1px solid var(--line);background:var(--surface);border-radius:var(--radius);padding:10px 12px;margin-bottom:10px">
        <option value="">Elige un ejercicio…</option>
      </select>
      <div id="grafico-progresion"></div>

      <p class="pill-label" style="margin-top:20px">Progreso por semana — toca un día para ver el detalle</p>
      ${filasSemana}
    </main>`;
  document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
  document.querySelectorAll("[data-dia-idx]").forEach((btn) => {
    btn.addEventListener("click", () => renderDetalleDia(sesion, f, f.dias[parseInt(btn.dataset.diaIdx)]));
  });
  document.getElementById("link-volver").addEventListener("click", (e) => { e.preventDefault(); renderPanelEntrenador(sesion); });
  document.getElementById("btn-guardar-nota").addEventListener("click", async (e) => {
    const btn = e.target;
    const texto = document.getElementById("nota-entrenador").value.trim();
    btn.disabled = true;
    btn.textContent = "Guardando…";
    try {
      await fetchSupabaseOk(sesion, `${SUPABASE_URL}/rest/v1/asignaciones?id=eq.${f.asignacionId}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ nota_entrenador: texto || null }),
      });
      btn.textContent = "Guardado";
      setTimeout(() => { btn.textContent = "Guardar nota"; btn.disabled = false; }, 1500);
    } catch {
      btn.textContent = "No se pudo guardar, reintentar";
      btn.disabled = false;
    }
  });

  // Rellena el desplegable con los ejercicios reales del programa asignado
  restGet(sesion, `series_prescritas?dia_id=in.(${f.dias.map((d) => d.diaId).join(",")})&select=ejercicios_catalogo(id,nombre)`)
    .then((filasPrescritas) => {
      const vistos = new Map();
      for (const fp of filasPrescritas) vistos.set(fp.ejercicios_catalogo.id, fp.ejercicios_catalogo.nombre);
      const ejercicios = [...vistos.entries()].map(([id, nombre]) => ({ id, nombre })).sort((a, b) => a.nombre.localeCompare(b.nombre));
      const select = document.getElementById("select-ejercicio-progresion");
      select.innerHTML = `<option value="">Elige un ejercicio…</option>` +
        ejercicios.map((ej) => `<option value="${ej.id}">${esc(ej.nombre)}</option>`).join("");
      select.addEventListener("change", async () => {
        const graf = document.getElementById("grafico-progresion");
        if (!select.value) { graf.innerHTML = ""; return; }
        graf.innerHTML = `<p class="lead">Cargando…</p>`;
        const puntos = await rpc(sesion, "progresion_ejercicio", {
          p_usuario_id: f.alumno.id, p_programa_id: f.programaId, p_ejercicio_id: select.value,
        });
        dibujarGraficoProgresion("grafico-progresion", puntos);
      });
    });
}

function dibujarGraficoProgresion(contenedor, puntos) {
  const el = typeof contenedor === "string" ? document.getElementById(contenedor) : contenedor;
  const conPeso = puntos.filter((p) => p.peso_max != null);
  if (conPeso.length === 0) {
    el.innerHTML = `<p class="lead">Todavía no hay series registradas de este ejercicio.</p>`;
    return;
  }
  const w = 320, h = 140, pad = 22;
  const pesos = conPeso.map((p) => p.peso_max);
  const min = Math.min(...pesos), max = Math.max(...pesos);
  const rango = max - min || 1;
  const stepX = puntos.length > 1 ? (w - pad * 2) / (puntos.length - 1) : 0;
  const coords = puntos.map((p, i) => ({
    x: pad + i * stepX,
    y: p.peso_max == null ? null : h - pad - ((p.peso_max - min) / rango) * (h - pad * 2),
    p,
  }));
  const conValor = coords.filter((c) => c.y != null);
  const primero = conPeso[0], ultimo = conPeso[conPeso.length - 1];
  const delta = Math.round((ultimo.peso_max - primero.peso_max) * 10) / 10;
  const resumenEvolucion = conPeso.length > 1
    ? `${delta > 0 ? "+" : ""}${delta} kg desde la semana ${primero.semana_numero} (máx. ${max} kg)`
    : `Máximo registrado: ${max} kg`;
  const linea = conValor.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");

  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;margin-top:8px">
      ${linea ? `<path d="${linea}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>` : ""}
      ${conValor.map((c) => `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3.5" fill="var(--accent)" />`).join("")}
      ${coords.map((c) => `<text x="${c.x.toFixed(1)}" y="${h - 4}" font-size="9" fill="var(--steel)" text-anchor="middle">S${c.p.semana_numero}</text>`).join("")}
    </svg>
    <p class="form-note" style="text-align:center">${resumenEvolucion}</p>`;
}
// Detalle de un día concreto de un alumno, en solo lectura
// ---------------------------------------------------------------
function renderEjercicioSoloLectura(prescrita, registradas) {
  const esSegundos = prescrita.ejercicios_catalogo.tipo_metrica === "segundos";
  const unidad = esSegundos ? "s" : "reps";
  const filas = Array.from({ length: prescrita.series }, (_, i) => {
    const n = i + 1;
    const r = registradas.find((x) => x.serie_prescrita_id === prescrita.id && x.numero_serie === n);
    const peso = r && r.peso_real != null ? r.peso_real : "–";
    const valor = r && r.valor_real != null ? r.valor_real : "–";
    const done = !!(r && r.completada);
    return `
      <div class="set-row">
        <div class="set-index">${n}</div>
        <div class="stepper${done ? " done" : ""}"><div class="value num" style="width:100%;text-align:center">${peso} kg</div></div>
        <div class="stepper${done ? " done" : ""}"><div class="value num" style="width:100%;text-align:center">${valor} ${unidad}</div></div>
        <div class="check-btn${done ? " done" : ""}">${icon("check")}</div>
      </div>`;
  }).join("");
  const comentarios = registradas
    .filter((r) => r.serie_prescrita_id === prescrita.id && r.comentario)
    .map((r) => r.comentario);
  const rirReal = registradas.find((r) => r.serie_prescrita_id === prescrita.id && r.rir_real != null)?.rir_real;

  return `
    <div class="exercise">
      <div class="exercise-head">
        <h2>${esc(prescrita.ejercicios_catalogo.nombre)}</h2>
        <div class="meta">${prescrita.series} series · ${esc(prescrita.reps_objetivo)} ${unidad === "s" ? "" : "reps"} · RIR objetivo ${prescrita.rir ?? "–"}${rirReal != null ? ` · RIR real ${rirReal}` : ""}</div>
      </div>
      ${filas}
      ${comentarios.length ? `<p class="form-note" style="text-align:left;margin-top:10px">Nota: ${esc(comentarios.join(" · "))}</p>` : ""}
      ${registradas.some((r) => r.serie_prescrita_id === prescrita.id && r.sin_tiempo && !r.completada) ? `<p class="form-note" style="text-align:left;margin-top:6px;color:var(--danger)">El alumno lo marcó como "sin tiempo".</p>` : ""}
    </div>`;
}

async function renderDetalleDia(sesion, f, dia) {
  app.innerHTML = `${topbar(f.alumno.nombre, sesion)}<main><p class="lead">Cargando…</p></main>`;

  const prescritas = await restGet(
    sesion,
    `series_prescritas?dia_id=eq.${dia.diaId}&select=id,orden,series,reps_objetivo,rir,descanso,ejercicios_catalogo(id,nombre,tipo_metrica)&order=orden`
  );
  const ids = prescritas.map((p) => p.id);
  const registradas = ids.length
    ? await restGet(sesion, `series_registradas?serie_prescrita_id=in.(${ids.join(",")})&usuario_id=eq.${f.alumno.id}&select=serie_prescrita_id,numero_serie,peso_real,valor_real,completada,comentario,rir_real,sin_tiempo`)
    : [];

  app.innerHTML = `
    ${topbar(f.alumno.nombre, sesion)}
    <main>
      <p class="form-note" style="text-align:left;margin:16px 0 0"><a href="#" id="link-volver-detalle" style="color:inherit">‹ Semana ${dia.semanaNumero}</a></p>
      <p class="pill-label" style="margin-top:12px">Semana ${dia.semanaNumero} · Día ${dia.diaNumero}</p>
      ${prescritas.map((p) => renderEjercicioSoloLectura(p, registradas)).join("")}
    </main>`;

  document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
  document.getElementById("link-volver-detalle").addEventListener("click", (e) => {
    e.preventDefault();
    renderDetalleAlumno(sesion, f);
  });
}

// ---------------------------------------------------------------
// Pantalla: solo alumnos por ahora
// ---------------------------------------------------------------
// ---------------------------------------------------------------
// Botón reutilizable de resetear PIN (admin y entrenador)
// ---------------------------------------------------------------
async function resetearPinConfirmando(sesion, usuario, alRefrescar) {
  if (!confirm(`¿Generar un PIN nuevo para ${usuario.nombre}? El PIN actual dejará de funcionar.`)) return;
  try {
    const resultado = await llamarFuncion(sesion, "resetear-pin", { usuario_id: usuario.id });
    mostrarPinNuevo("PIN nuevo", usuario.nombre, resultado.pin, alRefrescar);
  } catch {
    alert("No se pudo generar el PIN nuevo. Inténtalo de nuevo.");
  }
}

async function cambiarActivo(sesion, usuario, activo, alRefrescar) {
  const pregunta = activo
    ? `¿Reactivar a ${usuario.nombre}?`
    : `¿Desactivar a ${usuario.nombre}? No podrá entrar hasta que lo reactives. Sus datos se conservan.`;
  if (!confirm(pregunta)) return;
  try {
    await fetchSupabaseOk(sesion, `${SUPABASE_URL}/rest/v1/usuarios?id=eq.${usuario.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ activo }),
    });
    if (alRefrescar) alRefrescar();
  } catch {
    alert("No se pudo cambiar el estado. Inténtalo de nuevo.");
  }
}

// ---------------------------------------------------------------
// Panel del admin: entrenadores + alta de entrenadores nuevos
// ---------------------------------------------------------------
async function renderPanelAdmin(sesion) {
  app.innerHTML = `${topbar("Panel de administración", sesion)}<main><p class="lead">Cargando…</p></main>`;

  let entrenadores, personas, alumnos;
  try {
    entrenadores = await restGet(sesion, `entrenadores?select=id,nombre&order=nombre`);
    personas = await restGet(sesion, `usuarios?rol=eq.entrenador&select=id,nombre,entrenador_id,activo`);
    alumnos = await restGet(sesion, `usuarios?rol=eq.alumno&select=id,nombre,entrenador_id,activo&order=nombre`);
  } catch {
    if (!leerSesionCruda()) return;
    app.innerHTML = `${topbar("Panel de administración", sesion)}<main><p class="form-error" style="margin-top:16px">No se pudo cargar el panel. Revisa la conexión e inténtalo de nuevo.</p></main>`;
    document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
    return;
  }

  const botonesUsuario = (u) => `
    <span style="display:flex;gap:12px">
      <button class="skip-btn" data-reset="${u.id}" data-nombre="${esc(u.nombre)}">Resetear PIN</button>
      <button class="skip-btn" data-activo="${u.activo ? "0" : "1"}" data-id="${u.id}" data-nombre="${esc(u.nombre)}">${u.activo ? "Desactivar" : "Reactivar"}</button>
    </span>`;

  const filasEntrenador = entrenadores.map((e) => {
    const persona = personas.find((u) => u.entrenador_id === e.id);
    const alumnosDelGrupo = alumnos.filter((a) => a.entrenador_id === e.id);
    return `
      <div class="week-row">
        <div class="week-row-top">
          <span>${esc(e.nombre)}${persona && !persona.activo ? ' <span style="color:var(--danger);font-size:12px;font-weight:600">· desactivado</span>' : ""}</span>
          ${persona ? botonesUsuario(persona) : ""}
        </div>
        ${alumnosDelGrupo.map((a) => `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px;padding-left:12px">
            <span style="font-size:14px;color:${a.activo ? "var(--steel)" : "var(--danger)"}">${esc(a.nombre)}${a.activo ? "" : " · desactivado"}</span>
            ${botonesUsuario(a)}
          </div>`).join("")}
        <button class="skip-btn" data-alta="${e.id}" style="margin:12px 0 0 12px">+ Añadir alumno</button>
      </div>`;
  }).join("") || `<p class="lead">Todavía no hay entrenadores creados.</p>`;

  app.innerHTML = `
    ${topbar("Panel de administración", sesion)}
    <main>
      <p class="pill-label" style="margin-top:16px">Entrenadores y sus alumnos</p>
      ${filasEntrenador}

      <p class="pill-label" style="margin-top:24px">Crear entrenador nuevo</p>
      <form id="form-nuevo-entrenador">
        <div class="field">
          <label for="nombre-entrenador">Nombre del entrenador</label>
          <input id="nombre-entrenador" required />
        </div>
        <div class="field">
          <label for="nombre-grupo">Nombre del grupo/gimnasio</label>
          <input id="nombre-grupo" required />
        </div>
        <button type="submit" class="primary">Crear</button>
      </form>

      <p class="form-note"><a href="#" id="link-cambiar-pin" style="color:inherit">Cambiar mi PIN</a></p>
    </main>`;

  const refrescar = () => renderPanelAdmin(sesion);
  document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
  document.getElementById("link-cambiar-pin").addEventListener("click", (e) => { e.preventDefault(); abrirCambioPin(sesion); });
  document.querySelectorAll("[data-reset]").forEach((btn) => {
    btn.addEventListener("click", () => resetearPinConfirmando(sesion, { id: btn.dataset.reset, nombre: btn.dataset.nombre }, refrescar));
  });
  document.querySelectorAll("[data-activo]").forEach((btn) => {
    btn.addEventListener("click", () =>
      cambiarActivo(sesion, { id: btn.dataset.id, nombre: btn.dataset.nombre }, btn.dataset.activo === "1", refrescar)
    );
  });
  document.querySelectorAll("[data-alta]").forEach((btn) => {
    btn.addEventListener("click", () => abrirAltaAlumno(sesion, btn.dataset.alta, refrescar));
  });
  document.getElementById("form-nuevo-entrenador").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nombre = document.getElementById("nombre-entrenador").value.trim();
    const nombreGrupo = document.getElementById("nombre-grupo").value.trim();
    try {
      const resultado = await llamarFuncion(sesion, "crear-usuario", { rol: "entrenador", nombre, nombre_entrenador: nombreGrupo });
      mostrarPinNuevo("Entrenador creado", nombre, resultado.pin, refrescar);
    } catch {
      alert("No se pudo crear el entrenador. Inténtalo de nuevo.");
    }
  });
}

// ---------------------------------------------------------------
// Importador de Excel: subir → categorizar ejercicios nuevos → publicar → asignar
// ---------------------------------------------------------------
function parsearWorkbookExcel(workbook) {
  const semanas = [];
  for (const nombreHoja of workbook.SheetNames) {
    const m = /^Semana\s*(\d+)/i.exec(nombreHoja.trim());
    if (!m) continue;
    const numeroSemana = parseInt(m[1]);
    const filas = XLSX.utils.sheet_to_json(workbook.Sheets[nombreHoja], { header: 1, defval: null, raw: true });
    const semana = { numero: numeroSemana, dias: [] };
    let diaActual = null;
    let orden = 0;
    for (const fila of filas) {
      const col0 = fila[0];
      if (col0 === null || col0 === undefined || col0 === "") continue;
      if (typeof col0 === "string" && col0.trim().toUpperCase().startsWith("DÍA")) {
        const numDia = /\d+/.exec(col0);
        diaActual = { numero: numDia ? parseInt(numDia[0]) : semana.dias.length + 1, ejercicios: [] };
        semana.dias.push(diaActual);
        orden = 0;
        continue;
      }
      if (col0 === "Ejercicio") continue;
      if (diaActual && typeof fila[1] === "number") {
        orden++;
        diaActual.ejercicios.push({
          orden,
          nombre_ejercicio: String(col0).trim(),
          series: fila[1],
          reps_objetivo: fila[2] != null ? String(fila[2]) : null,
          rir: fila[3] != null ? Number(fila[3]) : null,
          descanso: fila[4] != null ? String(fila[4]) : null,
        });
      }
    }
    semanas.push(semana);
  }
  return { semanas };
}

async function renderImportarExcel(sesion) {
  app.innerHTML = `
    ${topbar("Subir plan nuevo", sesion)}
    <main>
      <p class="form-note" style="text-align:left;margin:16px 0 0"><a href="#" id="link-volver-importar" style="color:inherit">‹ Panel</a></p>
      <p class="lead" style="margin-top:16px">Selecciona el archivo Excel del plan (mismo formato de siempre: hojas "Semana N", con "DÍA X" y la tabla de ejercicios).</p>
      <input type="file" id="input-excel" accept=".xlsx,.xls" />
      <div id="resultado-importacion" style="margin-top:20px"></div>
    </main>`;

  document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
  document.getElementById("link-volver-importar").addEventListener("click", (e) => { e.preventDefault(); renderPanelEntrenador(sesion); });

  document.getElementById("input-excel").addEventListener("change", async (e) => {
    const archivo = e.target.files[0];
    if (!archivo) return;
    const resultadoEl = document.getElementById("resultado-importacion");
    resultadoEl.innerHTML = `<p class="lead">Leyendo archivo…</p>`;

    let programa;
    try {
      const buffer = await archivo.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      programa = parsearWorkbookExcel(workbook);
    } catch {
      resultadoEl.innerHTML = `<p class="form-error">No se pudo leer el archivo. Comprueba que sea un .xlsx válido.</p>`;
      return;
    }

    if (programa.semanas.length === 0) {
      resultadoEl.innerHTML = `<p class="form-error">No se han encontrado hojas "Semana N" en el archivo.</p>`;
      return;
    }

    const catalogo = await restGet(sesion, `ejercicios_catalogo?select=nombre`);
    const nombresConocidos = new Set(catalogo.map((c) => c.nombre.toLowerCase()));
    const noReconocidos = new Set();
    let totalDias = 0, totalEjercicios = 0, totalSeries = 0;
    for (const semana of programa.semanas) {
      totalDias += semana.dias.length;
      for (const dia of semana.dias) {
        for (const ej of dia.ejercicios) {
          totalEjercicios++;
          totalSeries += ej.series;
          if (!nombresConocidos.has(ej.nombre_ejercicio.toLowerCase())) noReconocidos.add(ej.nombre_ejercicio);
        }
      }
    }

    const listaNoReconocidos = [...noReconocidos];

    resultadoEl.innerHTML = `
      <div class="week-row">
        <div class="week-row-top"><span>Resumen</span></div>
        <p style="margin:8px 0 0;font-size:14px;color:var(--steel)">
          ${programa.semanas.length} semanas · ${totalDias} días · ${totalEjercicios} filas de ejercicio · ${totalSeries} series totales
        </p>
      </div>

      ${listaNoReconocidos.length ? `
        <p class="pill-label" style="margin-top:20px">Ejercicios nuevos — indica su grupo muscular y tipo</p>
        <p class="form-note" style="text-align:left">Se guardarán en tu catálogo para la próxima vez.</p>
        ${listaNoReconocidos.map((nombre, i) => `
          <div class="week-row">
            <div class="week-row-top"><span>${esc(nombre)}</span></div>
            <div class="field" style="margin-top:10px"><input id="grupo-${i}" placeholder="Grupo muscular (ej. Pecho, Espalda…)" required /></div>
            <div class="field">
              <select id="tipo-${i}" style="width:100%;border:1px solid var(--line);background:var(--surface);border-radius:var(--radius);padding:12px 14px">
                <option value="reps">Repeticiones</option>
                <option value="segundos">Segundos</option>
              </select>
            </div>
          </div>`).join("")}
      ` : ""}

      <div class="field" style="margin-top:20px">
        <label for="nombre-programa">Nombre del programa</label>
        <input id="nombre-programa" value="${esc(archivo.name.replace(/\.[^.]+$/, ""))}" />
      </div>
      <button class="primary" id="btn-publicar">Publicar plan</button>
      <p class="form-note">Antes de que lo vean tus alumnos, tendrás que asignárselo en el paso siguiente.</p>`;

    document.getElementById("btn-publicar").addEventListener("click", async () => {
      const btn = document.getElementById("btn-publicar");
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner"></span>`;
      try {
        // 1. Da de alta los ejercicios nuevos en el catálogo propio del entrenador
        for (let i = 0; i < listaNoReconocidos.length; i++) {
          const grupo = document.getElementById(`grupo-${i}`).value.trim();
          const tipo = document.getElementById(`tipo-${i}`).value;
          if (!grupo) throw new Error("falta_grupo_muscular");
          const res = await fetchSupabase(sesion, `${SUPABASE_URL}/rest/v1/ejercicios_catalogo`, {
            method: "POST",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({
              entrenador_id: sesion.entrenador_id,
              nombre: listaNoReconocidos[i],
              grupo_muscular: grupo,
              tipo_metrica: tipo,
            }),
          });
          if (!res.ok) throw new Error("error_catalogo");
        }

        // 2. Crea el programa en borrador
        const nombrePrograma = document.getElementById("nombre-programa").value.trim() || "Programa sin nombre";
        const resPrograma = await fetchSupabase(sesion, `${SUPABASE_URL}/rest/v1/programas`, {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ entrenador_id: sesion.entrenador_id, nombre: nombrePrograma, estado: "borrador" }),
        });
        if (!resPrograma.ok) throw new Error("error_programa");
        const [programaCreado] = await resPrograma.json();

        // 3. Guarda el borrador de importación
        const resBorrador = await fetchSupabase(sesion, `${SUPABASE_URL}/rest/v1/importaciones_borrador`, {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ programa_id: programaCreado.id, estado_revision: "pendiente", datos: programa }),
        });
        if (!resBorrador.ok) throw new Error("error_borrador");
        const [borradorCreado] = await resBorrador.json();

        // 4. Publica (materializa semanas/días/series_prescritas)
        const resPublicar = await fetchSupabase(sesion, `${SUPABASE_URL}/rest/v1/rpc/publicar_programa`, {
          method: "POST",
          body: JSON.stringify({ p_borrador_id: borradorCreado.id }),
        });
        if (!resPublicar.ok) throw new Error("error_publicar");

        renderAsignarPrograma(sesion, programaCreado.id, nombrePrograma);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Publicar plan";
        if (err.message === "falta_grupo_muscular") {
          alert("Falta indicar el grupo muscular de algún ejercicio nuevo.");
        } else {
          alert("No se pudo publicar el plan. Revisa los datos e inténtalo de nuevo.");
        }
      }
    });
  });
}

async function renderHistorialPlanes(sesion) {
  app.innerHTML = `${topbar("Planes anteriores", sesion)}<main><p class="lead">Cargando…</p></main>`;
  const programas = await restGet(
    sesion,
    `programas?entrenador_id=eq.${sesion.entrenador_id}&estado=eq.publicado&select=id,nombre,created_at&order=created_at.desc`
  );
  app.innerHTML = `
    ${topbar("Planes anteriores", sesion)}
    <main>
      <p class="form-note" style="text-align:left;margin:16px 0 0"><a href="#" id="link-volver-historial" style="color:inherit">‹ Panel</a></p>
      <p class="pill-label" style="margin-top:16px">Planes ya subidos</p>
      ${programas.map((p) => `
        <div class="week-row">
          <div class="week-row-top">
            <span>${esc(p.nombre)}</span>
            <span style="display:flex;gap:8px">
              <button class="skip-btn" data-editar="${p.id}" data-nombre="${esc(p.nombre)}">Editar</button>
              <button class="skip-btn" data-archivar="${p.id}" data-nombre="${esc(p.nombre)}">Archivar</button>
              <button class="skip-btn" data-asignar="${p.id}" data-nombre="${esc(p.nombre)}">Asignar</button>
            </span>
          </div>
          <p class="form-note" style="text-align:left;margin:4px 0 0">Subido el ${new Date(p.created_at).toLocaleDateString("es-ES")}</p>
        </div>`).join("") || `<p class="lead">Todavía no has publicado ningún plan.</p>`}
    </main>`;
  document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
  document.getElementById("link-volver-historial").addEventListener("click", (e) => { e.preventDefault(); renderPanelEntrenador(sesion); });
  document.querySelectorAll("[data-asignar]").forEach((btn) => {
    btn.addEventListener("click", () => renderAsignarPrograma(sesion, btn.dataset.asignar, btn.dataset.nombre));
  });
  document.querySelectorAll("[data-editar]").forEach((btn) => {
    btn.addEventListener("click", () => renderEditarPrograma(sesion, btn.dataset.editar, btn.dataset.nombre));
  });
  document.querySelectorAll("[data-archivar]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        const enUso = await restGet(sesion, `asignaciones?programa_id=eq.${btn.dataset.archivar}&activa=eq.true&select=id`);
        if (enUso.length > 0) {
          alert(`Este plan lo tienen activo ${enUso.length} alumno(s). Asígnales otro plan antes de archivarlo.`);
          return;
        }
        if (!confirm(`¿Archivar "${btn.dataset.nombre}"? Dejará de aparecer en esta lista.`)) return;
        await fetchSupabaseOk(sesion, `${SUPABASE_URL}/rest/v1/programas?id=eq.${btn.dataset.archivar}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ estado: "archivado" }),
        });
        renderHistorialPlanes(sesion);
      } catch {
        alert("No se pudo archivar el plan. Inténtalo de nuevo.");
      }
    });
  });
}

async function renderEditarPrograma(sesion, programaId, nombrePrograma) {
  const semanas = await restGet(sesion, `semanas?programa_id=eq.${programaId}&select=id,numero&order=numero`);

  async function pintarSemanaEdicion(semanaId) {
    const dias = await restGet(sesion, `dias?semana_id=eq.${semanaId}&select=id,numero&order=numero`);
    pintarDiaEdicion(dias[0].id, semanaId, dias);
  }

  async function pintarDiaEdicion(diaId, semanaId, diasDeLaSemana) {
    const prescritas = await restGet(
      sesion,
      `series_prescritas?dia_id=eq.${diaId}&select=id,orden,series,reps_objetivo,rir,descanso,ejercicios_catalogo(nombre)&order=orden`
    );

    app.innerHTML = `
      ${topbar("Editando: " + nombrePrograma, sesion)}
      <main>
        <p class="form-note" style="text-align:left;margin:16px 0 0"><a href="#" id="link-volver-editar" style="color:inherit">‹ Planes anteriores</a></p>
        <div class="pill-label">Semana</div>
        <div class="pill-row" id="pills-semana-edicion">
          ${semanas.map((s) => `<button class="pill${s.id === semanaId ? " active" : ""}" data-id="${s.id}">Semana ${s.numero}</button>`).join("")}
        </div>
        <div class="pill-label">Día</div>
        <div class="pill-row" id="pills-dia-edicion">
          ${diasDeLaSemana.map((d) => `<button class="pill${d.id === diaId ? " active" : ""}" data-id="${d.id}">Día ${d.numero}</button>`).join("")}
        </div>
        ${prescritas.map((p) => `
          <div class="exercise" data-sp="${p.id}">
            <div class="exercise-head"><h2>${esc(p.ejercicios_catalogo.nombre)}</h2></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
              <div class="field"><label>Series</label><input type="text" inputmode="numeric" class="e-series" value="${p.series}" /></div>
              <div class="field"><label>Reps objetivo</label><input type="text" class="e-reps" value="${esc(p.reps_objetivo)}" /></div>
              <div class="field"><label>RIR</label><input type="text" inputmode="decimal" class="e-rir" value="${p.rir ?? ""}" /></div>
              <div class="field"><label>Descanso</label><input type="text" class="e-descanso" value="${esc(p.descanso)}" /></div>
            </div>
            <button class="skip-btn e-guardar">Guardar cambios</button>
          </div>`).join("")}
      </main>`;

    document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
    document.getElementById("link-volver-editar").addEventListener("click", (e) => { e.preventDefault(); renderHistorialPlanes(sesion); });
    document.querySelectorAll("#pills-semana-edicion .pill").forEach((btn) => {
      btn.addEventListener("click", () => pintarSemanaEdicion(btn.dataset.id));
    });
    document.querySelectorAll("#pills-dia-edicion .pill").forEach((btn) => {
      btn.addEventListener("click", () => pintarDiaEdicion(btn.dataset.id, semanaId, diasDeLaSemana));
    });
    document.querySelectorAll(".exercise").forEach((el) => {
      el.querySelector(".e-guardar").addEventListener("click", async (e) => {
        const btn = e.target;
        btn.disabled = true;
        btn.textContent = "Guardando…";
        try {
          await fetchSupabaseOk(sesion, `${SUPABASE_URL}/rest/v1/series_prescritas?id=eq.${el.dataset.sp}`, {
            method: "PATCH",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({
              series: parseInt(el.querySelector(".e-series").value) || 1,
              reps_objetivo: el.querySelector(".e-reps").value.trim() || null,
              rir: el.querySelector(".e-rir").value.trim() !== "" ? parseFloat(el.querySelector(".e-rir").value.replace(",", ".")) : null,
              descanso: el.querySelector(".e-descanso").value.trim() || null,
            }),
          });
          btn.textContent = "Guardado";
          setTimeout(() => { btn.textContent = "Guardar cambios"; btn.disabled = false; }, 1500);
        } catch {
          btn.textContent = "No se pudo guardar, reintentar";
          btn.disabled = false;
        }
      });
    });
  }

  pintarSemanaEdicion(semanas[0].id);
}


async function renderAsignarPrograma(sesion, programaId, nombrePrograma) {
  const alumnos = await restGet(sesion, `usuarios?entrenador_id=eq.${sesion.entrenador_id}&rol=eq.alumno&activo=eq.true&select=id,nombre&order=nombre`);
  app.innerHTML = `
    ${topbar("Asignar plan", sesion)}
    <main>
      <p class="lead" style="margin-top:16px">"${esc(nombrePrograma)}" se ha publicado. ¿A quién se lo asignas?</p>
      ${alumnos.map((a) => `
        <label style="display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--line)">
          <input type="checkbox" data-alumno="${a.id}" />
          <span>${esc(a.nombre)}</span>
        </label>`).join("")}
      <button class="primary" id="btn-asignar" style="margin-top:20px">Asignar a los seleccionados</button>
    </main>`;
  document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
  document.getElementById("btn-asignar").addEventListener("click", async () => {
    const seleccionados = [...document.querySelectorAll("[data-alumno]:checked")].map((c) => c.dataset.alumno);
    if (seleccionados.length === 0) { renderPanelEntrenador(sesion); return; }
    try {
      // Cierra cualquier plan activo anterior de estos alumnos: uno activo a la vez, sin ambigüedad.
      await fetchSupabaseOk(sesion, 
        `${SUPABASE_URL}/rest/v1/asignaciones?usuario_id=in.(${seleccionados.join(",")})&activa=eq.true`,
        { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ activa: false }) }
      );
      await fetchSupabaseOk(sesion, `${SUPABASE_URL}/rest/v1/asignaciones`, {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(seleccionados.map((usuario_id) => ({ usuario_id, programa_id: programaId }))),
      });
    } catch {
      alert("No se pudo asignar el plan. Revisa la conexión e inténtalo de nuevo.");
      return;
    }
    renderPanelEntrenador(sesion);
  });
}

function renderNoDisponibleParaRol(sesion) {
  app.innerHTML = `
    ${topbar(sesion.nombre, sesion)}
    <main>
      <div class="screen-center">
        <h1>Ya casi</h1>
        <p class="lead">Este rol todavía no tiene panel propio.</p>
      </div>
    </main>`;
  document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
}

// ---------------------------------------------------------------
// Pantalla: sin programa asignado
// ---------------------------------------------------------------
function renderSinPrograma(sesion) {
  app.innerHTML = `
    ${topbar(sesion.nombre, sesion)}
    <main>
      <div class="screen-center">
        <h1>Todavía no hay plan</h1>
        <p class="lead">Tu entrenador aún no te ha asignado un programa. Vuelve a intentarlo más tarde.</p>
      </div>
    </main>`;
  document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
}

// ---------------------------------------------------------------
// Pantalla principal: resumen + selector de semana / día + ejercicios
// ---------------------------------------------------------------
function estadoDia(fila) {
  if (!fila || fila.total_series == 0) return "pendiente";
  if (fila.series_completadas >= fila.total_series) return "completo";
  if (fila.series_registradas > 0) return "en_progreso";
  return "pendiente";
}

function anilloProgreso(pct, etiqueta) {
  const r = 34, c = 2 * Math.PI * r;
  const offset = c * (1 - pct / 100);
  return `
    <div class="progress-ring">
      <svg viewBox="0 0 80 80">
        <circle class="track" cx="40" cy="40" r="${r}" />
        <circle class="fill" cx="40" cy="40" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${offset}" />
      </svg>
      <div class="progress-ring-label"><span class="num">${pct}%</span><span>${esc(etiqueta || "del programa")}</span></div>
    </div>`;
}

async function renderHome(sesion) {
  app.innerHTML = `${topbar(sesion.nombre, sesion)}<main><p class="lead">Cargando tu programa…</p></main>`;

  let asignaciones;
  try {
    asignaciones = await restGet(
      sesion,
      `asignaciones?usuario_id=eq.${sesion.usuario_id}&activa=eq.true&select=programa_id,nota_entrenador,programas(nombre,estado)&order=created_at.desc&limit=1`
    );
  } catch {
    if (!leerSesionCruda()) return; // sesión cerrada: ya se está mostrando el login
    app.innerHTML = `${topbar(sesion.nombre, sesion)}<main><p class="form-error">No se pudo cargar tu programa.</p></main>`;
    document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
    return;
  }

  const asignacion = asignaciones.find((a) => a.programas && a.programas.estado === "publicado");
  if (!asignacion) return renderSinPrograma(sesion);

  const programaId = asignacion.programa_id;
  const semanas = await restGet(sesion, `semanas?programa_id=eq.${programaId}&select=id,numero&order=numero`);
  const diasPlanos = await restGet(
    sesion,
    `dias?semana_id=in.(${semanas.map((s) => s.id).join(",")})&select=id,numero,semana_id&order=numero`
  );
  const progreso = await rpc(sesion, "progreso_programa", { p_usuario_id: sesion.usuario_id, p_programa_id: programaId });

  const claveUltimo = `ultimo_${sesion.usuario_id}_${programaId}`;
  let ultimo = {};
  try { ultimo = JSON.parse(localStorage.getItem(claveUltimo) || "{}"); } catch { /* noop */ }

  // Construye la lista ordenada de días con su id real y su estado de progreso
  const diasConEstado = [];
  for (const semana of semanas) {
    const diasDeEstaSemana = diasPlanos.filter((d) => d.semana_id === semana.id);
    for (const dia of diasDeEstaSemana) {
      const fila = progreso.find((p) => p.semana_numero === semana.numero && p.dia_numero === dia.numero);
      diasConEstado.push({
        semanaId: semana.id, semanaNumero: semana.numero,
        diaId: dia.id, diaNumero: dia.numero,
        estado: estadoDia(fila),
        total: fila ? Number(fila.total_series) : 0,
        completadas: fila ? Number(fila.series_completadas) : 0,
      });
    }
  }

  function pintarResumen() {
    const siguiente = diasConEstado.find((d) => d.estado !== "completo") || diasConEstado[diasConEstado.length - 1];
    const todoCompleto = diasConEstado.every((d) => d.estado === "completo");

    const totalPrograma = diasConEstado.reduce((acc, d) => acc + d.total, 0);
    const completadasPrograma = diasConEstado.reduce((acc, d) => acc + d.completadas, 0);
    const pctPrograma = totalPrograma > 0 ? Math.round((completadasPrograma / totalPrograma) * 100) : 0;

    const filasSemana = semanas.map((semana) => {
      const diasSemana = diasConEstado.filter((d) => d.semanaId === semana.id);
      const completos = diasSemana.filter((d) => d.estado === "completo").length;
      const enProgreso = diasSemana.some((d) => d.estado !== "pendiente");
      const totalSemana = diasSemana.reduce((acc, d) => acc + d.total, 0);
      const completadasSemana = diasSemana.reduce((acc, d) => acc + d.completadas, 0);
      const pctSemana = totalSemana > 0 ? Math.round((completadasSemana / totalSemana) * 100) : 0;
      let etiqueta = "Sin empezar";
      if (completos === diasSemana.length) etiqueta = "Completada";
      else if (enProgreso) etiqueta = `En progreso · ${completos}/${diasSemana.length} días`;
      return `
        <div class="week-row" data-semana-id="${semana.id}" style="cursor:pointer">
          <div class="week-row-top"><span>Semana ${semana.numero}</span><span class="week-status">${etiqueta}</span></div>
          <div class="week-bar-track"><div class="week-bar-fill ${completos === diasSemana.length ? "completo" : "en_progreso"}" style="width:${pctSemana}%"></div></div>
        </div>`;
    }).join("");

    app.innerHTML = `
      ${topbar(asignacion.programas.nombre, sesion)}
      <main>
        <div style="display:flex;justify-content:center;margin-top:20px">${anilloProgreso(pctPrograma)}</div>
        ${asignacion.nota_entrenador ? `<div class="week-row"><div class="week-row-top"><span>Nota de tu entrenador</span></div><p style="margin:6px 0 0;font-size:14px">${esc(asignacion.nota_entrenador)}</p></div>` : ""}
        <p class="pill-label" style="margin-top:20px">Tu progreso por semana — toca una semana para entrar</p>
        ${filasSemana}
        <div style="margin-top:24px">
          <button class="primary" id="btn-continuar">
            ${todoCompleto ? "Repasar" : "Continuar"}: Semana ${siguiente.semanaNumero} · Día ${siguiente.diaNumero}
          </button>
        </div>
        <p class="form-note"><a href="#" id="link-elegir" style="color:inherit">Elegir otra semana o día</a></p>
        <p class="form-note"><a href="#" id="link-cambiar-pin" style="color:inherit">Cambiar mi PIN</a></p>
      </main>`;

    document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
    document.querySelectorAll("[data-semana-id]").forEach((row) => {
      row.addEventListener("click", () => {
        const semanaId = row.dataset.semanaId;
        const enEsaSemana = diasConEstado.filter((d) => d.semanaId === semanaId);
        const objetivo = enEsaSemana.find((d) => d.estado !== "completo") || enEsaSemana[0];
        ultimo = { semana_id: semanaId, dia_id: objetivo.diaId };
        localStorage.setItem(claveUltimo, JSON.stringify(ultimo));
        pintarSemana(semanaId);
      });
    });
    document.getElementById("btn-continuar").addEventListener("click", () => {
      ultimo = { semana_id: siguiente.semanaId, dia_id: siguiente.diaId };
      localStorage.setItem(claveUltimo, JSON.stringify(ultimo));
      pintarSemana(siguiente.semanaId);
    });
    document.getElementById("link-cambiar-pin").addEventListener("click", (e) => { e.preventDefault(); abrirCambioPin(sesion); });
    document.getElementById("link-elegir").addEventListener("click", (e) => {
      e.preventDefault();
      const semanaInicial = ultimo.semana_id && semanas.some((s) => s.id === ultimo.semana_id) ? ultimo.semana_id : semanas[0].id;
      pintarSemana(semanaInicial);
    });
  }

  async function pintarSemana(semanaIdActual) {
    const dias = await restGet(sesion, `dias?semana_id=eq.${semanaIdActual}&select=id,numero&order=numero`);

    let diaId = ultimo.semana_id === semanaIdActual && dias.some((d) => d.id === ultimo.dia_id) ? ultimo.dia_id : dias[0].id;

    app.innerHTML = `
      ${topbar(asignacion.programas.nombre, sesion)}
      <main>
        <p class="form-note" style="text-align:left;margin:16px 0 0"><a href="#" id="link-resumen" style="color:inherit">‹ Resumen</a></p>
        <div class="pill-label">Semana</div>
        <div class="pill-row" id="pills-semana">
          ${semanas.map((s) => `<button class="pill${s.id === semanaIdActual ? " active" : ""}" data-id="${s.id}">Semana ${s.numero}</button>`).join("")}
        </div>
        <div class="pill-label">Día</div>
        <div class="pill-row" id="pills-dia">
          ${dias.map((d) => `<button class="pill${d.id === diaId ? " active" : ""}" data-id="${d.id}">Día ${d.numero}</button>`).join("")}
        </div>
        <div id="volumen-semana"></div>
        <div id="contenido-dia"><p class="lead">Cargando ejercicios…</p></div>
      </main>
      <div class="bottombar"><div class="inner">
        <p id="indicador-cola" class="form-note" style="margin:0 0 8px"></p>
        <button class="primary" id="btn-terminar">Terminar sesión</button>
      </div></div>`;

    document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
    document.getElementById("btn-terminar").addEventListener("click", () => pintarResumen());
    document.getElementById("link-resumen").addEventListener("click", (e) => { e.preventDefault(); pintarResumen(); });

    document.querySelectorAll("#pills-semana .pill").forEach((btn) =>
      btn.addEventListener("click", () => {
        localStorage.setItem(claveUltimo, JSON.stringify({ semana_id: btn.dataset.id, dia_id: null }));
        ultimo = { semana_id: btn.dataset.id, dia_id: null };
        pintarSemana(btn.dataset.id);
      })
    );
    document.querySelectorAll("#pills-dia .pill").forEach((btn) =>
      btn.addEventListener("click", () => {
        document.querySelectorAll("#pills-dia .pill").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        localStorage.setItem(claveUltimo, JSON.stringify({ semana_id: semanaIdActual, dia_id: btn.dataset.id }));
        pintarDia(btn.dataset.id);
      })
    );

    actualizarIndicadorCola();
    sincronizarCola(sesion).then(actualizarIndicadorCola);
    pintarVolumenSemana(dias);
    pintarDia(diaId);
  }

  async function pintarVolumenSemana(dias) {
    const el = document.getElementById("volumen-semana");
    if (!el || dias.length === 0) return;
    const prescritas = await restGet(
      sesion,
      `series_prescritas?dia_id=in.(${dias.map((d) => d.id).join(",")})&select=series,ejercicios_catalogo(grupo_muscular)`
    );
    const porGrupo = {};
    for (const p of prescritas) {
      const g = p.ejercicios_catalogo.grupo_muscular;
      porGrupo[g] = (porGrupo[g] || 0) + p.series;
    }
    const filas = Object.entries(porGrupo).sort((a, b) => b[1] - a[1]);
    el.innerHTML = `
      <details class="volumen-detalle" style="margin-top:18px">
        <summary class="pill-label" style="margin:0;cursor:pointer;display:list-item">Volumen de la semana</summary>
        ${filas.map(([g, n]) => `
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--line);font-size:14px">
            <span>${esc(g)}</span><span class="num" style="color:var(--steel)">${n} series</span>
          </div>`).join("")}
      </details>`;
  }

  let contadorPintado = 0;
  async function pintarDia(diaId) {
    const miPintado = ++contadorPintado;
    const contenedor = document.getElementById("contenido-dia");
    contenedor.innerHTML = `<p class="lead">Cargando ejercicios…</p>`;

    try {
      const prescritas = await restGet(
        sesion,
        `series_prescritas?dia_id=eq.${diaId}&select=id,orden,series,reps_objetivo,rir,descanso,ejercicios_catalogo(id,nombre,tipo_metrica)&order=orden`
      );

      const idsPrescritas = prescritas.map((p) => p.id);
      const registradas = idsPrescritas.length
        ? await restGet(
            sesion,
            `series_registradas?serie_prescrita_id=in.(${idsPrescritas.join(",")})&usuario_id=eq.${sesion.usuario_id}&select=serie_prescrita_id,numero_serie,peso_real,valor_real,completada,comentario,rir_real,sin_tiempo`
          )
        : [];

      // Lo guardado sin conexión y aún sin enviar tiene prioridad sobre lo que dice el servidor.
      for (const p of colaLeer().map((i) => i.fila)) {
        if (p.usuario_id !== sesion.usuario_id || !idsPrescritas.includes(p.serie_prescrita_id)) continue;
        const idx = registradas.findIndex((r) => r.serie_prescrita_id === p.serie_prescrita_id && r.numero_serie === p.numero_serie);
        if (idx >= 0) registradas[idx] = { ...registradas[idx], ...p };
        else registradas.push({ ...p });
      }

      const idsEjercicios = [...new Set(prescritas.map((p) => p.ejercicios_catalogo.id))];
      const ultimosPorEjercicio = idsEjercicios.length
        ? await rpc(sesion, "ultimos_registros", { p_usuario_id: sesion.usuario_id, p_ejercicio_ids: idsEjercicios })
        : [];
      const mapaUltimos = Object.fromEntries(ultimosPorEjercicio.map((u) => [u.ejercicio_id, u]));

      if (miPintado !== contadorPintado) return; // el usuario ya cambió de día mientras cargaba

      contenedor.innerHTML = prescritas.map((p) => renderEjercicio(p, registradas, mapaUltimos[p.ejercicios_catalogo.id])).join("");
      prescritas.forEach((p) => conectarEjercicio(sesion, p, programaId));
    } catch {
      if (miPintado !== contadorPintado) return;
      contenedor.innerHTML = `<p class="form-error">No se pudo cargar este día. Sin conexión y sin datos guardados de antes. Vuelve a intentarlo cuando tengas cobertura.</p>`;
    }
  }

  pintarResumen();
}

function renderEjercicio(prescrita, registradas, ultimo) {
  const esSegundos = prescrita.ejercicios_catalogo.tipo_metrica === "segundos";
  const unidad = esSegundos ? "s" : "reps";
  const valorDefecto = ultimo ? (esSegundos ? ultimo.valor_real : ultimo.valor_real) : medioDeRango(prescrita.reps_objetivo);
  const pesoDefecto = ultimo && ultimo.peso_real != null ? ultimo.peso_real : 0;

  const filas = Array.from({ length: prescrita.series }, (_, i) => {
    const n = i + 1;
    const previa = registradas.find((r) => r.serie_prescrita_id === prescrita.id && r.numero_serie === n);
    const peso = previa && previa.peso_real != null ? previa.peso_real : pesoDefecto;
    const valor = previa && previa.valor_real != null ? previa.valor_real : valorDefecto;
    const done = !!(previa && previa.completada);
    return `
      <div class="set-row" data-set="${n}">
        <div class="set-index">${n}</div>
        <div class="stepper${done ? " done" : ""}" data-campo="peso">
          <button data-delta="-1">${icon("minus")}</button>
          <input type="text" inputmode="decimal" class="value num" value="${peso}" />
          <span class="unidad">kg</span>
          <button data-delta="1">${icon("plus")}</button>
        </div>
        <div class="stepper${done ? " done" : ""}" data-campo="valor">
          <button data-delta="-1">${icon("minus")}</button>
          <input type="text" inputmode="numeric" class="value num" value="${valor}" />
          <span class="unidad">${unidad}</span>
          <button data-delta="1">${icon("plus")}</button>
        </div>
        <button class="check-btn${done ? " done" : ""}" data-done="${done ? "1" : "0"}">${icon("check")}</button>
      </div>`;
  }).join("");

  const sinTiempo = registradas.some((r) => r.serie_prescrita_id === prescrita.id && r.sin_tiempo && !r.completada);
  const previaUno = registradas.find((r) => r.serie_prescrita_id === prescrita.id && r.numero_serie === 1);

  return `
    <div class="exercise" data-prescrita="${prescrita.id}">
      <div class="exercise-head">
        <h2>${esc(prescrita.ejercicios_catalogo.nombre)}</h2>
        <div class="meta">${prescrita.series} series · ${esc(prescrita.reps_objetivo)} ${unidad === "s" ? "" : "reps"} · RIR ${prescrita.rir ?? "–"} · ${esc(prescrita.descanso)}</div>
      </div>
      ${filas}
      <div class="exercise-footer">
        <input class="note-input" type="text" placeholder="Nota (opcional)" value="${previaUno && previaUno.comentario ? esc(previaUno.comentario) : ""}" />
        <input class="rir-input num" type="text" inputmode="numeric" placeholder="RIR real" title="¿Con cuántas repeticiones en recámara terminaste?" value="${previaUno && previaUno.rir_real != null ? previaUno.rir_real : ""}" />
        <button class="skip-btn${sinTiempo ? " skipped" : ""}">${sinTiempo ? "Marcado sin tiempo · deshacer" : "No me dio tiempo"}</button>
      </div>
      <details class="volumen-detalle" style="margin-top:14px" data-prog="1">
        <summary class="pill-label" style="margin:0;cursor:pointer;display:list-item">Mi progresión</summary>
        <div class="grafico-progresion-alumno"></div>
      </details>
    </div>`;
}

function conectarEjercicio(sesion, prescrita, programaId) {
  const el = document.querySelector(`.exercise[data-prescrita="${prescrita.id}"]`);
  if (!el) return;
  const notaInput = el.querySelector(".note-input");
  const rirInput = el.querySelector(".rir-input");

  function pesoRedondeado(v) { return Math.round(v * 2) / 2; } // pasos de 0.5 kg
  const paso = { peso: 2.5, valor: 1 };

  async function guardarFila(fila) {
    const numero = parseInt(fila.dataset.set);
    const peso = parseFloat(fila.querySelector('[data-campo="peso"] .value').value) || 0;
    const valor = parseFloat(fila.querySelector('[data-campo="valor"] .value').value) || 0;
    const completada = fila.querySelector(".check-btn").dataset.done === "1";
    return guardarSerieRegistrada(sesion, {
      serie_prescrita_id: prescrita.id,
      usuario_id: sesion.usuario_id,
      numero_serie: numero,
      peso_real: peso,
      valor_real: valor,
      completada,
      sin_tiempo: false,
      comentario: numero === 1 ? notaInput.value.trim() || null : null,
      rir_real: numero === 1 && rirInput.value.trim() !== "" ? parseFloat(rirInput.value.replace(",", ".")) : null,
    });
  }

  async function guardarSiYaMarcada(fila) {
    if (fila.querySelector(".check-btn").dataset.done === "1") {
      try {
        await guardarFila(fila);
      } catch {
        alert("No se pudo guardar el cambio. Revisa tu conexión.");
      }
    }
  }

  function copiarPesoASiguientes(inputActual, valor) {
    el.querySelectorAll(".set-row").forEach((otraFila) => {
      const otroCheck = otraFila.querySelector(".check-btn");
      if (otroCheck.dataset.done === "1") return;
      const otroInput = otraFila.querySelector('[data-campo="peso"] .value');
      if (otroInput === inputActual) return;
      otroInput.value = valor;
    });
  }

  el.querySelectorAll(".stepper button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const stepper = btn.closest(".stepper");
      const campo = stepper.dataset.campo;
      const inputEl = stepper.querySelector(".value");
      let actual = parseFloat(inputEl.value) || 0;
      actual = Math.max(0, actual + parseInt(btn.dataset.delta) * paso[campo]);
      if (campo === "peso") actual = pesoRedondeado(actual);
      inputEl.value = actual;

      // El peso suele ser el mismo en todas las series de un ejercicio:
      // lo copiamos a las series siguientes que aún no se hayan marcado como hechas.
      if (campo === "peso") copiarPesoASiguientes(inputEl, actual);

      // Si la serie ya estaba marcada como hecha, el ajuste debe guardarse solo,
      // sin obligar a desmarcar y volver a marcar.
      await guardarSiYaMarcada(stepper.closest(".set-row"));
    });
  });

  // Escribir el número directamente también funciona, no solo los botones +/-.
  el.querySelectorAll(".stepper input.value").forEach((inputEl) => {
    inputEl.addEventListener("change", async () => {
      const stepper = inputEl.closest(".stepper");
      const campo = stepper.dataset.campo;
      let actual = parseFloat(inputEl.value.replace(",", ".")) || 0;
      if (campo === "peso") actual = pesoRedondeado(actual);
      inputEl.value = actual;
      if (campo === "peso") copiarPesoASiguientes(inputEl, actual);
      await guardarSiYaMarcada(stepper.closest(".set-row"));
    });
  });

  el.querySelectorAll(".check-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const fila = btn.closest(".set-row");
      const marcarComoHecho = btn.dataset.done !== "1";

      btn.classList.toggle("done", marcarComoHecho);
      btn.dataset.done = marcarComoHecho ? "1" : "0";
      fila.querySelectorAll(".stepper").forEach((s) => s.classList.toggle("done", marcarComoHecho));

      try {
        await guardarFila(fila);
      } catch {
        // revertir visualmente si falla el guardado
        btn.classList.toggle("done", !marcarComoHecho);
        btn.dataset.done = !marcarComoHecho ? "1" : "0";
        fila.querySelectorAll(".stepper").forEach((s) => s.classList.toggle("done", !marcarComoHecho));
        alert("No se pudo guardar esa serie. Revisa tu conexión.");
      }
    });
  });

  const detalleProgresion = el.querySelector("details[data-prog]");
  detalleProgresion.addEventListener("toggle", async () => {
    if (!detalleProgresion.open || detalleProgresion.dataset.cargado) return;
    detalleProgresion.dataset.cargado = "1";
    const cont = detalleProgresion.querySelector(".grafico-progresion-alumno");
    cont.innerHTML = `<p class="lead">Cargando…</p>`;
    try {
      const puntos = await rpc(sesion, "progresion_ejercicio", {
        p_usuario_id: sesion.usuario_id, p_programa_id: programaId, p_ejercicio_id: prescrita.ejercicios_catalogo.id,
      });
      dibujarGraficoProgresion(cont, puntos);
    } catch {
      detalleProgresion.dataset.cargado = "";
      cont.innerHTML = `<p class="lead">No se pudo cargar tu progresión. Inténtalo de nuevo.</p>`;
    }
  });

  const skipBtn = el.querySelector(".skip-btn");
  skipBtn.addEventListener("click", async () => {
    const yaMarcado = skipBtn.classList.contains("skipped");
    const sinHacer = [...el.querySelectorAll(".set-row")].filter((f) => f.querySelector(".check-btn").dataset.done !== "1");

    if (!yaMarcado) {
      skipBtn.classList.add("skipped");
      skipBtn.textContent = "Marcado sin tiempo · deshacer";
      for (const fila of sinHacer) {
        try {
          await guardarSerieRegistrada(sesion, {
            serie_prescrita_id: prescrita.id,
            usuario_id: sesion.usuario_id,
            numero_serie: parseInt(fila.dataset.set),
            peso_real: null,
            valor_real: null,
            completada: false,
            sin_tiempo: true,
          });
        } catch { /* se reintentará la próxima vez que se abra el día */ }
      }
    } else {
      // Deshacer: se borran las filas vacías marcadas "sin tiempo" (las hechas no se tocan).
      skipBtn.classList.remove("skipped");
      skipBtn.textContent = "No me dio tiempo";
      try {
        await fetchSupabaseOk(
          sesion,
          `${SUPABASE_URL}/rest/v1/series_registradas?serie_prescrita_id=eq.${prescrita.id}&usuario_id=eq.${sesion.usuario_id}&sin_tiempo=eq.true&completada=eq.false`,
          { method: "DELETE" }
        );
        // Si alguna estaba pendiente en la cola offline, tampoco debe llegar después.
        colaGuardar(colaLeer().filter((i) => !(i.fila.serie_prescrita_id === prescrita.id && i.fila.sin_tiempo)));
      } catch {
        skipBtn.classList.add("skipped");
        skipBtn.textContent = "Marcado sin tiempo · deshacer";
        alert("No se pudo deshacer. Revisa tu conexión e inténtalo de nuevo.");
      }
    }
  });
}

// ---------------------------------------------------------------
// Router
// ---------------------------------------------------------------
function render() {
  const sesion = leerSesion();
  if (!sesion) return renderLogin(null);
  if (sesion.rol === "admin") return renderPanelAdmin(sesion);
  if (sesion.rol === "entrenador") return renderPanelEntrenador(sesion);
  if (sesion.rol !== "alumno") return renderNoDisponibleParaRol(sesion);
  renderHome(sesion);
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    const reg = await navigator.serviceWorker.register("./sw.js");
    // Fuerza a comprobar si hay una versión nueva del propio service worker
    // cada vez que se abre la app, en vez de fiarse del ciclo por defecto del navegador.
    reg.update();
  });
}
window.addEventListener("online", () => {
  const sesion = leerSesion();
  if (sesion) sincronizarCola(sesion).then(actualizarIndicadorCola);
});

// Al volver a la app (el móvil pausa los temporizadores en segundo plano) y cada minuto:
// se renueva el token si va a caducar y se reintenta lo que quedara sin sincronizar.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  const sesion = leerSesion();
  if (!sesion) return;
  renovarTokenSiHaceFalta().then(() => sincronizarCola(sesion)).then(actualizarIndicadorCola);
});
setInterval(() => { renovarTokenSiHaceFalta(); }, 60_000);

render();
