# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado semántico.

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
