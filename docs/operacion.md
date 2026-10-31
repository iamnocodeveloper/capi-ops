# Operación

Runbook de capi-ops. Los datos concretos de la infraestructura (IPs, tokens, UUIDs) viven en el
documento privado del cliente, no en este repo.

## Servicio desplegado

| Dato | Valor |
|---|---|
| Host | EasyPanel propio, independiente de los servidores monitoreados |
| Servicio | `capi-ops` (App con Dockerfile) |
| Puerto | `18080` del host → `8080` del contenedor |
| Health | `GET /health` |
| Métricas | `GET /metrics` (Prometheus) |
| Volumen | `data` → `/data` (SQLite) |
| Bot | `@capiops_bot` (polling, sin webhook) |
| Monitorea | flota Coolify (`capi1`–`capi4`) + el propio EasyPanel (`ep`) |
| Panel propio | `EASYPANEL_URL` + `EASYPANEL_TOKEN`; ver [`easypanel.md`](./easypanel.md) |

## Deploy

```bash
# 1. subir el código
git add -A; git commit -m "..." ; git push origin main

# 2. desde Command Code, contra el MCP de EasyPanel
execute_destructive → deployAppService {
  projectName: "<proyecto>", serviceName: "capi-ops", forceRebuild: true
}
```

Si el MCP devuelve `BAD_REQUEST`, usar la API directa con el token del panel:

```bash
curl -X POST "$EASYPANEL_URL/api/deployAppService" \
  -H "Authorization: Bearer $EASYPANEL_TOKEN" -H 'Content-Type: application/json' \
  -d '{"projectName":"joel","serviceName":"capi-ops","forceRebuild":true}'
```

**Verificar que realmente se aplicó:** mirar `uptimeSeconds` en `/health`. Si sigue alto, el deploy no
recreó el contenedor.

### Caso real: build OK, contenedor viejo (2026-10-31)

Al desplegar el monitoreo de EasyPanel pasó lo siguiente:

1. `git push` a `main` y `deployAppService` → acción `done`.
2. `inspectAppService` mostró el commit nuevo y el log de la acción mostró el **build completo**
   (`npm run build`, imagen `3f23fd…`).
3. Pero `/health` seguía con el `uptime` de 41 h y el mismo contenedor (`87c67f3c…`).
4. `forceRebuild: true`, `restartAppService`, el webhook de deploy y hasta
   `updateAppDeploy` con `replicas: 0` fueron **no-op**: la API respondía 200 y no pasaba nada.

Conclusión: en esta versión de EasyPanel el build funciona pero el update del servicio Swarm no se
aplica. El único workaround confiable es **destroy + create**.

### Recrear el servicio (workaround)

Se pierde el SQLite (`/data/state.sqlite`: incidentes abiertos, métricas locales y auditoría). El
histórico en Postgres **no se toca** y el inventario/numeración se reconstruyen en el primer ciclo.

Antes de destruir, capturar el env actual y volver a crear con la misma config:

```json
{
  "projectName": "joel",
  "serviceName": "capi-ops",
  "source": { "type": "git", "repo": "https://github.com/iamnocodeveloper/capi-ops.git", "ref": "main", "path": "/" },
  "build": { "type": "dockerfile", "file": "/Dockerfile" },
  "deploy": { "replicas": 1, "command": null, "zeroDowntime": true },
  "env": "<env completo del servicio>",
  "mounts": [{ "type": "volume", "name": "data", "mountPath": "/data" }],
  "ports": [{ "protocol": "tcp", "published": 18080, "target": 8080 }]
}
```

Pasos:

```bash
# 1. capturar el env
curl -s "$EASYPANEL_URL/api/inspectAppService?projectName=joel&serviceName=capi-ops" \
  -H "Authorization: Bearer $EASYPANEL_TOKEN" | jq -r '.env' > /tmp/capi-ops.env

# 2. destruir
curl -X POST "$EASYPANEL_URL/api/destroyAppService" \
  -H "Authorization: Bearer $EASYPANEL_TOKEN" -H 'Content-Type: application/json' \
  -d '{"projectName":"joel","serviceName":"capi-ops"}'

# 3. crear con el payload de arriba (env incluido)
curl -X POST "$EASYPANEL_URL/api/createAppService" \
  -H "Authorization: Bearer $EASYPANEL_TOKEN" -H 'Content-Type: application/json' \
  -d @payload.json

# 4. verificar
curl -s http://<host>:18080/health | jq '{uptimeSeconds, easyPanel}'
```

El `deployToken` del servicio cambia al recrearlo. No afecta a capi-ops porque la fuente es `git`
(sin webhook de GitHub); si algún día se usa auto-deploy, hay que actualizar el webhook.

Verificación esperada: `uptimeSeconds` bajo (contenedor nuevo) y `easyPanel` presente con
`services`, `down` y `updateAvailable`.

## Verificación rápida

```powershell
Invoke-RestMethod http://<host>:18080/health | ConvertTo-Json -Depth 4
Invoke-WebRequest  http://<host>:18080/metrics | Select-Object -Expand Content
```

Chequeos puntuales:

```bash
curl -s http://<host>:18080/health | jq '.easyPanel'
curl -s http://<host>:18080/metrics | grep easypanel
```

En Telegram: `/estado`, `/ep`, `/eps`, `/epserv <cliente/servicio>`, `/instancias 4`,
`/incidentes`, `/auditoria`.

## Cambiar la configuración

Las variables viven en el servicio de EasyPanel. Flujo recomendado:

1. Leer el env actual con `inspectAppService` (no imprimirlo en logs ni en el chat).
2. `execute_destructive → updateAppEnv` con el `.env` completo (reemplaza, no mergea). Verificar
   después que la cantidad de claves no bajó.
3. Recrear el servicio (ver arriba) porque el restart simple no toma el env nuevo.

La flota se pasa en `SERVERS_JSON` (JSON inline). Si se prefiere archivo, montar `config/servers.json`
como volumen y apuntar `SERVERS_FILE`.

Variables más usadas: `OPS_READ_ONLY` (kill switch), `TG_ALLOWED_CHATS/USERS`, `QUIET_HOURS`,
`TH_*`, `HEARTBEAT_URL`, `EASYPANEL_URL/TOKEN`, `EP_SERVICE_CPU`.

## Monitoreo del propio EasyPanel

El servicio se vigila a sí mismo (host, servicios, dominios y updates) usando la API REST del panel.
Se activa solo con `EASYPANEL_URL` y `EASYPANEL_TOKEN`.

- Detalle funcional, endpoints, estados, reglas y límites: [`easypanel.md`](./easypanel.md).
- Alertas con prefijo `EasyPanel · <cliente>/<servicio>` en el mismo chat.
- Comandos: `/ep`, `/eps`, `/epserv` y acciones `/epdeploy`, `/eprestart`, `/epstop`, `/epstart`.
- No requiere Prometheus ni un segundo bot.

Para rotar el token de EasyPanel: generar uno nuevo en **Settings → API tokens**, actualizar
`EASYPANEL_TOKEN` y recrear el servicio. Verificar `curl -s http://<host>:18080/health | jq '.easyPanel.reachable'`.

## Rotar un token de Coolify

**Cambiar la password de un usuario de Coolify revoca todos sus API tokens.** Si se resetea, hay que
crear uno nuevo y actualizar todo:

1. Crear token nuevo en el Coolify (`reset-usuario.php` o panel → Keys & Tokens).
2. Actualizar la variable `CAPIx_TOKEN` en el servicio.
3. Si la flota está en archivo, actualizar `config/servers.json`.
4. Actualizar el documento privado de credenciales.
5. Recrear el servicio y verificar en `/health` que ese servidor sigue `reachable`.

## Alta de un servidor nuevo

1. Registrar el MCP del Coolify en Command Code con bearer token.
2. Agregar la entrada a `SERVERS_JSON`: URL del MCP, `tokenEnv`, IP, `projectUuid`, `serverUuid`,
   `destinationUuid` y `wahaRange`.
3. Cargar `CAPIN_TOKEN` en el servicio.
4. Recrear el servicio. En el primer ciclo aparece en `/health` y `/estado`.

## Problemas típicos

| Síntoma | Causa probable | Solución |
|---|---|---|
| `cpu`/`mem` en `null` para un servidor | Sentinel sin recolectar | `docker restart coolify-sentinel` en ese servidor; `is_metrics_enabled` debe estar en `true` |
| `waha-dns` con varias instancias | Faltan registros A | Apuntar los dominios a la IP del servidor |
| Telegram deja de entregar | Token revocado o bot bloqueado | Probar `getMe`; regenerar token en BotFather y actualizar `TG_TOKEN` |
| El bot no responde a comandos | Chat/usuario fuera de la allowlist | Ver el log `ignorado chat=... user=...` y agregarlos |
| Incidentes que no se cierran | El hallazgo sigue presente | Revisar `detail` en `/incidentes`; el cierre es automático cuando desaparece |
| `POST /intent` devuelve 401 | Falta `x-ops-token` o `INTENT_TOKEN` vacío | Configurar el secreto en el servicio |
| `/health` con `easyPanel: null` | Faltan `EASYPANEL_URL`/`EASYPANEL_TOKEN` o no se recreó el servicio | Cargar variables y recrear |
| `easyPanel.reachable: false` | Token de EasyPanel revocado, mal copiado o panel caído | Probar `curl "$EASYPANEL_URL/api/getLegacyMonitorSystemStats" -H "Authorization: Bearer $EASYPANEL_TOKEN"` |
| Un servicio Compose aparece `off` | No está en `getDockerTaskStats` y no hay métricas de contenedor | Verificar `getMonitorTableData`; el adapter lo infiere `up` si hay stats |
| Un dominio da 5xx pero el contenedor está `up` | La app arrancó pero no responde | Revisar logs del servicio en EasyPanel |

## Logs

Si el host no tiene agregación de logs (Loki), los logs del contenedor solo se ven desde la UI del
servicio. El servicio escribe en stdout con nivel `LOG_LEVEL` (`debug` muestra cada ciclo).

## Respaldo del estado

El único estado propio es `/data/state.sqlite`. Se puede perder sin drama: incidentes y métricas se
regeneran y la numeración se recalcula desde las apps vivas. Para respaldarlo, copiar el volumen.

## Base del histórico (Postgres)

El servicio escribe en Postgres cuando existe `DATABASE_URL`. Si la base no está disponible, el
watcher y el bot siguen funcionando: solo se pierde el histórico (los inserts fallan en silencio).

**Verificar que escribe**

```sql
select 'server_samples' t, count(*) from server_samples
union all select 'waha_checks', count(*) from waha_checks
union all select 'incidents', count(*) from incidents
union all select 'actions', count(*) from actions;
```

**Backup**

```bash
docker exec <contenedor-postgres> pg_dump -U <usuario> -d <base> -Fc > backup-$(date +%F).dump
```

**Retención sugerida** (todavía no está automatizada)

```sql
-- muestras y chequeos: 30 días
delete from server_samples where ts < now() - interval '30 days';
delete from waha_checks   where ts < now() - interval '30 days';
-- incidentes: 180 días (los resueltos)
delete from incidents where resolved_at is not null and resolved_at < now() - interval '180 days';
-- acciones: 1 año
delete from actions where ts < now() - interval '365 days';
```

Correr una vez por semana desde una tarea programada del panel o desde `psql`. Sin retención, las dos
tablas de muestreo crecen del orden de miles de filas por día.

## Seguridad

- Allowlist por chat y usuario; el bot ignora y loguea cualquier otro origen.
- Las acciones destructivas piden botón de confirmación y, `delete`, además tipear `CONFIRMAR wahaNN`.
- `/health` y `/metrics` no piden auth. Si se publica el puerto, muestran IPs y consumo: cerrarlo si
  molesta (Telegram funciona por polling).
- Los tokens de Coolify viajan por HTTP plano hacia `:8000`. Mitigación recomendada: limitar ese
  puerto por firewall a la IP del host de monitoreo, o mover el MCP detrás de un túnel.
