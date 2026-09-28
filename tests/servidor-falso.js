// Servidor falso compartido por las pruebas (humo y diseño). Devuelve {status, cuerpo}.
const PRESCRITAS = [
  { id: "sp1", orden: 1, series: 3, reps_objetivo: "6-10", rir: 2, descanso: "2 min",
    ejercicios_catalogo: { id: "e-press", nombre: "Press <i>banca</i>", tipo_metrica: "reps" } },
  { id: "sp2", orden: 2, series: 2, reps_objetivo: "30-45 s", rir: 2, descanso: "60 s",
    ejercicios_catalogo: { id: "e-plancha", nombre: "Plancha lateral", tipo_metrica: "segundos" } },
];


function responder(metodo, ruta, cuerpo, estado = {}) {
  const resp = (status, c) => ({ status, cuerpo: c });
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
    if (ruta.startsWith("/rest/v1/series_registradas?serie_prescrita_id=in.")) return resp(200, (estado.registradas || []));
    if (ruta.startsWith("/rest/v1/rpc/ultimos_registros")) return resp(200, []);
    if (ruta.startsWith("/rest/v1/rpc/progresion_ejercicio"))
      return resp(200, [{ semana_numero: 1, peso_max: 50, rir_promedio: 2 }, { semana_numero: 2, peso_max: 55, rir_promedio: 1.5 }]);
    if (metodo === "POST" && ruta.startsWith("/rest/v1/series_registradas")) return resp(201, [cuerpo[0]]);
    if (metodo === "DELETE" && ruta.startsWith("/rest/v1/series_registradas")) return resp(204, null);

    // --- entrenador / admin ---
    if (ruta.startsWith("/rest/v1/usuarios?entrenador_id=eq.e1&rol=eq.alumno"))
      return resp(200, [{ id: "u-alumno", nombre: "Pepe Ruiz", activo: true }, { id: "u-viejo", nombre: "Alumno Antiguo", activo: false }]);
    if (ruta.startsWith("/rest/v1/rpc/ultima_actividad")) return resp(200, null);
    if (ruta.startsWith("/rest/v1/programas?entrenador_id=eq.e1"))
      return resp(200, [{ id: "p1", nombre: "Hipertrofia + salud - 8 semanas", created_at: "2026-09-01T10:00:00Z" }]);
    if (ruta.startsWith("/rest/v1/asignaciones?programa_id=eq.p1")) return resp(200, []);
    if (ruta.startsWith("/rest/v1/entrenadores?select")) return resp(200, [{ id: "e1", nombre: "Grupo de Javier" }]);
    if (ruta.startsWith("/rest/v1/usuarios?rol=eq.entrenador")) return resp(200, [{ id: "u-ent", nombre: "Javier", entrenador_id: "e1", activo: true }]);
    if (ruta.startsWith("/rest/v1/usuarios?rol=eq.alumno")) return resp(200, [{ id: "u-alumno", nombre: "Pepe Ruiz", entrenador_id: "e1", activo: true }]);
    if (ruta.startsWith("/functions/v1/crear-usuario")) return resp(201, { usuario_id: "u-nuevo", nombre: cuerpo.nombre, rol: cuerpo.rol, pin: "4821" });
    if (ruta.startsWith("/functions/v1/cambiar-pin")) return resp(200, { ok: true });
    return resp(404, { message: "sin ruta simulada: " + metodo + " " + ruta });
}

module.exports = { responder, PRESCRITAS };
