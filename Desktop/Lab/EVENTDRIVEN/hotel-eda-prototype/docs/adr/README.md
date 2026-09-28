# Registro de Decisiones de Arquitectura (ADR)

Cada archivo de esta carpeta documenta una decisión de arquitectura del
prototipo: el problema que la motivó, qué se decidió, qué alternativas se
descartaron y por qué, y qué consecuencias (buenas y malas) trae. Formato
Nygard clásico — el más liviano de los estándares de ADR, suficiente para
un proyecto de este tamaño.

## Índice

| ADR | Decisión |
|---|---|
| [0001](0001-arquitectura-orientada-a-eventos.md) | Arquitectura orientada a eventos sobre un backbone de mensajería |
| [0002](0002-rabbitmq-como-broker.md) | RabbitMQ (no Kafka) como broker de mensajería |
| [0003](0003-patron-outbox.md) | Patrón Outbox transaccional para publicar eventos |
| [0004](0004-idempotencia-en-consumidores.md) | Idempotencia en cada consumidor como contraparte del Outbox |
| [0005](0005-consistencia-fuerte-inventario.md) | Consistencia fuerte para el inventario de habitaciones |
| [0006](0006-saga-por-coreografia.md) | Saga por coreografía (no orquestada) para confirmar un evento |
| [0007](0007-esquema-por-servicio.md) | Un esquema de Postgres por servicio, una sola instancia |

## Cómo añadir una nueva

Copia [`0000-template.md`](0000-template.md), numera el archivo
correlativamente y llena las secciones. Un ADR no se edita para cambiar de
opinión: si una decisión se revierte, se escribe un ADR nuevo que la
reemplaza y se marca la vieja como "Reemplazada por ADR-XXXX".
