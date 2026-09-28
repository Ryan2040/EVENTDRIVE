# ADR-0004: Idempotencia en cada consumidor como contraparte del Outbox

## Estado

Aceptada — 2026-09-28

## Contexto

El patrón Outbox (ADR-0003) da entrega "al menos una vez": el mismo evento
puede llegar duplicado a un consumidor (por ejemplo, si el relay publica
pero muere antes de marcar la fila como publicada). Sin protección, un
`EventoConfirmado` duplicado crearía dos bloques de habitaciones, dos
comandas de cocina, o cargaría un mismo cargo dos veces al folio —
exactamente el tipo de error de conciliación que esta arquitectura busca
eliminar, no reintroducir.

## Decisión

Cada servicio consumidor mantiene una tabla `<esquema>.processed_events`
con el ID del evento como clave. Antes de aplicar el efecto de negocio,
verifica si ese ID ya fue procesado; si no lo fue, aplica el efecto y
registra el ID, todo dentro de la misma transacción SQL.

## Consecuencias

### Positivas

- Convierte la entrega "al menos una vez" del broker en "efectivamente una
  vez" desde el punto de vista del negocio.
- Un solo patrón, repetido de forma idéntica en los cuatro servicios
  consumidores (`room-block-service`, `kitchen-service`, `folio-service`,
  `events-service`), fácil de auditar y de enseñar.

### Negativas / trade-offs

- La tabla `processed_events` crece sin límite si nada la purga; en
  producción necesitaría una política de retención (por ejemplo, borrar
  entradas más viejas que el tiempo máximo de reintento razonable).
- Depende de que el ID de evento sea único y estable — cierto aquí porque
  se genera una sola vez al insertar la fila en `outbox`, pero es una
  invariante que hay que preservar si el esquema de eventos cambia.

## Alternativas consideradas

- **Confiar en la deduplicación del broker** — descartada: RabbitMQ no
  deduplica mensajes por sí mismo; el `messageId` que se le pasa es
  informativo, no aplica una garantía de unicidad.
- **Hacer que cada operación de negocio sea naturalmente idempotente (p. ej.
  upserts) en vez de rastrear IDs** — descartada como regla general: varios
  efectos de este dominio no son idempotentes por contenido (agregar un
  cargo al folio dos veces con el mismo monto es indistinguible de dos
  cargos reales); rastrear el ID del evento es más robusto y más fácil de
  aplicar de forma uniforme en los cuatro servicios.
