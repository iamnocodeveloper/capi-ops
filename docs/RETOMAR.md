# Retomar el proyecto

> **Empezá por acá.** Este documento resume el proyecto y el estado en el que quedó, para que una
> conversación nueva pueda continuar sin reconstruir contexto.

Última actualización: 2026-10-31 · cierre de la etapa 0.6.0 (monitoreo del panel EasyPanel).

---

## 1. Qué es, en 30 segundos

`capi-ops` es un servicio en Node + TypeScript que **vigila paneles de Coolify con instancias de WAHA**
y **el propio EasyPanel donde corre**, avisa por Telegram cuando algo se rompe y **ejecuta acciones**
desde el chat (instalar instancias, desplegar, reiniciar, detener, borrar, ver logs).

- Habla con cada Coolify por **MCP** (Streamable HTTP, token por panel).
- Habla con EasyPanel por su **API REST** (`Authorization: Bearer`), sin Prometheus ni agentes.
- Mide disco, CPU y memoria; no reemplaza a Coolify, lo complementa.
- Guarda un **histórico en Postgres** para estadísticas de uptime y alertas.
- Sus decisiones son **reglas explícitas**, no un LLM: determinista y auditable.

Arquitectura y decisiones: [`arquitectura.md`](./arquitectura.md).

---

## 2. Estado actual

| Pieza | Estado |
|---|---|
| Servicio | corriendo en EasyPanel, contenedor `capi-ops`, puerto publicado `18080` |
| Salud | `GET /health` responde con el snapshot de la flota |
| Telegram | bot activo por polling, chat autorizado configurado |
| Histórico | Postgres en Coolify conectado, escribiendo muestras y chequeos |
| Notificaciones nativas | activas en todos los paneles (caídas, reinicios, disco, deploys) |
| Repo | público, CI en verde (typecheck + build en Node 24) |
| Docker Cleanup | configurado en todos los servidores (diario, umbral 70%) |
| EasyPanel | host, servicios, dominios y updates monitoreados desde el mismo servicio (alias `ep`) |
| Alertas EasyPanel | prefijo `EasyPanel · cliente/servicio`; update 2.37.0 pendiente |
| SQLite | recreado el 2026-10-31 por el bug de recreación de EasyPanel; Postgres intacto |

Los datos concretos —cuántos servidores, IPs, tokens, credenciales de la base— **no están en este
repo**: viven en el documento privado de la operación (`docs/coolify/servidores.md` del workspace).
Hay una copia de traspaso en [`docs/coolify/RETOMAR.md`].

---

## 3. Verificar en cinco minutos

```bash
# 1. el servicio está vivo y ve la flota
curl -s http://<host>:18080/health | jq

# 2. el histórico responde
curl -s "http://<host>:18080/stats?days=1" | jq '.uptime'

# 3. EasyPanel se ve a sí mismo
curl -s http://<host>:18080/health | jq '.easyPanel'
```

En Telegram: `/estado` (flota + EasyPanel), `/ep`, `/eps`, `/stats 1`.

```powershell
# 4. los MCP siguen registrados (paneles + EasyPanel)
cmdc mcp list
```

Si `/health` responde pero `stats` viene vacío, revisá `DATABASE_URL` en el env del servicio. Si no
responde nada, mirá el estado del servicio en EasyPanel (el workaround de recreación está en
[`operacion.md`](./operacion.md)).

---

## 4. Mapa de documentos

| Documento | Para qué sirve |
|---|---|
| [`README.md`](../README.md) | Qué hace, comandos, configuración, despliegue |
| [`arquitectura.md`](./arquitectura.md) | Módulos, flujo del ciclo, modelo de datos, decisiones y alternativas descartadas |
| [`operacion.md`](./operacion.md) | Runbook: deploy, workaround del redeploy, rotación de tokens, troubleshooting |
| [`easypanel.md`](./easypanel.md) | Monitoreo del panel propio: endpoints, estados, reglas, comandos y límites |
| [`higiene-disco.md`](./higiene-disco.md) | Qué ocupa disco en WAHA, diagnóstico, limpieza y purga del store con rollback |
| [`CHANGELOG.md`](../CHANGELOG.md) | Historial de versiones |
| `docs/coolify/` (privado) | Credenciales, inventario y traspaso con datos reales |

---

## 5. Cómo se opera

**Desplegar un cambio**

```bash
git push origin main
# y desde Command Code, contra el MCP de EasyPanel:
#   execute_destructive -> deployAppService { projectName, serviceName, forceRebuild: true }
```

Verificar que se aplicó mirando `uptimeSeconds` en `/health`. Si no baja, el deploy no recreó el
contenedor. El 2026-10-31 pasó incluso con `forceRebuild: true`: el build se ejecutó, pero el servicio
Swarm no se actualizó. `restart`, el webhook y `updateAppDeploy` con `replicas: 0` también fueron
no-op. El workaround que funciona siempre es **destroy + create** con el mismo env, git, volumen
`data:/data` y puerto `18080:8080`.

Impacto: se pierde el SQLite local (incidentes abiertos, métricas, auditoría); el histórico en Postgres
no se toca y el inventario/numeración se reconstruyen en el primer ciclo. El procedimiento completo,
con el payload y los comandos, está en [`operacion.md`](./operacion.md#recrear-el-servicio-workaround).

**Cambiar configuración**: leer el env actual, `updateAppEnv` con el `.env` completo (reemplaza, no
mergea), verificar que no se perdieron claves y recrear. Las variables están documentadas en el README
y en `.env.example`.

**Comandos del bot**: `/estado`, `/instancias [srv]`, `/salud`, `/waha`, `/logs`, `/buscar`,
`/incidentes`, `/stats [días]`, `/auditoria`, `/instalar waha [n] [srv]`, `/deploy`, `/restart`,
`/stop`, `/delete`, `/modo solo-lectura`.

**EasyPanel**: `/ep`, `/eps [texto]`, `/epserv <cliente/servicio>`, `/epdeploy`, `/eprestart`,
`/epstop`, `/epstart` (las cuatro acciones con confirmación y auditoría).

---

## 6. Decisiones que no conviene reabrir sin motivo

| Decisión | Por qué |
|---|---|
| Servicio propio en vez de un agente con LLM | Las acciones de infraestructura tienen que ser deterministas y auditables |
| Corre fuera de la flota monitoreada | Si vive en un servidor vigilado, cuando ese servidor cae también cae el alertador |
| MCP en vez de la API REST | Es la vía oficial de Coolify y ya resuelve permisos por token |
| SQLite operativo + Postgres histórico | El estado del día a día no necesita red; las estadísticas sí |
| Telegram por polling | Sin dominio, certificado ni ingress |
| REST de EasyPanel en vez de Prometheus | El panel ya expone host, servicios y dominios; no hay que instalar agentes |
| Un solo bot para flota y EasyPanel | Las alertas se distinguen por el prefijo `EasyPanel · cliente/servicio` |
| Comandos con confirmación | Un bot que borra contenedores necesita fricción |

---

## 7. Pendientes, en orden de valor

1. **`HEARTBEAT_URL`.** capi-ops corre en el mismo EasyPanel que vigila: si el host se cae, no puede
   avisar. Crear un check externo (healthchecks.io o similar), cargar la URL y recrear.
2. **Retención del histórico.** `server_samples` y `waha_checks` crecen a diario. Falta una purga
   programada (30 días para muestras y chequeos, más para incidentes y acciones). Las consultas están
   listas en [`operacion.md`](./operacion.md).
3. **Aviso por deploy de EasyPanel.** Hoy no se detecta cada deploy; se puede comparar el commit
   desplegado contra el anterior y emitir un hallazgo informativo.
4. **Comandos `/store`, `/purgar` y `/limpiar`.** El procedimiento está probado a mano y documentado
   en [`higiene-disco.md`](./higiene-disco.md); falta exponerlo en el bot usando `docker_cleanup` y
   `manage_scheduled_task` del MCP.
5. **Volumen para `/app/.sessions`.** Hoy un redeploy borra el store y obliga a re-escanear QR. Es una
   decisión de producto: con volumen, el pairing sobrevive pero la purga pasa a ser obligatoria.
6. **Alertas de sesión de WhatsApp.** El health actual mira HTTP y DNS; leer `/api/sessions` para
   detectar `FAILED` o sesiones caídas sería el siguiente salto de calidad.
7. **Autenticación en `/health` y `/metrics`.** Hoy no piden credenciales; si el puerto queda público,
   muestran IPs y consumo.

---

## 8. Reglas de oro

- **No tocar sesiones que no estén nombradas explícitamente.** El proyecto convive con sesiones de
  otros clientes en los mismos hosts.
- **Antes de purgar un store: backup y verificación de restauración.** El rollback está documentado.
- **`delete_unused_volumes` nunca en `true`** en el Docker Cleanup: puede borrar datos de otras apps.
- **Cambiar la password de un usuario de Coolify revoca sus tokens**; hay que crear uno nuevo.
- **Verificar `uptimeSeconds` después de cada deploy.** Si no baja, el contenedor no se recreó.
- **Destroy + create pierde el SQLite local**, nunca el histórico de Postgres. Documentar el cambio.
- **Rotar `EASYPANEL_TOKEN`** si se filtra; el token va en el env del servicio, nunca en el repo.
- **Editar `mcp.json` a mano solo en UTF-8 sin BOM**, o la CLI no lo lee.

---

## 9. Glosario mínimo

| Término | Qué es |
|---|---|
| **Coolify** | Panel de despliegue; cada servidor tiene el suyo |
| **MCP** | Protocolo con el que este servicio consulta y opera Coolify |
| **WAHA** | Gateway de WhatsApp sobre HTTP; cada instancia es un contenedor |
| **GOWS** | Motor de WAHA (Go). Guarda sesión y mensajes en `gows.db` |
| **Store** | Base SQLite de la sesión: mensajes, chats, contactos, claves |
| **Pairing** | Vínculo con el teléfono. Vive en las tablas de device/crypto del store |
| **Sentinel** | Agente de Coolify que reporta salud y disco |
| **Metrics** | Histórico de CPU/memoria que Coolify graba por servidor (requiere Sentinel) |
| **EasyPanel** | Panel donde corre capi-ops; se monitorea por su API REST |
| **API token** | Credencial de EasyPanel (`Authorization: Bearer`) para leer host y servicios |
| **Clave de incidente** | Identificador estable (`srv:…` o `ep:…`) que evita duplicados |
