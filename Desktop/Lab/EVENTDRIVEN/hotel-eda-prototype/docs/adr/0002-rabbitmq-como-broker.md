# ADR-0002: RabbitMQ (no Kafka) como broker de mensajería

## Estado

Aceptada — 2026-09-28

## Contexto

La propuesta inicial consideró Kafka o Redpanda como backbone, pensando en
un despliegue multi-propiedad con alto volumen de eventos y necesidad de
replay/analítica de largo plazo. El alcance real de este prototipo es un
solo hotel (257 habitaciones), con un volumen de eventos moderado — miles
por hora en el peor pico de un evento MICE grande, no un flujo continuo de
alto throughput. El equipo que va a operar esto necesita algo simple de
levantar, entender y depurar.

## Decisión

Usar RabbitMQ con un exchange topic durable (`hotel.events`) y una cola
durable por servicio consumidor, enlazada por routing key (el tipo de
evento). Cada cola declara un exchange de dead-letter para los mensajes
que un consumidor rechaza sin pedir reintento.

## Consecuencias

### Positivas

- Operación más simple que un clúster Kafka: un solo contenedor, sin
  Zookeeper/KRaft, sin particiones que dimensionar de antemano.
- El enrutamiento por topic (`EventoConfirmado`, `Bloque*`, etc.) es directo
  y expresivo para este catálogo de eventos.
- Sigue siendo mensajería durable y persistente: sobrevive un reinicio del
  broker.
- Menor costo de infraestructura para una sola propiedad.

### Negativas / trade-offs

- RabbitMQ no retiene el log de mensajes una vez consumidos y confirmados
  (salvo lo que caiga en la dead-letter queue); no hay "replay" del
  historial completo como en Kafka. Si más adelante se necesita reprocesar
  meses de eventos para analítica, esto no lo da gratis.
- Escalar el paralelismo de un consumidor es más tosco que las particiones
  de Kafka (se basa en múltiples consumidores compitiendo por la misma
  cola, sin el ordenamiento por clave que dan las particiones).
- Si el hotel crece a portafolio multi-propiedad con necesidad real de
  analítica de streaming, esta decisión debería revisarse.

## Alternativas consideradas

- **Kafka / Redpanda** — descartada por ahora: la complejidad operativa no
  se justifica a esta escala. Revisar si el alcance crece a varias
  propiedades o aparece una necesidad real de replay/analítica de streaming.
- **Cola gestionada de un proveedor cloud (SQS, Azure Service Bus)** —
  descartada: ataría el diseño a un proveedor de nube antes de que el hotel
  defina su estrategia de hosting.
