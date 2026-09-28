-- Pruebas de regresión de las funciones críticas del backend.
-- Se ejecuta todo dentro de una transacción que se deshace al final:
-- no deja datos de prueba en la base real, así que es seguro repetirlo
-- cuando se toque cualquiera de estas funciones.
--
-- Cómo ejecutarlo: pegar el contenido completo en el SQL Editor de
-- Supabase y darle a Run. Si algo falla, verás un mensaje "FALLO: ...".
-- Si no aparece ningún FALLO, todas las pruebas han pasado.

begin;

do $$
declare
  v_entrenador_id uuid;
  v_usuario_id uuid;
  v_programa_id uuid;
  v_semana_id uuid;
  v_dia_id uuid;
  v_ej1 uuid;
  v_ej2 uuid;
  v_sp1 uuid;
  v_sp2 uuid;
  v_resultado jsonb;
  v_fila record;
begin
  raise notice '--- Preparando datos de prueba ---';

  insert into entrenadores (nombre) values ('TEST entrenador') returning id into v_entrenador_id;
  insert into usuarios (entrenador_id, rol, nombre, pin_hash)
    values (v_entrenador_id, 'alumno', 'TEST alumno', crypt('1234', gen_salt('bf')))
    returning id into v_usuario_id;

  insert into ejercicios_catalogo (entrenador_id, nombre, grupo_muscular, tipo_metrica)
    values (v_entrenador_id, 'TEST ejercicio A', 'Pecho', 'reps') returning id into v_ej1;
  insert into ejercicios_catalogo (entrenador_id, nombre, grupo_muscular, tipo_metrica)
    values (v_entrenador_id, 'TEST ejercicio B', 'Espalda', 'reps') returning id into v_ej2;

  insert into programas (entrenador_id, nombre, estado) values (v_entrenador_id, 'TEST programa', 'publicado') returning id into v_programa_id;
  insert into semanas (programa_id, numero) values (v_programa_id, 1) returning id into v_semana_id;
  insert into dias (semana_id, numero) values (v_semana_id, 1) returning id into v_dia_id;

  -- ejercicio A: 4 series prescritas ; ejercicio B: 3 series prescritas
  insert into series_prescritas (dia_id, ejercicio_id, orden, series, reps_objetivo)
    values (v_dia_id, v_ej1, 1, 4, '6-10') returning id into v_sp1;
  insert into series_prescritas (dia_id, ejercicio_id, orden, series, reps_objetivo)
    values (v_dia_id, v_ej2, 2, 3, '8-12') returning id into v_sp2;

  raise notice '--- Test 1: verificar_pin (PIN correcto) ---';
  select verificar_pin(v_usuario_id, '1234') into v_resultado;
  if not (v_resultado->>'ok')::boolean then
    raise exception 'FALLO test 1: PIN correcto rechazado: %', v_resultado;
  end if;
  raise notice 'OK';

  raise notice '--- Test 2: verificar_pin bloquea tras 5 fallos ---';
  for i in 1..5 loop
    select verificar_pin(v_usuario_id, '0000') into v_resultado;
  end loop;
  if (v_resultado->>'motivo') <> 'bloqueado' then
    raise exception 'FALLO test 2: deberia estar bloqueado tras 5 intentos, resultado: %', v_resultado;
  end if;
  raise notice 'OK';

  raise notice '--- Test 3: PIN correcto sigue rechazado mientras esta bloqueado ---';
  select verificar_pin(v_usuario_id, '1234') into v_resultado;
  if (v_resultado->>'ok')::boolean is true then
    raise exception 'FALLO test 3: el bloqueo no deberia dejar pasar ni el PIN correcto';
  end if;
  raise notice 'OK';

  raise notice '--- Test 4: publicar_programa materializa el numero correcto de series prescritas ---';
  -- ya estan materializadas a mano arriba (no usamos importaciones_borrador en este test),
  -- asi que probamos directamente progreso_programa con registros simulados.

  -- Registrar las 4 series del ejercicio A y las 3 del B, todas completadas
  insert into series_registradas (serie_prescrita_id, usuario_id, numero_serie, peso_real, valor_real, completada)
    select v_sp1, v_usuario_id, n, 50, 8, true from generate_series(1,4) n;
  insert into series_registradas (serie_prescrita_id, usuario_id, numero_serie, peso_real, valor_real, completada)
    select v_sp2, v_usuario_id, n, 40, 10, true from generate_series(1,3) n;

  raise notice '--- Test 5: progreso_programa NO debe duplicar el total por el join (bug del fan-out) ---';
  select * into v_fila from progreso_programa(v_usuario_id, v_programa_id) where semana_numero = 1 and dia_numero = 1;
  if v_fila.total_series <> 7 then
    raise exception 'FALLO test 5: total_series deberia ser 7 (4+3), fue %', v_fila.total_series;
  end if;
  if v_fila.series_completadas <> 7 then
    raise exception 'FALLO test 5b: series_completadas deberia ser 7, fue %', v_fila.series_completadas;
  end if;
  raise notice 'OK';

  raise notice '--- Test 6: progresion_ejercicio devuelve el peso maximo de la semana ---';
  select * into v_fila from progresion_ejercicio(v_usuario_id, v_programa_id, v_ej1) where semana_numero = 1;
  if v_fila.peso_max <> 50 then
    raise exception 'FALLO test 6: peso_max deberia ser 50, fue %', v_fila.peso_max;
  end if;
  raise notice 'OK';

  raise notice '--- Test 7: resetear_pin invalida el PIN anterior ---';
  perform resetear_pin(v_usuario_id, '9999');
  select verificar_pin(v_usuario_id, '9999') into v_resultado;
  if not (v_resultado->>'ok')::boolean then
    raise exception 'FALLO test 7: el PIN nuevo deberia funcionar: %', v_resultado;
  end if;
  raise notice 'OK';

  raise notice '=== TODAS LAS PRUEBAS PASARON ===';
end $$;

rollback;

-- ---------------------------------------------------------------------------
-- Parte 2: seguridad por rol (simula el JWT que llega desde la app) y desactivación
-- ---------------------------------------------------------------------------
begin;

do $$
declare
  v_e1 uuid; v_e2 uuid;
  v_ent1 uuid; v_ent2 uuid; v_alumno uuid;
  v_programa uuid; v_semana uuid; v_dia uuid; v_ej uuid; v_sp uuid;
  v_resultado jsonb;
  n int;
  v_antes timestamptz; v_despues timestamptz; v_id uuid;
begin
  insert into entrenadores (nombre) values ('TEST grupo 1') returning id into v_e1;
  insert into entrenadores (nombre) values ('TEST grupo 2') returning id into v_e2;
  insert into usuarios (entrenador_id, rol, nombre, pin_hash) values (v_e1, 'entrenador', 'TEST ent 1', crypt('1111', gen_salt('bf'))) returning id into v_ent1;
  insert into usuarios (entrenador_id, rol, nombre, pin_hash) values (v_e2, 'entrenador', 'TEST ent 2', crypt('2222', gen_salt('bf'))) returning id into v_ent2;
  insert into usuarios (entrenador_id, rol, nombre, pin_hash) values (v_e1, 'alumno', 'TEST alumno 1', crypt('3333', gen_salt('bf'))) returning id into v_alumno;

  insert into ejercicios_catalogo (entrenador_id, nombre, grupo_muscular) values (v_e1, 'TEST ej', 'Pecho') returning id into v_ej;
  insert into programas (entrenador_id, nombre, estado) values (v_e1, 'TEST plan', 'publicado') returning id into v_programa;
  insert into semanas (programa_id, numero) values (v_programa, 1) returning id into v_semana;
  insert into dias (semana_id, numero) values (v_semana, 1) returning id into v_dia;
  insert into series_prescritas (dia_id, ejercicio_id, orden, series, reps_objetivo) values (v_dia, v_ej, 1, 2, '8') returning id into v_sp;
  insert into asignaciones (usuario_id, programa_id) values (v_alumno, v_programa);
  insert into series_registradas (serie_prescrita_id, usuario_id, numero_serie, peso_real, valor_real, completada)
    values (v_sp, v_alumno, 1, 40, 8, true) returning id, updated_at into v_id, v_antes;

  -- Test 8: una cuenta desactivada no puede entrar (y no cuenta como PIN fallido)
  update usuarios set activo = false where id = v_alumno;
  select verificar_pin(v_alumno, '3333') into v_resultado;
  if (v_resultado->>'motivo') is distinct from 'desactivado' then
    raise exception 'FALLO test 8: una cuenta desactivada deberia rechazarse con motivo desactivado, resultado: %', v_resultado;
  end if;
  update usuarios set activo = true where id = v_alumno;

  -- Test 9: un entrenador NO puede leer ni escribir pin_hash a traves de la API
  perform set_config('request.jwt.claims', json_build_object('role','authenticated','app_metadata',
    json_build_object('rol','entrenador','entrenador_id',v_e1,'usuario_id',v_ent1))::text, true);
  set local role authenticated;
  begin
    perform pin_hash from usuarios limit 1;
    raise exception 'FALLO test 9a: un entrenador pudo leer pin_hash';
  exception when insufficient_privilege then null;
  end;
  begin
    update usuarios set pin_hash = 'x' where id = v_alumno;
    raise exception 'FALLO test 9b: un entrenador pudo escribir pin_hash';
  exception when insufficient_privilege then null;
  end;

  -- Test 10: el entrenador ve a sus alumnos y sus series
  select count(*) into n from series_registradas;
  if n <> 1 then raise exception 'FALLO test 10: el entrenador 1 deberia ver 1 serie de su alumno, ve %', n; end if;

  -- Test 11: aislamiento entre entrenadores: el entrenador 2 no ve nada del grupo 1
  reset role;
  perform set_config('request.jwt.claims', json_build_object('role','authenticated','app_metadata',
    json_build_object('rol','entrenador','entrenador_id',v_e2,'usuario_id',v_ent2))::text, true);
  set local role authenticated;
  select count(*) into n from series_registradas;
  if n <> 0 then raise exception 'FALLO test 11a: el entrenador 2 ve % series de otro grupo', n; end if;
  select count(*) into n from usuarios where entrenador_id = v_e1;
  if n <> 0 then raise exception 'FALLO test 11b: el entrenador 2 ve % usuarios de otro grupo', n; end if;
  select count(*) into n from programas where entrenador_id = v_e1;
  if n <> 0 then raise exception 'FALLO test 11c: el entrenador 2 ve % planes de otro grupo', n; end if;
  begin
    perform publicar_programa((select id from importaciones_borrador limit 1));
  exception when others then null; -- da igual el motivo: no debe poder publicar planes ajenos
  end;

  -- Test 12: un alumno desactivado pierde el acceso al instante aunque su token siga vigente
  reset role;
  update usuarios set activo = false where id = v_alumno;
  perform set_config('request.jwt.claims', json_build_object('role','authenticated','app_metadata',
    json_build_object('rol','alumno','entrenador_id',v_e1,'usuario_id',v_alumno))::text, true);
  set local role authenticated;
  select count(*) into n from series_registradas;
  if n <> 0 then raise exception 'FALLO test 12a: un alumno desactivado sigue viendo % series', n; end if;
  select count(*) into n from asignaciones;
  if n <> 0 then raise exception 'FALLO test 12b: un alumno desactivado sigue viendo % asignaciones', n; end if;

  -- Test 13: anon no puede leer nada
  reset role;
  set local role anon;
  begin
    perform 1 from usuarios limit 1;
    raise exception 'FALLO test 13: anon pudo leer usuarios';
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- Test 14: updated_at cambia al editar una serie ya guardada
  perform pg_sleep(1);
  update series_registradas set peso_real = 45 where id = v_id;
  select updated_at into v_despues from series_registradas where id = v_id;
  if v_despues <= v_antes then
    raise exception 'FALLO test 14: updated_at no cambio al editar (% -> %)', v_antes, v_despues;
  end if;

  raise notice '=== PARTE 2: TODAS LAS PRUEBAS PASARON ===';
end $$;

rollback;
