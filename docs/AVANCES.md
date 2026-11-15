# Avances del proyecto — capi-ops

Bitácora cronológica. Cada entrada resume qué se logró, qué se verificó y qué quedó pendiente.
Para el detalle técnico de un cambio, ver [`CAMBIOS-2026-11-15.md`](./CAMBIOS-2026-11-15.md); para el
estado consolidado, [`MEMORIA-PROYECTO.md`](./MEMORIA-PROYECTO.md).

---

## Línea de tiempo

| Fecha | Etapa | Hito |
|---|---|---|
| 2026-10-29 | 0.1.0 | Watcher multi-Coolify por MCP, health de WAHA, motor de incidentes, bot de Telegram, deploy en EasyPanel |
| 2026-10-29 | 0.2.0 | `/instancias`, documentación base, CI (typecheck + build) |
| 2026-10-29 | 0.3.0 | Guía de higiene de disco y scripts de purga del store de WAHA |
| 2026-10-29 | 0.4.0 | Histórico en Postgres, `/stats` y `GET /stats` |
| 2026-10-29 | 0.5.0 | `docs/RETOMAR.md` y sección de operación de la base histórica |
| 2026-10-31 | 0.6.0 | Monitoreo del propio EasyPanel (`/ep`, `/eps`, `/epserv`, acciones con confirmación) |
| 2026-11-03 | 0.7.0 | Diagnóstico de sesiones WAHA por SSH (`/diag`, `/sesiones`, `/red`, `/historial`, `/fallidas`) |
| 2026-11-12 | — | *Provision* de servidores Coolify desde el bot (PR #1) + limpiezas de CI |
| **2026-11-15** | **0.8.0** | **Reconexión del bot + hardening de resiliencia + tests + documentación** |
| **2026-11-15** | **0.9.0** | **Retención automática del histórico Postgres** |
| **2026-11-15** | — | **Alta de capi7 + 10 WAHA (`waha85`–`waha94`)** |

---

## 2026-11-15 — 0.8.0

### Contexto

El bot de Telegram anterior fue borrado y el servicio quedó en **crash loop**: con el token revocado,
`bot.start()` rechazaba y Node 24 terminaba el proceso por un *unhandled rejection*. El watcher dejó
de monitorear y no había forma de avisar (Telegram era el único canal).

### Logros

- **Bot nuevo reconectado**: `@nocodeops_bot` con polling, env actualizado y servicio recreado.
- **Allowlist corregida**: el `chat_id` configurado no era el del chat real; se obtuvo el correcto y se
  fijó en `TG_ALLOWED_CHATS`, `TG_ALLOWED_USERS` y `TG_ADMIN_CHAT`.
- **Resiliencia**: `bot.start()` con `.catch`, handlers de `unhandledRejection` y `uncaughtException`,
  `main()` con `.catch`. Un fallo de Telegram ya no mata el proceso.
- **Incidente `ops:telegram`**: si el polling se detiene o hay envíos fallidos repetidos, se abre un
  incidente crítico que se cierra solo al recuperarse.
- **Observabilidad**: `/health` incluye `telegramStatus` (polling, último error, fallos consecutivos).
- **UX**: `setMyCommands` registra el menú de comandos en Telegram al arrancar.
- **Calidad**: 29 tests unitarios (`rules`, `incidents`, `time`) y `npm test` en CI.
- **Integración**: checkpoint del trabajo local + merge de `origin/main`; conflictos resueltos
  conservando *provision* por SSH **y** diagnóstico de sesiones. Validado con typecheck, 29 tests y
  build.
- **Despliegue**: publicado en `origin/main` y desplegado el 2026-11-15 (commit `32be1e2`).

### Verificación

- `npm run typecheck` → OK.
- `npm test` → 29/29 en verde.
- `npm run build` → OK.
- Servicio en producción (commit `32be1e2`): `uptimeSeconds` creciente, `lastCycleAt` activo,
  6 servidores `reachable`, EasyPanel `reachable`, `telegramStatus.polling: true` y 0 fallos.

### Pendiente al cierre

- Configurar `HEARTBEAT_URL`.
- Auth en endpoints públicos.

---

## 2026-11-15 — 0.9.0

### Logros

- **Retención automática del histórico Postgres**: purga al arrancar y cada 24 h. Muestras y chequeos
  a 30 días, incidentes **resueltos** a 180 y acciones a 365.
- Configurable con `RETENTION_*`; `0` días desactiva una tabla y `RETENTION_ENABLED=false` apaga todo.
- Los incidentes abiertos nunca se borran.

### Verificación

- `npm run check` (typecheck + 29 tests) y `npm run build` OK.
- Desplegado en producción (commit `f547ac7`); `/health` sano y Telegram en polling.

---

## 2026-11-15 — Alta de capi7

### Logros

- Servidor **`capi7`** (`68.168.20.3`) instalado desde cero: Ubuntu 26.04, Coolify **4.7.5**, MCP
  habilitado y token de equipo acuñado.
- **10 instancias WAHA** (`waha85`–`waha94`) desplegadas con `devlikeapro/waha:latest`
  (versión **2026.10.1**), engine `GOWS`, 6 variables por app.
- **Stickers**: `POST /api/sendSticker` está presente (respuesta 400 sin sesión, no 404). WAHA lo
  incorporó en **2026.8.2**; la versión desplegada lo soporta.
- Flota de capi-ops ampliada a **7 servidores** y rangos corregidos a los valores reales; `/health`
  reporta `capi7` con 10 apps y `reachable: true`.
- Detalle privado: `docs/coolify/capi7.md`.

### Pendiente

- DNS: crear A records `waha85`–`waha94` → `68.168.20.3` (el wildcard de `supercrm.best` apunta a
  `216.150.1.1`). Hasta entonces los endpoints públicos no llegan; el routing interno de Traefik sí
  funciona.

---

## Cómo registrar el próximo avance

1. Agregar una fila a la línea de tiempo con fecha y etapa.
2. Describir contexto, logros, verificación y pendientes.
3. Enlazar el documento de cambios si el detalle lo amerita.
4. Actualizar [`MEMORIA-PROYECTO.md`](./MEMORIA-PROYECTO.md) si cambió el estado o una decisión.
