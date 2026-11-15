# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado semántico.

## [0.9.0] — 2026-11-15

### Agregado
- **Retención automática del histórico Postgres**: purga al arrancar y luego cada 24 h. Muestras y
  chequeos a los 30 días, incidentes **resueltos** a los 180 y acciones al año. Los incidentes abiertos
  nunca se borran. Configurable con `RETENTION_*`: `0` días desactiva una tabla y
  `RETENTION_ENABLED=false` apaga todo el mecanismo.
- Variables nuevas documentadas en `.env.example` y README.

## [0.8.0] — 2026-11-15

### Agregado
- **Incidente `ops:telegram`**: si el polling se detiene o hay envíos fallidos repetidos, se abre un
  incidente crítico que se cierra solo cuando Telegram vuelve a entregar.
- `GET /health` expone `telegramStatus` (polling, último error, fallos consecutivos, último envío OK).
- Menú de comandos nativo en Telegram vía `setMyCommands` al arrancar.
- Tests unitarios con `node:test`: `rules`, `incidents` y `time` (29 casos). `npm test` y `npm run check`.
- CI ejecuta `npm test` además de typecheck y build.
- Documentación: [`docs/MEMORIA-PROYECTO.md`](./docs/MEMORIA-PROYECTO.md),
  [`docs/AVANCES.md`](./docs/AVANCES.md) y [`docs/CAMBIOS-2026-11-15.md`](./docs/CAMBIOS-2026-11-15.md).

### Corregido
- **Crash loop con token de Telegram inválido.** `bot.start()` captura el rechazo; se agregan handlers
  de `unhandledRejection` y `uncaughtException`, y `main()` con `.catch`. Un fallo de Telegram ya no
  termina el proceso: el watcher sigue vivo en modo degradado.
- Reconexión a un bot nuevo (`@nocodeops_bot`) y corrección de la allowlist con el `chat_id` real.

### Notas
- Integrado con `origin/main` (feature de *provision* por SSH) y desplegado el 2026-11-15 en el commit
  `32be1e2`. Detalle en `docs/CAMBIOS-2026-11-15.md`.
- `/health` y `/metrics` siguen sin autenticación y publicados en el puerto del host.

## [0.7.0] — 2026-11-03

### Agregado
- **Diagnóstico de sesiones WAHA desde Telegram** con ventana horaria real
  (`docker logs -t --since/--until` por SSH de solo lectura).
- Comandos nuevos: `/diag` (motivo exacto de un `FAILED` con evidencia), `/fallidas` (barrido de la
  flota), `/sesiones` (teléfono, presencia, actividad y proxy por sesión), `/historial` (logouts con
  fecha y motivo), `/red` (IP de salida y proxy por contenedor/sesión) y `/oficinas`.
- `/logs` acepta ventana (`desde..hasta`) y timestamps en hora local.
- `/waha` muestra tabla de sesiones con teléfono, presencia, actividad y proxy.
- Mapeo oficina → servidor/instancia por `config/oficinas.json` u `OFFICES_JSON`.
- `scripts/diag-session.ts` (`npm run diag`) para el mismo diagnóstico por consola.

### Notas
- Sin `ssh` configurado por servidor, los comandos degradan a estado + últimas líneas del MCP.
- `DIAG_SSH=false` desactiva todo el diagnóstico SSH.
- El historial depende de la retención de logs de Docker (~5 días); no se agregan webhooks.

## [0.6.0] — 2026-10-31

### Agregado
- **Monitoreo del propio EasyPanel** (`EASYPANEL_URL` + `EASYPANEL_TOKEN`), sin Prometheus ni agentes:
  CPU, memoria, disco, load y uptime del host vía `getLegacyMonitorSystemStats`.
- Servicios: contenedores `actual/desired` (`getDockerTaskStats`), CPU y memoria por servicio
  (`getMonitorTableData`), estado `up`/`caído`/`off`.
- Caídas HTTP por dominio (`listDomains` + chequeo real): un 5xx o timeout abre incidente; 401/403/404
  cuentan como vivo.
- Aviso de actualización de EasyPanel (`getUpdateStatus`) con la versión disponible.
- Comandos nuevos en el mismo bot: `/ep`, `/eps`, `/epserv`, `/epdeploy`, `/eprestart`, `/epstop`,
  `/epstart` (estas cuatro con confirmación y auditoría).
- `/estado`, el digest diario, `/health` y `/metrics` incluyen el panel; las muestras del host se
  escriben en el histórico con el alias configurado.
- Alertas etiquetadas por origen: `EasyPanel · cliente/servicio`, separadas de la flota Coolify.
- Documentación: [`docs/easypanel.md`](./docs/easypanel.md) con endpoints, estados, reglas, comandos y
  troubleshooting; runbook y traspaso actualizados.

### Notas de producción
- El deploy de EasyPanel construyó la imagen pero no recreó el contenedor (`forceRebuild`, `restart`,
  webhook y scale a 0 fueron no-op). Se aplicó el workaround documentado **destroy + create**.
- Consecuencia: se reinició el SQLite local (incidentes abiertos, métricas, auditoría). El histórico
  en Postgres quedó intacto. Ver [`docs/operacion.md`](./docs/operacion.md).

## [0.5.0] — 2026-10-29

### Agregado
- [`docs/RETOMAR.md`](./docs/RETOMAR.md): documento de traspaso con estado, verificación en cinco
  minutos, decisiones, pendientes priorizados y reglas de oro.
- Sección de operación de la base histórica en [`docs/operacion.md`](./docs/operacion.md): verificación,
  backup con `pg_dump` y consultas de retención.

### Cierre de etapa
- Servicio en producción con Telegram activo, histórico escribiendo y notificaciones nativas en todos
  los paneles.
- Pendientes documentados y priorizados; nada queda a medias sin registro.

## [0.4.0] — 2026-10-29

### Agregado
- Histórico en **Postgres** (`DATABASE_URL`): `server_samples`, `waha_checks`, `incidents`, `actions`,
  `inventory` y `servers`. Si la variable no está, el servicio arranca igual y opera solo con SQLite.
- `GET /stats?days=N` y comando `/stats [días]` en Telegram: uptime por servidor, disponibilidad de
  las instancias, alertas más frecuentes y acciones del período.
- Las acciones del bot se auditan también en Postgres.

## [0.3.0] — 2026-10-29

### Agregado
- Guía [`docs/higiene-disco.md`](./docs/higiene-disco.md): qué ocupa disco en un host Coolify+WAHA,
  diagnóstico, limpieza de host y procedimiento de purga del store con rollback.
- Herramientas: `scripts/diag-disco.sh`, `scripts/inspect-store.js`, `scripts/purgar-store.js`.
- Docker Cleanup configurado en los servidores vía MCP (diario, umbral 70%, volúmenes protegidos).

### Corregido
- Documentado que el media de WAHA **no** se acumula: sin `WHATSAPP_FILES_FOLDER` se borra a los 180 s.

### Notas
- El store de GOWS no tiene retención configurable; se controla con `config.gows.storage.*` por sesión.
- Regla de alcance incorporada: no se toca ninguna sesión que no esté explícitamente nombrada.

## [0.2.0] — 2026-10-29

### Agregado
- Comando `/instancias [srv]`: inventario WAHA por servidor con estado del contenedor, salud web y
  dominio; sin argumento recorre todos los servidores.
- Script `scripts/send-inventory.mjs` para mandar el inventario completo al chat.
- Documentación: `README.md` con badges y tablas, `docs/arquitectura.md`, `docs/operacion.md`,
  `.github/workflows/ci.yml`.
- Metadatos del repo en GitHub: descripción, homepage y topics.

### Corregido
- `get_server_metrics` podía devolver vacío aunque las métricas estuvieran habilitadas: se resolvió
  reiniciando el contenedor de Sentinel.

## [0.1.0] — 2026-10-29

### Agregado
- Watcher multi-Coolify por MCP: métricas, apps, deploys y unhealthy por servidor.
- Health de instancias WAHA por HTTPS con clasificación de fallas (HTTP vs DNS).
- Motor de incidentes con deduplicación, cooldown, recuperación y horario silencioso.
- Anomalías por z-score contra línea base de 7 días.
- Digest diario y heartbeat externo opcional.
- Bot de Telegram: consultas, `/instalar waha`, deploy/restart/stop/delete con confirmación,
  modo solo-lectura y auditoría en SQLite.
- `POST /intent` como hook para un front LLM.
- Deploy en EasyPanel con volumen persistente.
