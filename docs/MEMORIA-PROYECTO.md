# Memoria del proyecto — capi-ops

> Documento vivo. Resume qué es el sistema, cómo está hoy y qué hay que saber para retomarlo sin
> reconstruir contexto. **No contiene secretos**: tokens, IPs internas y credenciales viven en el
> entorno del servicio en EasyPanel y en el documento privado de la operación.

Última actualización: **2026-11-15** (etapa 0.8.0 — reconexión del bot y hardening).

---

## 1. Qué es

`capi-ops` es un servicio Node 24 + TypeScript que:

- **Vigila** seis paneles Coolify con instancias WAHA (`capi1`–`capi6`) vía MCP (Streamable HTTP).
- **Vigila** el propio EasyPanel donde corre (`alias ep`) por su API REST.
- **Avisa** por Telegram cuando algo se rompe, se recupera o hay un digest diario.
- **Ejecuta** acciones desde el chat: instalar WAHA, deploy/restart/stop/delete, y las equivalentes
  de EasyPanel, siempre con confirmación y auditoría.
- Guarda **SQLite** operativo (`/data/state.sqlite`) y **Postgres** histórico (`DATABASE_URL`).

Las decisiones son reglas explícitas, no un LLM: determinista y auditable.

---

## 2. Estado actual (2026-11-15)

| Pieza | Estado |
|---|---|
| Servicio | `capi-ops` en EasyPanel, proyecto `joel`, puerto host `18080` → contenedor `8080` |
| Bot | `@nocodeops_bot` por **polling** (sin webhook ni dominio) |
| Allowlist | chat/usuario/admin autorizados según `TG_ALLOWED_*` del env del servicio |
| Histórico | Postgres conectado; escribe muestras, chequeos, incidentes y acciones |
| Retención | automática: 30 días muestras/chequeos, 180 incidentes resueltos, 365 acciones (`RETENTION_*`) |
| Health | `GET /health` con snapshot de flota, EasyPanel y (nuevo) estado de Telegram |
| Loki | **no instalado** en el host: los logs solo se ven desde la UI de EasyPanel |
| Repo desplegado | `origin/main` = `f547ac7` (0.9.0: retención del histórico) |
| Repo local | `main` en `f547ac7` + commits de docs |

### Integración local ↔ `origin/main`

El 2026-11-15 se integraron las dos líneas que estaban divergentes:

- Se hizo checkpoint del trabajo local (etapa 0.7.0 + 0.8.0) y se mergeó `origin/main`.
- Conflictos resueltos conservando **ambas** features: *provision* por SSH y diagnóstico de sesiones.
- Validado con `npm run typecheck`, `npm test` (29/29) y `npm run build`.
- Publicado (`git push`) y desplegado el 2026-11-15; `/health` confirma `telegramStatus.polling: true`,
  0 fallos y 6 servidores `reachable`. Versión actual: **0.9.0** (`f547ac7`).

---

## 3. Topología (sin datos sensibles)

- **Flota Coolify**: `capi1`…`capi6`, cada uno con su MCP, rango de instancias WAHA y credenciales
  SSH opcionales para diagnóstico.
- **EasyPanel propio**: host donde corre el servicio; se vigila a sí mismo. Si el host muere, este
  watcher también: depende de un `HEARTBEAT_URL` externo (hoy vacío).
- **Bot**: un único bot para flota y EasyPanel; el origen se distingue por la clave del incidente
  (`srv:…` vs `ep:…`) y el prefijo del título.
- **Datos**: SQLite embebido para el día a día; Postgres para tendencias. Perder SQLite no rompe
  nada: incidentes y numeración se reconstruyen.

---

## 4. Cómo se opera

### Desplegar

1. `git push origin main`.
2. `execute_destructive → deployAppService { projectName: "joel", serviceName: "capi-ops", forceRebuild: true }`.
3. Verificar que el contenedor **se recreó**: mirar `uptimeSeconds` en `/health`. Si sigue alto, el
   deploy no recreó el servicio (ver trampas).

### Cambiar configuración

1. Leer el env con `inspectAppService` (no imprimirlo en logs ni en el chat).
2. `updateAppEnv` con el `.env` **completo** (reemplaza, no mergea). Verificar que no bajó la cantidad
   de claves.
3. **Redesplegar**: el restart simple no toma el env nuevo.

### Verificar

```powershell
Invoke-RestMethod http://<host>:18080/health | ConvertTo-Json -Depth 4
```

Buscar: `uptimeSeconds` bajo, `lastCycleAt` reciente, `servers[].reachable`, `easyPanel.reachable`,
`telegramStatus.polling: true`.

---

## 5. Decisiones que no conviene reabrir sin motivo

| Decisión | Motivo |
|---|---|
| Reglas explícitas, no LLM | Las acciones de infraestructura deben ser deterministas y auditables |
| Corre fuera de la flota monitoreada | Si vive en un servidor vigilado, cuando ese servidor cae también cae el alertador |
| MCP para Coolify | Vía oficial, permisos por token |
| SQLite operativo + Postgres histórico | Estado sin red; tendencias con base |
| Telegram por polling | Sin dominio, certificado ni ingress |
| Comandos con confirmación | Un bot que borra contenedores necesita fricción |

---

## 6. Trampas conocidas (aprendidas en producción)

1. **Token de Telegram inválido = crash loop.** Con un token revocado, `bot.start()` rechaza y Node 24
   termina el proceso por *unhandled rejection*. Esto pasó el **2026-11-15** al borrarse el bot anterior
   y dejó el servicio reiniciándose en bucle. Desde 0.8.0 el rechazo se captura (`markPollingError`),
   se emite el incidente `ops:telegram` y el watcher sigue vivo en modo degradado.
2. **Un bot borrado no se puede "reconectar".** Hay que crear uno nuevo en `@BotFather` y actualizar
   `TG_TOKEN`. El `chat_id` privado es el `user_id` de la persona, así que la allowlist puede seguir
   sirviendo… salvo que la cuenta sea otra (fue el caso: el ID configurado no era el del chat real).
3. **Deploy que no recrea el contenedor.** Documentado en 2026-10-31; el workaround histórico es
   *destroy + create*, pero desde el 2026-11-15 el `deployAppService` con `forceRebuild` sí recreó.
   Verificar siempre `uptimeSeconds`.
4. **Sin Loki no hay logs centralizados.** `queryServiceLogs` devuelve `BAD_REQUEST`; el diagnóstico se
   hace por `/health`, Telegram y la UI del servicio.
5. **El puerto `18080` publica `/health` y `/metrics` sin auth** (IPs y consumo). Si no se necesita,
   cerrarlo: el bot no lo requiere.
6. **Cambiar la password de un usuario de Coolify revoca todos sus tokens.**
7. **Credenciales en el chat.** Inspeccionar el env de un servicio vuelca tokens en la conversación;
   si el log se comparte, rotarlos.

---

## 7. Próximos pasos priorizados

1. **`HEARTBEAT_URL`**: check externo (healthchecks.io o similar) para avisar si el host muere.
2. **Auth en `/health` y `/metrics`** o cerrar el puerto publicado.
3. **Rate limit y cooldown** de comandos destructivos por usuario.
4. **Aviso informativo de deploy** de EasyPanel comparando commit.
5. **Botones inline** en alertas (Ack / Silenciar / Ver detalle) y `/silenciar`, `/ack`.

---

## 8. Dónde está la verdad

| Tema | Fuente |
|---|---|
| Código y documentación | repo `capi-ops` |
| Configuración y secretos | env del servicio en EasyPanel |
| Inventario real (IPs, tokens, UUIDs) | documento privado de la operación |
| Estado del despliegue | `GET /health`, `inspectAppService`, commits de `origin/main` |
