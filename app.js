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

async function guardarSerieRegistrada(sesion, fila) {
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

async function renderPanelEntrenador(sesion) {
  app.innerHTML = `${topbar("Panel de " + sesion.nombre, sesion)}<main><p class="lead">Cargando tus alumnos…</p></main>`;

  const alumnos = await restGet(sesion, `usuarios?entrenador_id=eq.${sesion.entrenador_id}&rol=eq.alumno&select=id,nombre&order=nombre`);

  const filas = [];
  for (const alumno of alumnos) {
    const asignaciones = await restGet(
      sesion,
      `asignaciones?usuario_id=eq.${alumno.id}&activa=eq.true&select=programa_id,programas(nombre,estado)&order=created_at.desc&limit=1`
    );
    const asignacion = asignaciones.find((a) => a.programas && a.programas.estado === "publicado");
    if (!asignacion) {
      filas.push({ alumno, programaNombre: null, pct: 0, dias: [] });
      continue;
    }
    const { dias } = await calcularDiasConEstado(sesion, alumno.id, asignacion.programa_id);
    filas.push({ alumno, programaNombre: asignacion.programas.nombre, programaId: asignacion.programa_id, pct: porcentaje(dias), dias });
  }

  app.innerHTML = `
    ${topbar("Panel de " + sesion.nombre, sesion)}
    <main>
      <p class="pill-label" style="margin-top:16px">Tus alumnos</p>
      ${filas.map((f, i) => `
        <div class="week-row" data-alumno="${i}" style="cursor:pointer">
          <div class="week-row-top">
            <span>${f.alumno.nombre}</span>
            <span class="week-status">${f.programaNombre ? f.pct + "%" : "Sin programa"}</span>
          </div>
          ${f.programaNombre ? `<div class="week-bar-track"><div class="week-bar-fill ${f.pct === 100 ? "completo" : "en_progreso"}" style="width:${f.pct}%"></div></div>` : ""}
        </div>`).join("")}
    </main>`;

  document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
  document.querySelectorAll("[data-alumno]").forEach((row) => {
    row.addEventListener("click", () => {
      const f = filas[parseInt(row.dataset.alumno)];
      if (f.programaNombre) renderDetalleAlumno(sesion, f);
    });
  });
}

function renderDetalleAlumno(sesion, f) {
  const filasSemana = f.dias.reduce((acc, d) => {
    let semana = acc.find((s) => s.numero === d.semanaNumero);
    if (!semana) { semana = { numero: d.semanaNumero, dias: [] }; acc.push(semana); }
    semana.dias.push(d);
    return acc;
  }, []).map((semana) => {
    const completos = semana.dias.filter((d) => d.estado === "completo").length;
    const total = semana.dias.reduce((a, d) => a + d.total, 0);
    const completadas = semana.dias.reduce((a, d) => a + d.completadas, 0);
    const pct = total > 0 ? Math.round((completadas / total) * 100) : 0;
    let etiqueta = "Sin empezar";
    if (completos === semana.dias.length) etiqueta = "Completada";
    else if (semana.dias.some((d) => d.estado !== "pendiente")) etiqueta = `En progreso · ${completos}/${semana.dias.length} días`;
    return `
      <div class="week-row">
        <div class="week-row-top"><span>Semana ${semana.numero}</span><span class="week-status">${etiqueta}</span></div>
        <div class="week-bar-track"><div class="week-bar-fill ${completos === semana.dias.length ? "completo" : "en_progreso"}" style="width:${pct}%"></div></div>
      </div>`;
  }).join("");

  app.innerHTML = `
    ${topbar(f.alumno.nombre, sesion)}
    <main>
      <p class="form-note" style="text-align:left;margin:16px 0 0"><a href="#" id="link-volver" style="color:inherit">‹ Alumnos</a></p>
      <div style="display:flex;justify-content:center;margin-top:12px">${anilloProgreso(f.pct, f.programaNombre)}</div>
      <p class="pill-label" style="margin-top:20px">Progreso por semana</p>
      ${filasSemana}
    </main>`;
  document.getElementById("btn-salir").addEventListener("click", cerrarSesion);
  document.getElementById("link-volver").addEventListener("click", (e) => { e.preventDefault(); renderPanelEntrenador(sesion); });
}

// ---------------------------------------------------------------
// Pantalla: solo alumnos por ahora
// ---------------------------------------------------------------
function renderNoDisponibleParaRol(sesion) {
  app.innerHTML = `
    ${topbar(sesion.nombre, sesion)}
    <main>
      <div class="screen-center">
        <h1>Ya casi</h1>
        <p class="lead">El panel de entrenador/admin llega en la próxima fase. De momento esta app registra el entrenamiento de los alumnos.</p>
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
        <div id="contenido-dia"><p class="lead">Cargando ejercicios…</p></div>
      </main>
      <div class="bottombar"><div class="inner"><button class="primary" id="btn-terminar">Terminar sesión</button></div></div>`;

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

    pintarDia(diaId);
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
          <div class="value num" data-valor="${peso}">${peso} kg</div>
          <button data-delta="1">${icon("plus")}</button>
        </div>
        <div class="stepper${done ? " done" : ""}" data-campo="valor">
          <button data-delta="-1">${icon("minus")}</button>
          <div class="value num" data-valor="${valor}">${valor} ${unidad}</div>
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
    const peso = parseFloat(fila.querySelector('[data-campo="peso"] .value').dataset.valor);
    const valor = parseFloat(fila.querySelector('[data-campo="valor"] .value').dataset.valor);
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

  el.querySelectorAll(".stepper button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const stepper = btn.closest(".stepper");
      const campo = stepper.dataset.campo;
      const valorEl = stepper.querySelector(".value");
      let actual = parseFloat(valorEl.dataset.valor);
      actual = Math.max(0, actual + parseInt(btn.dataset.delta) * paso[campo]);
      if (campo === "peso") actual = pesoRedondeado(actual);
      valorEl.dataset.valor = actual;
      const unidad = valorEl.textContent.trim().split(" ").slice(-1)[0];
      valorEl.textContent = `${actual} ${unidad}`;

      // El peso suele ser el mismo en todas las series de un ejercicio:
      // lo copiamos a las series siguientes que aún no se hayan marcado como hechas.
      if (campo === "peso") {
        el.querySelectorAll(".set-row").forEach((otraFila) => {
          const otroCheck = otraFila.querySelector(".check-btn");
          if (otroCheck.dataset.done === "1") return;
          const otroStepper = otraFila.querySelector('[data-campo="peso"] .value');
          if (otroStepper === valorEl) return;
          otroStepper.dataset.valor = actual;
          otroStepper.textContent = `${actual} kg`;
        });
      }

      // Si la serie ya estaba marcada como hecha, el ajuste debe guardarse solo,
      // sin obligar a desmarcar y volver a marcar.
      const filaActual = stepper.closest(".set-row");
      if (filaActual.querySelector(".check-btn").dataset.done === "1") {
        try {
          await guardarFila(filaActual);
        } catch {
          alert("No se pudo guardar el cambio. Revisa tu conexión.");
        }
      }
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

render();
