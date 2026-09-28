# ADR-0003: Patrón Outbox transaccional para publicar eventos

## Estado

Aceptada — 2026-09-28

## Contexto

El enfoque ingenuo — "guardar en la base de datos y luego publicar en el
broker" — tiene una ventana de fallo real: si el proceso muere justo entre
el `commit` y la publicación, el evento se pierde para siempre aunque el
cambio de estado sí quedó guardado. El orden inverso (publicar y luego
guardar) tiene el problema simétrico. No hay transacciones distribuidas
(2PC) entre Postgres y RabbitMQ que resuelvan esto de forma simple.

## Decisión

Cada servicio de dominio escribe su cambio de estado y su(s) evento(s)
saliente(s) en la misma transacción de Postgres, insertando el evento en
una tabla local `<esquema>.outbox`. Un proceso aparte (el "relay", en
`services/common`) hace polling de esa tabla cada 500 ms, publica lo
pendiente en RabbitMQ y solo marca la fila como publicada tras la
confirmación del broker (canal con `confirmChannel`).

## Consecuencias

### Positivas

- Elimina el problema de "doble escritura": la escritura en base de datos y
  la intención de publicar el evento son atómicas porque viven en la misma
  transacción SQL.
- No requiere transacciones distribuidas ni infraestructura adicional más
  allá de una tabla y un proceso de polling.
- Es un patrón fácil de explicar y de auditar: la tabla `outbox` es, en sí
  misma, el registro de qué se intentó publicar y cuándo.

### Negativas / trade-offs

- Entrega "al menos una vez": si el relay publica pero muere antes de
  marcar la fila como publicada, el evento se publica de nuevo en el
  siguiente tick. Esto obliga a que todo consumidor sea idempotente
  (ADR-0004).
- Añade latencia entre el `commit` y la publicación real (hasta el
  intervalo de polling, 500 ms en el prototipo).
- La tabla `outbox` crece indefinidamente si nada la purga; el prototipo no
  implementa limpieza/archivado, algo que un despliegue real necesitaría.

## Alternativas consideradas

- **Publicar directamente después del commit, dentro del mismo request** —
  descartada: un caído entre el commit y la publicación pierde el evento en
  silencio, sin ninguna traza de que debía haberse enviado.
- **CDC leyendo el WAL de Postgres (p. ej. Debezium)** — descartada para
  esta etapa: es más potente (sin latencia de polling, sin tabla outbox que
  mantener) pero exige infraestructura adicional (conector CDC, Kafka
  Connect o equivalente) desproporcionada para el alcance actual. Revisar
  si se adopta Kafka (ver ADR-0002) y ese costo ya está pagado.
