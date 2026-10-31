# Arquitectura

## Por qué existe

La flota son varios paneles Coolify independientes, cada uno con sus instancias de WAHA. Coolify ya
resuelve el ciclo de vida, pero no avisa de CPU/memoria, no conoce el estado real de las sesiones de
WhatsApp y no permite operar desde el celular. capi-ops cubre ese hueco sin reemplazar a Coolify.

Además vigila **el propio EasyPanel donde corre**: host, servicios, dominios y actualizaciones, sin
Prometheus ni agentes. Eso se agregó en 0.6.0; el detalle está en [`easypanel.md`](./easypanel.md).

## Decisiones

| Decisión | Alternativa descartada | Motivo |
|---|---|---|
| Servicio propio en Node | Hermes Agent / agente LLM | Las acciones de infraestructura tienen que ser deterministas y auditables; un LLM agrega costo por mensaje y no-determinismo |
| Correr en EasyPanel, fuera de la flota | Una app dentro de uno de los Coolify | Si el watcher vive en el servidor que monitorea, cuando ese servidor cae también cae el alertador |
| MCP en vez de REST directa | API v1 de Coolify | El MCP expone las mismas rutas con permisos ya resueltos por el token del team |
| SQLite embebido | Postgres/Redis | Un solo contenedor, sin dependencias; el volumen alcanza |
| Telegram en polling | Webhook | No requiere dominio, certificado ni ingress en el host de monitoreo |
| Health WAHA por HTTPS directo | Solo estado del contenedor | El contenedor puede estar `running` y la sesión caída |
| REST de EasyPanel | Stack Prometheus/Grafana | El panel ya expone host, contenedores y dominios; no hace falta instalar nada |
| Un solo bot para todo | Un bot por sistema | Menos tokens y chats; las alertas se distinguen por el prefijo `EasyPanel · …` |

## Flujo de un ciclo

```
cada POLL_SECONDS (60 s)
  ├─ refresh(): por cada servidor en config/servers.json
  │    ├─ get_server_metrics          (CPU, mem, disco, load, red)
  │    ├─ list_applications           (inventario + estado)
  │    ├─ list_deployments            (cola / en curso)
  │    └─ list_unhealthy_resources    (muestra)
  ├─ guarda muestras en `metrics`
  ├─ refreshEp() (si EASYPANEL_URL y EASYPANEL_TOKEN)
  │    ├─ getLegacyMonitorSystemStats   → CPU, mem, disco, load, uptime
  │    ├─ getDockerTaskStats           → actual/desired por servicio
  │    ├─ getMonitorTableData          → CPU y memoria por servicio
  │    ├─ listProjectsAndServices      → inventario y tipo
  │    ├─ listDomains                  → host y path por servicio
  │    └─ getUpdateStatus              → versión nueva disponible
  ├─ HTTP GET por dominio EasyPanel (concurrencia 8, timeout 8 s)
  ├─ si pasó WAHA_PROBE_SECONDS (300 s): health de cada dominio WAHA
  │    ├─ HTTPS /api/version            → httpOk, engine, version
  │    └─ si falla: DNS resolve4        → dnsOk, IPs resueltas
  ├─ evaluate(snapshot)  → hallazgos { key, severity, title, detail }
  ├─ evaluateEasyPanel(snapshot) → hallazgos `ep:*` (host, servicios, HTTP, update)
  ├─ AlertEngine.reconcile(hallazgos)
  │    ├─ nuevo            → INSERT incidente + notificar
  │    ├─ vigente          → re-notificar solo si pasó el cooldown o cambió la severidad
  │    └─ ya no aparece    → resolver + notificar recuperación
  ├─ heartbeat (si HEARTBEAT_URL)
  └─ digest diario (si DIGEST_AT y no se envió hoy)
```

## Módulos

| Archivo | Responsabilidad | Notas |
|---|---|---|
| `config.ts` | Carga `.env` y `config/servers.json` con zod | `tokenEnv` evita secretos en el repo |
| `mcp.ts` | Cliente JSON-RPC (initialize + tools/call) | Cachea la sesión por servidor y la reinicia si falla |
| `probe.ts` | Normaliza la respuesta de cada tool a `ServerSnapshot` | Tolera shapes distintos entre versiones |
| `waha.ts` | DNS + `/api/version` + `/api/sessions` | Cache 60 s, watchdog de 12 s y concurrencia limitada |
| `easypanel.ts` | Cliente REST del panel propio y normalización a `EpSnapshot` | Host, servicios, dominios y updates sin Prometheus |
| `rules.ts` | Funciones puras: snapshot → hallazgos | Sin estado, fácil de testear |
| `incidents.ts` | Máquina de estados y política de notificación | Horario silencioso y cooldown viven acá |
| `installer.ts` | Numeración global, elección de servidor, deploy, verificación | Replica el procedimiento manual de la flota |
| `ops.ts` | Acciones puntuales sobre una app | Devuelve texto listo para el chat |
| `bot.ts` | Grammy, allowlist, confirmaciones, formato | El estado pendiente expira a los 5 min |
| `http.ts` | `/health`, `/metrics`, `/intent` | `node:http`, sin framework |
| `db.ts` | Esquema y consultas | `node:sqlite` sincrónico |

## Modelo de datos

```sql
servers(alias PK, name, url, ip, updated_at)
inventory(alias, app_uuid, name, fqdn, created_at)          -- PK (alias, app_uuid)
incidents(id, key, severity, title, detail,
          opened_at, last_notified_at, resolved_at)
metrics(alias, ts, cpu, mem_percent, disk_percent, load1)    -- retención 30 días
actions(id, ts, chat_id, user_id, command, args_json,
        result, ok, duration_ms)                             -- auditoría
settings(key, value)                                         -- last_waha_number, last_digest
```

`incidents.key` es estable (`srv:capi4:waha-dns`, `srv:capi1:cpu`, `ep:ep:svc:clientes_feroz-landing:down`)
y es lo que permite deduplicar: mientras el hallazgo siga apareciendo, el incidente sigue abierto.

## Monitoreo del panel propio

`easypanel.ts` es un cliente REST mínimo (`Authorization: Bearer`, rutas planas `/api/<procedimiento>`)
que arma un `EpSnapshot` por ciclo. Los stacks Compose que no aparecen en `getDockerTaskStats` se
infieren `up` a partir de sus métricas de contenedor; si no hay ninguna señal, el estado es `unknown`
y no se alerta por contenedores.

Los incidentes usan claves estables `ep:<alias>:host:<regla>` y `ep:<alias>:svc:<proyecto>_<servicio>:<regla>`.
Las muestras del host se guardan en `metrics` (SQLite) y `server_samples` (Postgres) con el alias
configurado (`ep` por defecto), así `/stats` y el digest las incluyen sin cambios.

## Anomalías

Además de los umbrales, cada muestra se compara contra la línea base de esa franja horaria (±3 h) de
los últimos 7 días. Si hay al menos 30 muestras y el desvío no es nulo, un z-score > 3 genera un
hallazgo `anomaly`. Para CPU se exige además un mínimo de 15% para evitar ruido en equipos ociosos.

## Puntos de extensión

- **Nuevo servidor**: una entrada en `config/servers.json` + su token en el entorno.
- **Nueva regla**: una función en `rules.ts` que devuelva `Finding[]`; el motor se encarga del resto.
- **Nuevo canal**: implementar un `Notifier` (hoy Telegram) y pasarlo al `AlertEngine`.
- **Lenguaje natural**: `POST /intent` ya traduce "instalá 2 waha" a un comando validado;
  el LLM solo propone, el servicio decide.
