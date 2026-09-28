# ADR-0001: Arquitectura orientada a eventos sobre un backbone de mensajería

## Estado

Aceptada — 2026-09-28

## Contexto

El hotel opera hoy con integraciones punto a punto entre su PMS (OPERA
Cloud u OPERA 5), el sistema de sales & catering (Delphi o el módulo Sales
and Event de OPERA), el POS de F&B (Simphony), el spa y el channel manager.
Ese modelo concentra el dolor operativo señalado en la propuesta original:
riesgo de overbooking al confirmar bloques de grupo, conciliación manual de
cargos entre salón/cocina/habitaciones, y cada integración nueva exige
tocar y volver a probar los sistemas existentes.

El PMS y el sistema de sales & catering no son reemplazables a corto
plazo: los dicta en buena parte la marca (Marriott/Oracle/Amadeus), no el
hotel. Cualquier solución nueva tiene que convivir con ellos como sistemas
externos, no sustituirlos.

## Decisión

Construir un backbone de eventos: los servicios de dominio (eventos/BEO,
bloqueo de habitaciones, cocina, folio) publican eventos en un exchange
compartido (`hotel.events`) y se suscriben solo a los eventos que les
importan. Ningún servicio llama directamente a otro; toda coordinación
pasa por eventos. Un adaptador (`opera-adapter`) hace de capa
anti-corrupción hacia el PMS/POS reales.

## Consecuencias

### Positivas

- Desacopla los servicios de dominio entre sí y de los sistemas de marca:
  agregar un consumidor nuevo (por ejemplo, housekeeping) no requiere tocar
  a los productores existentes.
- Un consumidor caído no bloquea al resto del sistema ni al huésped en
  recepción.
- El propio flujo de eventos es una bitácora auditable de lo que pasó y
  cuándo (ver el tablero del prototipo).

### Negativas / trade-offs

- La mayor parte del sistema pasa a ser eventualmente consistente: hay una
  ventana (típicamente milisegundos) entre "el evento se confirmó" y "la
  cocina tiene su comanda". Para este dominio es aceptable; para el
  inventario de habitaciones no lo es del todo (ver ADR-0005).
- Depurar un flujo de punta a punta es más difícil que seguir una pila de
  llamadas síncronas; sin tracing distribuido (no incluido en el
  prototipo) hay que reconstruir la secuencia a partir de logs de varios
  servicios.
- Exige disciplina que no es gratis: cada consumidor debe ser idempotente
  (ADR-0004) y los contratos de evento deben versionarse con cuidado.

## Alternativas consideradas

- **Integraciones punto a punto ampliadas** — rechazada: es exactamente el
  patrón que genera el problema hoy; el costo de integración crece con el
  cuadrado del número de sistemas.
- **Orquestación síncrona vía REST únicamente** — rechazada: OHIP y Delphi
  ya exponen sus cambios como "business events" que hay que consumir; forzar
  todo a llamadas síncronas request/response no encaja con cómo el PMS
  realmente entrega su información, y no tolera con gracia que un sistema
  downstream esté momentáneamente caído.
