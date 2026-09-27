// ---------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------
const SUPABASE_URL = "https://kdnbmckjvkrwuwxyqfgk.supabase.co";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtkbmJtY2tqdmtyd3V3eHlxZmdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0MzMyOTksImV4cCI6MjEwNjAwOTI5OX0.CTPwfVasNNcs01QxsaZDhMFku-MHkwSiOePJp4zUbJk";
const SESION_MAXIMA_HORAS = 48;

const app = document.getElementById("app");

// ---------------------------------------------------------------
// Sesión (localStorage)
// ---------------------------------------------------------------
function leerSesion() {
  try {
    const raw = localStorage.getItem("sesion");
    if (!raw) return null;
    const sesion = JSON.parse(raw);
    const horasDesdeLogin = (Date.now() - sesion.autenticado_en) / 3_600_000;
    if (horasDesdeLogin > SESION_MAXIMA_HORAS) {
      localStorage.removeItem("sesion");
      return null;
    }
    return sesion;
  } catch {
    return null;
  }
}

function guardarSesion(datos) {
  localStorage.setItem("sesion", JSON.stringify({ ...datos, autenticado_en: Date.now() }));
}

function cerrarSesion() {
  localStorage.removeItem("sesion");
  render();
}

function entrenadorIdGuardado() {
  const params = new URLSearchParams(location.search);
  const desdeUrl = params.get("e");
  if (desdeUrl) localStorage.setItem("entrenador_id", desdeUrl);
  return desdeUrl || localStorage.getItem("entrenador_id") || "";
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
  return {
    apikey: ANON_KEY,
    Authorization: `Bearer ${sesion.access_token}`,
    "Content-Type": "application/json",
  };
}

async function llamarFuncion(sesion, nombre, body) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${nombre}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sesion.access_token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "error_desconocido");
  return data;
}

async function restGet(sesion, path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: headersRest(sesion) });
  if (!res.ok) throw new Error(`Error de red (${res.status})`);
  return res.json();
}

async function rpc(sesion, nombre, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${nombre}`, {
    method: "POST",
    headers: headersRest(sesion),
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Error de red (${res.status})`);
  return res.json();
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

async function enviarSerieRegistrada(sesion, fila) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/series_registradas?on_conflict=serie_prescrita_id,usuario_id,numero_serie`,
    {
      method: "POST",
      headers: { ...headersRest(sesion), Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify([fila]),
    }
  );
  if (!res.ok) throw new Error(`No se pudo guardar (${res.status})`);
  return res.json();
}

async function sincronizarCola(sesion) {
  const cola = colaLeer();
  if (cola.length === 0) return;
  const restante = [];
  for (const item of cola) {
    try {
      await enviarSerieRegistrada(sesion, item.fila);
    } catch {
      restante.push(item);
    }
  }
  colaGuardar(restante);
}

async function guardarSerieRegistrada(sesion, fila) {
  try {
    return await enviarSerieRegistrada(sesion, fila);
  } catch (err) {
    if (err instanceof TypeError) {
      // Fallo de red real (sin conexión): se guarda en el móvil y se
      // reintenta solo en cuanto vuelva a haber señal, sin perder el dato.
      const cola = colaLeer();
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
function icon(name, extraClass) {
  return `<svg class="icon${extraClass ? " " + extraClass : ""}"><use href="#i-${name}"/></svg>`;
}

function topbar(titulo, sesion) {
  return `
    <div class="topbar">
      <div class="brand">${icon("dumbbell")}<span>${titulo}</span></div>
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
      <p class="form-note">[diagnóstico temporal] Grupo detectado: ${entrenadorIdGuardado() || "NINGUNO — falta el código en la URL"}</p>
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

async function renderPanelEntrenador(sesion) {
  app.innerHTML = `${topbar("Panel de " + sesion.nombre, sesion)}<main><p class="lead">Cargando tus alumnos…</p></main>`;

  const alumnos = await restGet(sesion, `usuarios?entrenador_id=eq.${sesion.entrenador_id}&rol=eq.alumno&select=id,nombre&order=nombre`);

  const filas = [];
  for (const alumno of alumnos) {
    const asignaciones = await restGet(
      sesion,
      `asignaciones?usuario_id=eq.${alumno.id}&activa=eq.true&select=programa_id,created_at,programas(nombre,estado)&order=created_at.desc&limit=1`
    );
    const asignacion = asignaciones.find((a) => a.programas && a.programas.estado === "publicado");
    if (!asignacion) {
      filas.push({ alumno, programaNombre: null, pct: 0, dias: [] });
      continue;
    }
    const { semanas, dias } = await calcularDiasConEstado(sesion, alumno.id, asignacion.programa_id);
    const semanaEsperada = semanaEsperadaActual(asignacion.created_at, semanas.length);
    const atrasado = dias.some((d) => d.semanaNumero < semanaEsperada && d.estado !== "completo");
    filas.push({
      alumno, programaNombre: asignacion.programas.nombre, programaId: asignacion.programa_id,
      pct: porcentaje(dias), dias, semanaEsperada, atrasado,
    });
  }

  app.innerHTML = `
    ${topbar("Panel de " + sesion.nombre, sesion)}
    <main>
      <div style="margin-top:16px"><button class="primary" id="btn-importar">Subir nuevo plan (Excel)</button></div>
      <p class="pill-label" style="margin-top:20px">Tus alumnos</p>
      ${filas.map((f, i) => `
        <div class="week-row" data-alumno="${i}" style="cursor:pointer">
          <div class="week-row-top">
            <span>${f.alumno.nombre}${f.atrasado ? ' <span style="color:var(--danger);font-size:12px;font-weight:600">· atrasado</span>' : ""}</span>
            <span style="display:flex;align-items:center;gap:10px">
              <span class="week-status">${f.programaNombre ? f.pct + "%" : "Sin programa"}</span>
              <button class="skip-btn" data-reset="${f.alumno.id}" data-nombre="${f.alumno.nombre}">Resetear PIN</button>
            </span>
          </div>
          ${f.programaNombre ? `<div class="week-bar-track"><div class="week-bar-fill ${f.pct === 100 ? "completo" : "en_progreso"}" style="width:${f.pct}%"></div></div>` : ""}
        </div>`).join("")}
    </main>`;

  document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
  document.getElementById("btn-importar").addEventListener("click", () => renderImportarExcel(sesion));
  document.querySelectorAll("[data-reset]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      resetearPinConfirmando(sesion, { id: btn.dataset.reset, nombre: btn.dataset.nombre }, () => renderPanelEntrenador(sesion));
    });
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
      <p class="pill-label" style="margin-top:20px">Progreso por semana — toca un día para ver el detalle</p>
      ${filasSemana}
    </main>`;
  document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
  document.querySelectorAll("[data-dia-idx]").forEach((btn) => {
    btn.addEventListener("click", () => renderDetalleDia(sesion, f, f.dias[parseInt(btn.dataset.diaIdx)]));
  });
  document.getElementById("link-volver").addEventListener("click", (e) => { e.preventDefault(); renderPanelEntrenador(sesion); });
}

// ---------------------------------------------------------------
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

  return `
    <div class="exercise">
      <div class="exercise-head">
        <h2>${prescrita.ejercicios_catalogo.nombre}</h2>
        <div class="meta">${prescrita.series} series · ${prescrita.reps_objetivo} ${unidad === "s" ? "" : "reps"} · RIR ${prescrita.rir ?? "–"}</div>
      </div>
      ${filas}
      ${comentarios.length ? `<p class="form-note" style="text-align:left;margin-top:10px">Nota: ${comentarios.join(" · ")}</p>` : ""}
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
    ? await restGet(sesion, `series_registradas?serie_prescrita_id=in.(${ids.join(",")})&usuario_id=eq.${f.alumno.id}&select=serie_prescrita_id,numero_serie,peso_real,valor_real,completada,comentario`)
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
    alert(`Nuevo PIN de ${usuario.nombre}: ${resultado.pin}\n\nApúntalo ahora, no se puede volver a mostrar.`);
    if (alRefrescar) alRefrescar();
  } catch {
    alert("No se pudo generar el PIN nuevo. Inténtalo de nuevo.");
  }
}

// ---------------------------------------------------------------
// Panel del admin: entrenadores + alta de entrenadores nuevos
// ---------------------------------------------------------------
async function renderPanelAdmin(sesion) {
  app.innerHTML = `${topbar("Panel de administración", sesion)}<main><p class="lead">Cargando…</p></main>`;

  const entrenadores = await restGet(sesion, `entrenadores?select=id,nombre&order=nombre`);
  const usuarios = await restGet(sesion, `usuarios?rol=eq.entrenador&select=id,nombre,entrenador_id`);
  const alumnos = await restGet(sesion, `usuarios?rol=eq.alumno&select=id,nombre,entrenador_id&order=nombre`);

  const filasEntrenador = entrenadores.map((e) => {
    const persona = usuarios.find((u) => u.entrenador_id === e.id);
    const alumnosDelGrupo = alumnos.filter((a) => a.entrenador_id === e.id);
    return `
      <div class="week-row">
        <div class="week-row-top">
          <span>${e.nombre}</span>
          ${persona ? `<button class="skip-btn" data-reset="${persona.id}" data-nombre="${persona.nombre}">Resetear PIN</button>` : ""}
        </div>
        ${alumnosDelGrupo.map((a) => `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;padding-left:12px">
            <span style="font-size:14px;color:var(--steel)">${a.nombre}</span>
            <button class="skip-btn" data-reset="${a.id}" data-nombre="${a.nombre}">Resetear PIN</button>
          </div>`).join("")}
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
    </main>`;

  document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
  document.querySelectorAll("[data-reset]").forEach((btn) => {
    btn.addEventListener("click", () =>
      resetearPinConfirmando(sesion, { id: btn.dataset.reset, nombre: btn.dataset.nombre }, () => renderPanelAdmin(sesion))
    );
  });
  document.getElementById("form-nuevo-entrenador").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nombre = document.getElementById("nombre-entrenador").value.trim();
    const nombreGrupo = document.getElementById("nombre-grupo").value.trim();
    try {
      const resultado = await llamarFuncion(sesion, "crear-usuario", { rol: "entrenador", nombre, nombre_entrenador: nombreGrupo });
      alert(`Entrenador creado. PIN de ${nombre}: ${resultado.pin}\n\nApúntalo ahora, no se puede volver a mostrar.`);
      renderPanelAdmin(sesion);
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
            <div class="week-row-top"><span>${nombre}</span></div>
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
        <input id="nombre-programa" value="${archivo.name.replace(/\.[^.]+$/, "")}" />
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
          const res = await fetch(`${SUPABASE_URL}/rest/v1/ejercicios_catalogo`, {
            method: "POST",
            headers: { ...headersRest(sesion), Prefer: "return=minimal" },
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
        const resPrograma = await fetch(`${SUPABASE_URL}/rest/v1/programas`, {
          method: "POST",
          headers: { ...headersRest(sesion), Prefer: "return=representation" },
          body: JSON.stringify({ entrenador_id: sesion.entrenador_id, nombre: nombrePrograma, estado: "borrador" }),
        });
        if (!resPrograma.ok) throw new Error("error_programa");
        const [programaCreado] = await resPrograma.json();

        // 3. Guarda el borrador de importación
        const resBorrador = await fetch(`${SUPABASE_URL}/rest/v1/importaciones_borrador`, {
          method: "POST",
          headers: { ...headersRest(sesion), Prefer: "return=representation" },
          body: JSON.stringify({ programa_id: programaCreado.id, estado_revision: "pendiente", datos: programa }),
        });
        if (!resBorrador.ok) throw new Error("error_borrador");
        const [borradorCreado] = await resBorrador.json();

        // 4. Publica (materializa semanas/días/series_prescritas)
        const resPublicar = await fetch(`${SUPABASE_URL}/rest/v1/rpc/publicar_programa`, {
          method: "POST",
          headers: headersRest(sesion),
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

async function renderAsignarPrograma(sesion, programaId, nombrePrograma) {
  const alumnos = await restGet(sesion, `usuarios?entrenador_id=eq.${sesion.entrenador_id}&rol=eq.alumno&select=id,nombre&order=nombre`);
  app.innerHTML = `
    ${topbar("Asignar plan", sesion)}
    <main>
      <p class="lead" style="margin-top:16px">"${nombrePrograma}" se ha publicado. ¿A quién se lo asignas?</p>
      ${alumnos.map((a) => `
        <label style="display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--line)">
          <input type="checkbox" data-alumno="${a.id}" />
          <span>${a.nombre}</span>
        </label>`).join("")}
      <button class="primary" id="btn-asignar" style="margin-top:20px">Asignar a los seleccionados</button>
    </main>`;
  document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
  document.getElementById("btn-asignar").addEventListener("click", async () => {
    const seleccionados = [...document.querySelectorAll("[data-alumno]:checked")].map((c) => c.dataset.alumno);
    if (seleccionados.length === 0) { renderPanelEntrenador(sesion); return; }
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/asignaciones`, {
        method: "POST",
        headers: { ...headersRest(sesion), Prefer: "return=minimal" },
        body: JSON.stringify(seleccionados.map((usuario_id) => ({ usuario_id, programa_id: programaId }))),
      });
    } catch { /* si falla, el entrenador puede reintentar la asignación luego */ }
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
      <div class="progress-ring-label"><span class="num">${pct}%</span><span>${etiqueta || "del programa"}</span></div>
    </div>`;
}

async function renderHome(sesion) {
  app.innerHTML = `${topbar(sesion.nombre, sesion)}<main><p class="lead">Cargando tu programa…</p></main>`;

  let asignaciones;
  try {
    asignaciones = await restGet(
      sesion,
      `asignaciones?usuario_id=eq.${sesion.usuario_id}&activa=eq.true&select=programa_id,programas(nombre,estado)&order=created_at.desc&limit=1`
    );
  } catch {
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
        <div class="week-row">
          <div class="week-row-top"><span>Semana ${semana.numero}</span><span class="week-status">${etiqueta}</span></div>
          <div class="week-bar-track"><div class="week-bar-fill ${completos === diasSemana.length ? "completo" : "en_progreso"}" style="width:${pctSemana}%"></div></div>
        </div>`;
    }).join("");

    app.innerHTML = `
      ${topbar(asignacion.programas.nombre, sesion)}
      <main>
        <div style="display:flex;justify-content:center;margin-top:20px">${anilloProgreso(pctPrograma)}</div>
        <p class="pill-label" style="margin-top:20px">Tu progreso por semana</p>
        ${filasSemana}
        <div style="margin-top:24px">
          <button class="primary" id="btn-continuar">
            ${todoCompleto ? "Repasar" : "Continuar"}: Semana ${siguiente.semanaNumero} · Día ${siguiente.diaNumero}
          </button>
        </div>
        <p class="form-note"><a href="#" id="link-elegir" style="color:inherit">Elegir otra semana o día</a></p>
      </main>`;

    document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
    document.getElementById("btn-continuar").addEventListener("click", () => {
      ultimo = { semana_id: siguiente.semanaId, dia_id: siguiente.diaId };
      localStorage.setItem(claveUltimo, JSON.stringify(ultimo));
      pintarSemana(siguiente.semanaId);
    });
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
            <span>${g}</span><span class="num" style="color:var(--steel)">${n} series</span>
          </div>`).join("")}
      </details>`;
  }

  async function pintarDia(diaId) {
    const contenedor = document.getElementById("contenido-dia");
    contenedor.innerHTML = `<p class="lead">Cargando ejercicios…</p>`;

    const prescritas = await restGet(
      sesion,
      `series_prescritas?dia_id=eq.${diaId}&select=id,orden,series,reps_objetivo,rir,descanso,ejercicios_catalogo(id,nombre,tipo_metrica)&order=orden`
    );

    const idsPrescritas = prescritas.map((p) => p.id);
    const registradas = idsPrescritas.length
      ? await restGet(
          sesion,
          `series_registradas?serie_prescrita_id=in.(${idsPrescritas.join(",")})&usuario_id=eq.${sesion.usuario_id}&select=serie_prescrita_id,numero_serie,peso_real,valor_real,completada`
        )
      : [];

    const idsEjercicios = [...new Set(prescritas.map((p) => p.ejercicios_catalogo.id))];
    const ultimosPorEjercicio = idsEjercicios.length
      ? await rpc(sesion, "ultimos_registros", { p_usuario_id: sesion.usuario_id, p_ejercicio_ids: idsEjercicios })
      : [];
    const mapaUltimos = Object.fromEntries(ultimosPorEjercicio.map((u) => [u.ejercicio_id, u]));

    contenedor.innerHTML = prescritas.map((p) => renderEjercicio(p, registradas, mapaUltimos[p.ejercicios_catalogo.id])).join("");

    prescritas.forEach((p) => conectarEjercicio(sesion, p));
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

  return `
    <div class="exercise" data-prescrita="${prescrita.id}">
      <div class="exercise-head">
        <h2>${prescrita.ejercicios_catalogo.nombre}</h2>
        <div class="meta">${prescrita.series} series · ${prescrita.reps_objetivo} ${unidad === "s" ? "" : "reps"} · RIR ${prescrita.rir ?? "–"} · ${prescrita.descanso || ""}</div>
      </div>
      ${filas}
      <div class="exercise-footer">
        <input class="note-input" type="text" placeholder="Nota (opcional)" />
        <button class="skip-btn">No me dio tiempo</button>
      </div>
    </div>`;
}

function conectarEjercicio(sesion, prescrita) {
  const el = document.querySelector(`.exercise[data-prescrita="${prescrita.id}"]`);
  if (!el) return;
  const notaInput = el.querySelector(".note-input");

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
      comentario: numero === 1 ? notaInput.value.trim() || null : null,
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

  const skipBtn = el.querySelector(".skip-btn");
  skipBtn.addEventListener("click", async () => {
    skipBtn.classList.add("skipped");
    skipBtn.textContent = "Marcado sin tiempo";
    const filasPendientes = el.querySelectorAll('.set-row');
    for (const fila of filasPendientes) {
      const numero = parseInt(fila.dataset.set);
      const checkBtn = fila.querySelector(".check-btn");
      if (checkBtn.dataset.done === "1") continue;
      try {
        await guardarSerieRegistrada(sesion, {
          serie_prescrita_id: prescrita.id,
          usuario_id: sesion.usuario_id,
          numero_serie: numero,
          peso_real: null,
          valor_real: null,
          completada: false,
          comentario: "Sin tiempo",
        });
      } catch { /* se reintentará la próxima vez que se abra el día */ }
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

render();
