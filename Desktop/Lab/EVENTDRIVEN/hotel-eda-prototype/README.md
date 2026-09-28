# Prototipo EDA — Eventos y Banquetes de Hotel

Prototipo ejecutable de la propuesta de arquitectura orientada a eventos
para el área de eventos/MICE de un hotel (dimensionado sobre los números
públicos del JW Marriott Quito: 257 habitaciones). Corre completo dentro de
GitHub Codespaces, sin instalar nada en tu máquina.

El porqué de cada decisión de diseño (broker elegido, patrón outbox,
consistencia fuerte solo en inventario, saga por coreografía, etc.) está
en [`docs/adr/`](docs/adr/README.md), como Architecture Decision Records.

## Qué demuestra

El recorte de la propuesta que más vale la pena mostrar en vivo: qué pasa
en el sistema cuando se **confirma un evento de banquetes (una BEO)**.

```
                          ┌────────────────────┐
                          │   events-service    │  dueño del agregado "Evento"
                          │  (cotizar/confirmar) │
                          └──────────┬───────────┘
                                     │ EventoConfirmado
                     ┌───────────────┼────────────────┐
                     ▼                                ▼
          ┌────────────────────┐           ┌────────────────────┐
          │ room-block-service  │           │  kitchen-service    │
          │ (inventario de      │           │  (comanda del       │
          │  habitaciones)      │           │   banquete)         │
          └──────────┬───────────┘           └──────────┬──────────┘
                      │ BloqueCreado / BloqueRechazado    │ ComandaCreada
                      ▼                                   │
          ┌────────────────────┐                          │
          │   folio-service     │◄─── CargoRegistrado ─────┴── opera-adapter
          │ (folio consolidado) │      (simulador de OHIP/Simphony)
          └────────────────────┘

          BloqueRechazado también vuelve a events-service, que marca
          el evento EN_RIESGO (compensación de la saga).

                    Todos los eventos también llegan al
                    dashboard (puerto 3000), que los pinta en vivo.
```

Ningún servicio llama directamente a otro. Todos hablan publicando y
escuchando eventos sobre un exchange de RabbitMQ (`hotel.events`).

## Cómo correrlo

1. Abre este repositorio en GitHub Codespaces (o en VS Code con la
   extensión Dev Containers, en local). Espera a que termine
   `postCreateCommand` (`npm install`).
2. En la terminal del Codespace: `npm run dev`. Esto levanta los seis
   procesos (verás sus logs entrelazados, cada uno con su color).
3. Abre el puerto **3000** (el tablero se abre solo en la pestaña de
   preview). Déjalo abierto en una pestaña mientras disparas eventos desde
   otra.
4. Abre `requests.http` y usa la extensión **REST Client** (ya instalada)
   para ir ejecutando el escenario de demo paso a paso — o usa `curl` si lo
   prefieres, las mismas rutas están documentadas ahí.

Postgres queda accesible en `localhost:5432` (usuario/clave/base: `hotel` /
`hotel` / `hotel`) y la consola de RabbitMQ en `localhost:15672`
(`guest`/`guest`), por si quieres inspeccionar las tablas o las colas
directamente.

## El catálogo de eventos

| Evento | Lo publica | Lo consume | Qué significa |
|---|---|---|---|
| `EventoCotizado` | events-service | — (informativo) | Se creó el borrador de la BEO |
| `EventoConfirmado` | events-service | room-block-service, kitchen-service | El coordinador confirmó el evento |
| `BloqueCreado` | room-block-service | folio-service | Se reservaron las habitaciones del grupo |
| `BloqueRechazado` | room-block-service | events-service | No había habitaciones suficientes |
| `EventoEnRiesgo` | events-service | — (informativo) | Compensación: el evento quedó sin respaldo de inventario |
| `ComandaCreada` | kitchen-service | — (informativo) | Cocina tiene el pedido del banquete |
| `ReservaCreada`, `CheckInRealizado` | opera-adapter | — (informativo) | Simulan eventos que vendrían de OHIP |
| `CargoRegistrado` | opera-adapter | folio-service | Simula un cargo llegando del POS (Simphony) o el spa |
| `FolioAbierto`, `FolioActualizado` | folio-service | — (informativo) | El folio consolidado se abrió o recibió un cargo |

## Patrones implementados (y por qué)

- **Outbox transaccional**: cada servicio de negocio escribe su cambio de
  estado y su evento saliente en la misma transacción de Postgres (tabla
  `<schema>.outbox`). Un proceso aparte (`startOutboxRelay`, en
  `services/common`) publica lo pendiente cada 500 ms. Así nunca se pierde
  un evento aunque el proceso se caiga justo después del `commit`.
- **Idempotencia**: cada consumidor guarda en `<schema>.processed_events`
  los IDs de evento ya procesados, dentro de la misma transacción de
  negocio. El outbox puede reintentar una publicación (entrega
  "al menos una vez"); el consumidor la vuelve "efectivamente una vez".
- **Consistencia fuerte donde importa**: `room-block-service` bloquea
  (`SELECT ... FOR UPDATE`) las filas de disponibilidad antes de decidir,
  para que dos confirmaciones simultáneas no sobrevendan el mismo rango de
  fechas. Es el único punto del sistema que no es "eventual a secas".
- **Saga por coreografía con compensación**: nadie orquesta el flujo desde
  arriba. `room-block-service` decide por su cuenta si acepta o rechaza, y
  `events-service` reacciona al rechazo marcando el evento `EN_RIESGO` en
  vez de dejarlo `CONFIRMADO` sin respaldo real.
- **Dead-letter queue**: las colas se declaran con
  `x-dead-letter-exchange`. Un mensaje que un consumidor rechaza sin pedir
  reintento (`nack(msg, false, false)`) cae en `hotel.events.dlq` en vez de
  desaparecer. Revísala en la consola de RabbitMQ (puerto 15672) para ver
  mensajes fallidos.
- **CQRS ligero**: el tablero (`dashboard`) es una proyección de lectura
  desechable — se reconstruye escuchando `#` (todos los eventos). Si se
  reinicia, pierde el historial en memoria pero no afecta a nadie más; la
  verdad sigue en las bases de cada servicio.

## Una lección real que deja correr la demo

Prueba el escenario 2 (`requests.http`, pasos 8-10) y mira el tablero:
cuando `room-block-service` rechaza el bloque, `kitchen-service` **igual
crea la comanda**, porque reacciona a `EventoConfirmado` en paralelo y no
sabe nada del rechazo. Es una coreografía incompleta a propósito: cada
rama de la saga solo se compensa si explícitamente escucha el evento de
compensación (`EventoEnRiesgo`). Buen punto de partida para discutir en
clase por qué las sagas orquestadas (con un coordinador central que sí ve
todas las ramas) a veces se prefieren sobre la coreografía pura.

## Qué se simplificó a propósito

Esto es un prototipo para explicar y probar el patrón, no un sistema listo
para producción. Lo que un proyecto real necesitaría además:

- **opera-adapter real**: aquí son tres endpoints REST que disparas a
  mano. En producción sería un consumidor haciendo polling a la API de
  Business Events de OHIP (o su Streaming API) con autenticación OAuth 2.0,
  reintentos y manejo de paginación.
- **Un solo contenedor para todos los servicios**: para que el prototipo
  arranque con un solo `npm run dev` dentro del devcontainer. En producción
  cada servicio sería su propia imagen, escalable de forma independiente.
- **Sin observabilidad**: no hay tracing distribuido (correlación de un
  `eventoId` a través de los cinco servicios), ni métricas, ni alertas. En
  producción es indispensable para depurar un flujo asíncrono.
- **Rechazo de habitaciones simplificado**: solo compara la fecha de
  inicio/fin contra un contador global de 257 habitaciones; no distingue
  tipos de habitación, tarifas ni el *cutoff* típico de un bloque de grupo.
- **Sin autenticación ni multi-propiedad**: no hay usuarios, roles, ni
  aislamiento entre distintos hoteles de una cadena.
- **Reintentos de la dead-letter**: los mensajes caen en la DLQ pero nada
  los reprocesa automáticamente; en producción se añadiría un
  reprocesador con backoff o un panel para reintentarlos a mano.

## Ideas para extender

- Añadir un `housekeeping-service` que reaccione a `BloqueCreado` con
  `HabitacionLista`/`HabitacionOcupada`.
- Añadir un cutoff real: liberar automáticamente el bloque si no se
  recoge (*pick-up*) antes de una fecha límite.
- Reemplazar la coreografía por una saga orquestada explícita (una máquina
  de estados) para comparar los dos enfoques.
- Escribir un contrato (JSON Schema) por tipo de evento y validarlo antes
  de publicar, para simular el schema registry que tendría un despliegue
  real con Kafka/Avro.
