# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado semántico.

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
