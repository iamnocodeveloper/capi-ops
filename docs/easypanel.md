# Monitoreo del panel EasyPanel

capi-ops puede vigilar el **mismo EasyPanel donde corre**, sin Prometheus, sin agentes y sin un segundo
bot de Telegram. Esta guía cubre qué mide, cómo se habilita, qué comandos expone y qué límites tiene.

- **No instala nada:** usa la API REST del panel (`/api/<procedimiento>`) con un token de usuario.
- **Un solo bot:** las alertas llegan al mismo chat y con el prefijo `EasyPanel · cliente/servicio`.
- **Sin Prometheus:** las métricas salen de `getLegacyMonitorSystemStats`, `getDockerTaskStats` y
  `getMonitorTableData`. `getAllServicesStats` (Prometheus) no se usa.

## Habilitación

1. En EasyPanel → **Settings → API tokens** (o `POST /api/users/generateApiToken`), generá un token.
2. Cargá en el servicio `capi-ops`:

   | Variable | Para qué | Default |
   |---|---|---|
   | `EASYPANEL_URL` | Base del panel, sin `/api` | — |
   | `EASYPANEL_TOKEN` | Token de API | — |
   | `EASYPANEL_ALIAS` | Alias corto en métricas y claves | `ep` |
   | `EASYPANEL_NAME` | Nombre visible en alertas | `EasyPanel` |
   | `EASYPANEL_IP` | IP/host para las alertas | host de la URL |
   | `EASYPANEL_HTTP` | Chequear dominios por HTTP | `true` |
   | `EP_SERVICE_CPU` | Umbral de CPU por servicio (%) | `90` |

3. Recreá el servicio (ver [`operacion.md`](./operacion.md)) porque el restart simple no toma el env.
4. Verificá que `/health` incluya el bloque `easyPanel` y que el bot responda `/ep`.

Sin `EASYPANEL_URL` o `EASYPANEL_TOKEN` el resto del watcher funciona exactamente igual.

## Qué mide

| Capa | Procedimiento | Qué aporta |
|---|---|---|
| Host | `getLegacyMonitorSystemStats` | CPU %, memoria %, disco %, GB usados/totales, load1, cores, uptime |
| Contenedores | `getDockerTaskStats` | `actual`/`desired` por servicio (`proyecto_servicio`) |
| Recursos por servicio | `getMonitorTableData` | CPU y memoria agregadas por `projectName` + `serviceName` |
| Inventario | `listProjectsAndServices` | Proyectos, servicios, tipo (`app`, `compose`, `postgres`, …) y dominio primario |
| Dominios | `listDomains?projectName=…` | Host, HTTPS y path de cada servicio |
| Update | `getUpdateStatus` | Si hay versión nueva de EasyPanel y cuál |
| HTTP | `GET https://<host><path>` | Salud real de cada dominio |

Los dominios se consultan con concurrencia 8 y timeout de 8 s. Una respuesta **< 500 cuenta como vivo**
(401/403/404 incluidos): el objetivo es detectar caídas, no validar contenido.

## Estados de un servicio

| Condición | Estado | Qué significa |
|---|---|---|
| `desired > 0` y `actual >= desired` | `up` | Corre la cantidad esperada de contenedores |
| `desired > 0` y `actual < desired` | `down` | Falta al menos un contenedor |
| `desired === 0` | `off` | Detenido a propósito; no se alerta ni se chequea HTTP |
| Sin datos de task ni de contenedor | `unknown` | Se chequea HTTP si tiene dominio, pero no se alerta por contenedores |

**Caso Compose:** los stacks Compose no siempre aparecen en `getDockerTaskStats`. Si hay métricas de
contenedores para ese servicio, el snapshot lo infiere como `1/1` y lo marca `up`. Ese fue el caso de
`clientes/insforge-medico`.

## Reglas y claves de incidente

Todas las claves empiezan con `ep:<alias>:` para no colisionar con la flota Coolify (`srv:`).

| Clave | Severidad | Condición |
|---|---|---|
| `ep:<alias>:host:down` | crítica | La API del panel no responde |
| `ep:<alias>:host:cpu` | alta | CPU del host ≥ `TH_CPU` |
| `ep:<alias>:host:mem` | alta | Memoria ≥ `TH_MEM` |
| `ep:<alias>:host:disk` | alta/crítica | Disco ≥ `TH_DISK_WARN` / `TH_DISK_CRIT` |
| `ep:<alias>:host:load` | media | load1 > `LOAD1_THRESHOLD` (default 8) |
| `ep:<alias>:update` | media | `getUpdateStatus.available === true` |
| `ep:<alias>:svc:<proyecto>_<servicio>:down` | alta | `actual < desired` |
| `ep:<alias>:svc:<proyecto>_<servicio>:http` | alta | El dominio devuelve 5xx o no responde |
| `ep:<alias>:svc:<proyecto>_<servicio>:cpu` | media | CPU del servicio ≥ `EP_SERVICE_CPU` |

Los títulos usan el formato `EasyPanel · <proyecto>/<servicio> caído` y el detalle incluye cliente,
tipo, dominio y contenedores `actual/desired`.

La alerta de update se re-notifica con el cooldown global (`RENOTIFY_MINUTES`, 6 h por defecto) hasta
que se actualice el panel.

## Comandos

| Comando | Qué hace |
|---|---|
| `/ep` | Host, servicios caídos y actualización pendiente |
| `/eps [texto]` | Tabla de servicios con estado, CPU, memoria, HTTP y dominio |
| `/epserv <cliente/servicio>` | Detalle de un servicio |
| `/epdeploy <cliente/servicio>` | Deploy con confirmación |
| `/eprestart <cliente/servicio>` | Restart con confirmación |
| `/epstop <cliente/servicio>` | Stop con confirmación |
| `/epstart <cliente/servicio>` | Start con confirmación |

`/estado` agrega el bloque de EasyPanel y el digest diario incluye CPU, memoria, disco, servicios up y
update pendiente. Las acciones respetan `OPS_READ_ONLY` y quedan auditadas con usuario y resultado.

## Acciones y endpoints

La API REST usa rutas **planas**: `/api/<procedimiento>`, no las rutas de navegación de la
documentación (`/api/services/app/...` devuelve 404).

| Acción | App | Compose |
|---|---|---|
| deploy | `deployAppService` | `deployComposeService` |
| restart | `restartAppService` | `restartComposeService` |
| stop | `stopAppService` | `stopComposeService` |
| start | `startAppService` | `startComposeService` |

Servicios de tipo `postgres`, `mysql`, `redis`, etc. no están soportados por estas acciones: el bot
devuelve un error explícito en vez de intentarlo.

## Límites conocidos

- **Deploy individual:** no se avisa cada deploy. Detectarlo requiere comparar el commit desplegado
  contra el anterior; queda como mejora opcional.
- **Host caído:** si el servidor entero se cae, capi-ops también (vive ahí). Configurá `HEARTBEAT_URL`
  (healthchecks.io o similar) para el aviso externo.
- **Prometheus:** si algún día se habilita en EasyPanel, `getAllServicesStats` y `getMetricsSystemStats`
  permiten histórico nativo. Hoy no hace falta.
- **Licencia:** las notificaciones nativas de EasyPanel (`appDeploy`, `diskLoad`, `databaseBackup`,
  `dockerCleanup`, `updateAvailable`) requieren licencia. Este adaptador no las necesita.
- **SQLite:** si hay que recrear el servicio (bug de EasyPanel, ver [`operacion.md`](./operacion.md)),
  se pierde el SQLite local. El histórico en Postgres no se toca y el inventario se reconstruye.

## Verificación

```bash
curl -s http://<host>:18080/health   | jq '.easyPanel'
curl -s http://<host>:18080/metrics  | grep easypanel
```

En Telegram: `/ep`, `/eps`, `/epserv clientes/feroz-landing`.

## Troubleshooting

| Síntoma | Causa probable | Solución |
|---|---|---|
| `/health` muestra `easyPanel: null` | Faltan `EASYPANEL_URL`/`EASYPANEL_TOKEN` o no se recreó el servicio | Cargar variables y recrear |
| `reachable: false` con HTTP 401 | Token revocado o mal copiado | Generar uno nuevo y actualizar `EASYPANEL_TOKEN` |
| Servicios Compose en `off` | No aparecen en `getDockerTaskStats` y no hay métricas | Verificar que `getMonitorTableData` devuelva sus contenedores |
| Un dominio da 5xx pero el contenedor está `up` | La app arrancó pero no responde | Revisar logs del servicio en EasyPanel |
| No llegan alertas | Chat/usuario fuera de la allowlist o `OPS_READ_ONLY` | Ver logs y `/auditoria` |
