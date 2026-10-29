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

## Deploy

```bash
# 1. subir el código
git add -A; git commit -m "..." ; git push origin main

# 2. desde Command Code, contra el MCP de EasyPanel
execute_destructive → deployAppService {
  projectName: "<proyecto>", serviceName: "capi-ops", forceRebuild: true
}
```

**Verificar que realmente se aplicó:** mirar `uptimeSeconds` en `/health`. Si sigue alto, el deploy no
recreó el contenedor.

### Si el deploy no recrea el contenedor

En EasyPanel pasa seguido: `deployAppService` responde OK y no cambia nada. Workaround que funciona
siempre:

```powershell
execute_destructive → destroyAppService    { projectName, serviceName }
execute_mutation    → createAppService     { ...mismo env, git source, volumen /data, puerto 18080 }
```

Al recrear se pierde el SQLite (incidentes, métricas, auditoría). El inventario y la numeración se
reconstruyen solos en el primer ciclo.

## Verificación rápida

```powershell
Invoke-RestMethod http://<host>:18080/health | ConvertTo-Json -Depth 4
Invoke-WebRequest  http://<host>:18080/metrics | Select-Object -Expand Content
```

En Telegram: `/estado`, `/instancias 4`, `/incidentes`, `/auditoria`.

## Cambiar la configuración

Las variables viven en el servicio de EasyPanel. Flujo recomendado:

1. `execute_destructive → updateAppEnv` con el `.env` completo (reemplaza, no mergea).
2. Recrear el servicio (ver arriba) porque el restart simple no toma el env nuevo.

La flota se pasa en `SERVERS_JSON` (JSON inline). Si se prefiere archivo, montar `config/servers.json`
como volumen y apuntar `SERVERS_FILE`.

Variables más usadas: `OPS_READ_ONLY` (kill switch), `TG_ALLOWED_CHATS/USERS`, `QUIET_HOURS`,
`TH_*`, `HEARTBEAT_URL`.

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
