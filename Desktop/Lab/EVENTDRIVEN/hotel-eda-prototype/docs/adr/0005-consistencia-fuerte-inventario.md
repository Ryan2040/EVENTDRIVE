# ADR-0005: Consistencia fuerte para el inventario de habitaciones

## Estado

Aceptada — 2026-09-28

## Contexto

La mayor parte del sistema tolera consistencia eventual sin problema: que
la comanda de cocina aparezca unos cientos de milisegundos después de
confirmado el evento no le importa a nadie. El inventario de habitaciones
es distinto: si dos eventos se confirman casi al mismo tiempo y ambos piden
más habitaciones de las que quedan disponibles, ambos no pueden aceptarse
— eso es overbooking, el problema número uno señalado en la propuesta
original.

## Decisión

`room-block-service` es el único dueño de la tabla de disponibilidad. Antes
de decidir si acepta o rechaza un bloqueo, bloquea (`SELECT ... FOR UPDATE`)
las filas de disponibilidad de todas las fechas involucradas, dentro de una
sola transacción, y solo entonces decrementa y confirma. Ningún otro
servicio escribe esa tabla.

## Consecuencias

### Positivas

- Elimina la condición de carrera de sobreventa dentro de este servicio: dos
  confirmaciones concurrentes para el mismo rango de fechas se serializan
  por el lock de fila de Postgres.
- La regla de negocio ("nunca bloquear más habitaciones de las que hay")
  queda centralizada en un solo lugar, no dispersa por el sistema.

### Negativas / trade-offs

- La tabla de disponibilidad puede volverse un punto de contención bajo
  volumen muy alto de confirmaciones concurrentes para las mismas fechas —
  no es un problema real a la escala de un hotel, pero sí lo sería si este
  patrón se reutiliza para un caso con mucho más tráfico.
- El límite de consistencia fuerte es deliberadamente angosto: es una
  garantía que vive adentro de la transacción de `room-block-service`, no
  una propiedad del sistema completo. Todo lo demás sigue siendo
  eventualmente consistente.

## Alternativas consideradas

- **Concurrencia optimista (columna de versión, reintento ante conflicto)**
  — descartada para el prototipo por simplicidad; alternativa válida si el
  volumen de confirmaciones concurrentes creciera lo suficiente para que el
  locking pesimista genere esperas notables.
- **Lock distribuido vía Redis/Zookeeper** — descartada: complejidad
  innecesaria cuando el lock de fila de Postgres ya da la garantía
  necesaria dentro de la propia base de datos del servicio.
