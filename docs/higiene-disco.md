# Higiene de disco

Qué ocupa espacio en un host con Coolify + WAHA, cómo medirlo, qué se puede limpiar sin riesgo y
cuál es el procedimiento para tocar el store de una sesión.

> **Regla de alcance.** Estas tareas tocan sesiones de WhatsApp productivas. Solo se ejecutan sobre
> instancias que el dueño del proyecto haya nombrado explícitamente. Antes de cualquier purga, backup
> y restauración verificada.

---

## 1. Qué guarda WAHA

| Qué | ¿Crece? | Dónde | Cómo se controla |
|---|---|---|---|
| Media (imágenes, videos, audios, documentos) | **No** | tmp del contenedor | Vida de **180 s** por defecto si no se define `WHATSAPP_FILES_FOLDER` |
| Store del engine (`gows.db`) | **Sí**: mensajes, chats, grupos, etiquetas | `/app/.sessions/gows/<sesion>/` | `config.gows.storage.*` por sesión + purga manual |
| Logs del contenedor | Sí | `/var/lib/docker/containers/<id>/*-json.log` | Rotación del daemon de Docker |
| Imágenes y caché de build | Sí, con cada deploy | `/var/lib/docker` | Docker Cleanup de Coolify |

Puntos clave:

- **No existe retención configurable** del store en WAHA. La única palanca es dejar de escribir
  (`storage.* = false`) y purgar una vez lo ya escrito.
- Las sesiones de estas apps **no tienen volumen** para `/app/.sessions`: el store vive en la capa
  del contenedor, así que un redeploy lo borra (y con él el pairing).
- El media **no** se acumula: si no hay carpeta configurada, se borra a los 180 s.

---

## 2. Diagnóstico

En el host:

```bash
WAHA_IMAGE=devlikeapro/waha:latest bash scripts/diag-disco.sh
```

Devuelve: uso de disco, `docker system df`, tamaño de logs, tamaño de `/app/.sessions` por contenedor,
si existe `/app/.media` y los nombres de variables de archivos (nunca los valores).

Dentro de un contenedor, para ver qué hay en el store:

```bash
docker cp scripts/inspect-store.js <container>:/tmp/
docker exec <container> node /tmp/inspect-store.js
```

Lista cada `.db` con el tamaño y las tablas ordenadas por cantidad de filas. Las que crecen son
`gows_messages`, `whatsmeow_message_secrets` y `whatsmeow_app_state_mutation_macs`; las de
device/crypto tienen una fila y **no se tocan**.

---

## 3. Limpieza del host (sin riesgo)

Docker Cleanup nativo de Coolify, por servidor, vía MCP:

```
docker_cleanup action=update data={
  docker_cleanup_frequency: "0 4 * * *",   # diario 04:00
  docker_cleanup_threshold: 70,            # %
  force_docker_cleanup: false,
  delete_unused_volumes: false,            # NUNCA true
  delete_unused_networks: true
}
docker_cleanup action=run { confirm: true }
```

Elimina imágenes viejas, contenedores detenidos y caché de build. Es la mayor ganancia en hosts con
muchos deploys y no afecta sesiones.

---

## 4. Store: dejar de crecer

`PUT /api/sessions/{sesion}` reemplaza la configuración completa; si la sesión no está `STOPPED` la
detiene y la arranca con la nueva configuración. **El pairing se conserva.**

1. Leer el config actual (`GET /api/sessions/{sesion}`).
2. Mergear solo el bloque `gows.storage`, sin pisar `webhooks`, `client`, `metadata` ni `proxy`.
3. Enviar el config completo.

Configuración para una instancia que solo envía y recibe:

```json
{
  "gows": {
    "storage": {
      "messages": false,
      "chats": false,
      "groups": false,
      "labels": false,
      "contacts": true,
      "messageSecrets": false
    }
  }
}
```

Tradeoffs documentados por WAHA:

| Flag en `false` | Qué se pierde |
|---|---|
| `contacts` | API de contactos vacía, sin push names, no funciona el envío de estado a todos los contactos |
| `messageSecrets` | No se pueden desencriptar votos de encuestas, respuestas a eventos ni mensajes de bot |

Si se necesita historial de chats, **no** se aplica este bloque y se opta por purgas periódicas.

Volver atrás: reenviar el config **sin** el bloque `gows` (los campos omitidos quedan habilitados) y
reiniciar la sesión.

---

## 5. Purga del store (procedimiento con rollback)

Solo con la sesión detenida y backup verificado.

```bash
# 1. detener
curl -s -X POST -H "X-Api-Key: $KEY" https://<dominio>/api/sessions/<sesion>/stop

# 2. backup fuera del contenedor
docker cp <container>:/app/.sessions/gows/<sesion>/gows.db /root/<sesion>-gows-$(date +%F-%H%M).db
gzip -9 /root/<sesion>-gows-*.db

# 3. purgar y compactar (dentro del contenedor)
docker cp scripts/purgar-store.js <container>:/tmp/
docker exec <container> node /tmp/purgar-store.js /app/.sessions/gows/<sesion>/gows.db

# 4. arrancar y verificar
curl -s -X POST -H "X-Api-Key: $KEY" https://<dominio>/api/sessions/<sesion>/start
# esperar status=WORKING y comprobar /api/sessions/<sesion>/me
```

### Rollback

```bash
# con la sesión detenida
gunzip -c /root/<sesion>-gows-*.db.gz > /root/restore.db
docker cp /root/restore.db <container>:/app/.sessions/gows/<sesion>/gows.db
docker exec <container> rm -f /app/.sessions/gows/<sesion>/gows.db-wal /app/.sessions/gows/<sesion>/gows.db-shm
# reenviar config sin el bloque gows, arrancar y verificar
```

La restauración se considera completa cuando `inspect-store.js` muestra la misma cantidad de filas que
antes y la sesión vuelve a `WORKING` con el mismo `me.id`.

---

## 6. Cuando el disco apremia

| Disco | Acción |
|---|---|
| ≥ 70% | `docker_cleanup run` en ese servidor |
| ≥ 80% | revisar qué contenedor concentra el store (`diag-disco.sh`) |
| ≥ 90% | purgar el store de las sesiones nombradas, con backup, o mover la instancia de host |

La regla `disk_high` del watcher ya avisa en 80% y 90%; el digest diario muestra la evolución.
