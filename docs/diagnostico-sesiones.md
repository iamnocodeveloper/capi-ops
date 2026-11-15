# Diagnóstico de sesiones WAHA (`/diag`)

Responde, desde Telegram, por qué una sesión pasó a `FAILED`: hora exacta, motivo y evidencia
del log. No usa webhooks ni histórico propio: lee el log del contenedor con una ventana horaria.

## Por qué SSH

- La API de WAHA solo expone estado (`/api/sessions`, `/{session}`, `/{session}/me`), no logs.
- `get_logs` del MCP de Coolify devuelve las últimas N líneas, sin `since/until`.
- `docker logs -t --since … --until …` es la única fuente con hora real.

Si un servidor no tiene SSH configurado, los comandos siguen funcionando en modo degradado
(estado + últimas líneas), avisando que no hay ventana histórica.

## Configuración

En `servers.json` (o `SERVERS_JSON`), por servidor:

```json
{
  "alias": "capi2",
  "ip": "68.168.30.194",
  "ssh": {
    "user": "root",
    "port": 22,
    "passwordEnv": "CAPI2_SSH_PASSWORD",
    "hostKey": "SHA256:ArkLUwxwC1scV5dw+UJ0t7c6TXPoKrqwCIqkvbNEXyk"
  }
}
```

- `passwordEnv`: nombre de la variable con la password (mejor que ponerla inline).
- `keyPath`: alternativa, ruta a una llave privada montada en el contenedor.
- `hostKey`: fingerprint OpenSSH. Si está, se verifica (recomendado).
- `DIAG_SSH=false` apaga todo el diagnóstico SSH.

Oficinas en `config/oficinas.json` (gitignored) o `OFFICES_JSON`:

```json
{
  "Oficina19": { "server": "capi2", "instance": "waha20" },
  "Oficina23": { "server": "capi2", "instance": "waha23" }
}
```

## Comandos

| Comando | Ejemplo |
|---|---|
| `/diag` | `/diag waha23 plp-3-res 11:30` |
| `/diag` por oficina | `/diag Oficina19 norte hoy` |
| `/diag` todas las FAILED | `/diag waha23` |
| `/sesiones` | `/sesiones waha23` |
| `/fallidas` | `/fallidas capi2` o `/fallidas` |
| `/historial` | `/historial waha20 5` (5 días) |
| `/red` | `/red waha23` o `/red capi2` |
| `/logs` con ventana | `/logs waha23 200 03/11 11:00..12:00` |

### Sintaxis de “cuándo”

Zona horaria `DIAG_TZ` (por defecto `America/Argentina/Buenos_Aires`). El log del contenedor está
en UTC y se convierte automáticamente.

| Formato | Interpretación |
|---|---|
| `11:30` | hoy 11:30, ventana ±10 min |
| `03/11 11:43` | 3 de noviembre 11:43, ±10 min |
| `03/11` | todo el día |
| `ayer` / `hoy` | todo el día anterior / actual |
| `ayer 06:35` | ayer 06:35, ±10 min |
| `2h` / `30m` | últimas 2 horas / 30 minutos |
| `11:43 30m` | 11:43 con ventana ±30 min |

## Taxonomía de motivos

| Código | Patrón en el log | Significado | Acción |
|---|---|---|---|
| `device-removed` | `Got device removed stream error` | El dispositivo se desvinculó desde el teléfono (o “cerrar sesión en todos los dispositivos”) | Re-vincular por QR |
| `primary-logged-out` | `Got 403: primary device was logged out` | El teléfono principal cerró sesión | Re-vincular |
| `logout-other-device` | `Got 401: logged out from another device` | Se abrió/cerró sesión desde otro dispositivo | Revisar quién y re-vincular |
| `logout-api` | `Session has been logged out` + `DELETE /api/sessions/…` | Logout por API (manual o integración) | Auditar la integración |
| `logged-out` | `session:<x> - Logged out` sin código | Logout sin 401/403 en el log | Re-vincular |
| `qr-expired` | `QR code … expired` / `SCAN_QR_CODE` repetido | Nadie escaneó a tiempo | QR nuevo |
| `network` | `ENOTFOUND`, `ETIMEDOUT`, `ECONNREFUSED`, proxy | Red/proxy/DNS | Revisar proxy o conectividad |
| `engine` | `panic`, `engine start failure` | Fallo del motor GOWS | Reiniciar sesión/contenedor |

`503 stream error` y `websocket not connected` **no** son causa de `FAILED`: son cortes que GOWS
reconecta solo. El motivo real siempre es el 401/403/device removed posterior.

`reachoutTimelock` y `messageCapping` se muestran en `/sesiones`: si están activos, **no** hay que
reiniciar ni re-vincular; WhatsApp los levanta solo.

## IP y proxy

`/red` responde:

- IP de salida del host (`curl ifconfig.me` por SSH).
- IP de salida desde dentro del contenedor.
- Variables `*PROXY*` del contenedor.
- `config.proxy` de cada sesión (vía API de WAHA).

Todas las sesiones de una misma instancia comparten contenedor y, salvo proxy explícito, la misma
IP pública del servidor. Que varias líneas de una oficina compartan IP es lo normal; **no** es una
causa de `FAILED`.

## Límites

- **Retención**: los logs del contenedor dependen de Docker (habitualmente ~5 días). Para eventos
  más viejos no hay fuente: este diseño es on-demand, sin webhooks ni histórico persistente.
- Un `FAILED` antiguo (anterior a la retención) aparece como “sin evento concluyente”.
- `/fallidas` consulta la API de cada instancia y luego el log solo de las FAILED (máximo 12 por
  ejecución para no saturar Telegram/SSH).

## CLI

Misma lógica sin Telegram:

```bash
npm run diag -- waha23 plp-3-res 11:30
npm run diag -- waha23 plpll-respaldoo "03/11 06:35"
npm run diag -- Oficina19 norte hoy
```

## Troubleshooting

| Síntoma | Causa | Solución |
|---|---|---|
| `SSH no configurado para capiX` | Falta `ssh` en la flota o la env de la password | Completar `ssh` y `CAPIx_SSH_PASSWORD` |
| `timeout SSH` | Host inaccesible o firewall | Probar `ssh root@<ip>`; abrir el 22 al host de monitoreo |
| `Host denied` / verificación | `hostKey` no coincide | Comparar `ssh-keyscan -t ed25519 <ip>` |
| `no encontré el contenedor` | App sin contenedor o UUID cambiado | Verificar `/instancias <srv>` y el estado en Coolify |
| `Sin evento concluyente` | Ventana sin logs o anterior a la retención | Ampliar a `30m`/día completo o revisar `/historial` |
