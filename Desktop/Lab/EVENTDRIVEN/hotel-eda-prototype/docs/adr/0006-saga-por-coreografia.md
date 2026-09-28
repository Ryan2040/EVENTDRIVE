# ADR-0006: Saga por coreografía (no orquestada) para confirmar un evento

## Estado

Aceptada — 2026-09-28

## Contexto

Confirmar un evento de banquetes dispara varios efectos: bloquear
habitaciones, crear la comanda de cocina y, si el bloqueo tiene éxito, abrir
el folio consolidado. Hay un camino de falla que debe compensarse en vez de
ignorarse: si no hay habitaciones suficientes, el evento no puede quedar
como "confirmado" sin respaldo real de inventario.

## Decisión

Implementar esto como una saga por coreografía: cada servicio reacciona a
los eventos que le interesan y publica los suyos propios, sin que nadie
orqueste el flujo desde un punto central. `events-service` compensa
escuchando `BloqueRechazado` y moviendo el evento a `EN_RIESGO`.

## Consecuencias

### Positivas

- Menos piezas para un flujo de tres o cuatro pasos: no hace falta
  construir, desplegar ni monitorear un servicio orquestador aparte.
- Es consistente con el resto del sistema: todo se coordina por eventos, sin
  excepciones.

### Negativas / trade-offs

- La compensación es fácil de dejar incompleta, y el prototipo lo demuestra
  en vivo: al correr el escenario de rechazo, `kitchen-service` igual crea
  la comanda, porque reacciona a `EventoConfirmado` de forma independiente
  y nadie le dijo que escuchara `BloqueRechazado`/`EventoEnRiesgo`. No hay
  un solo lugar que obligue a que cada rama nueva de la saga recuerde
  suscribirse a la compensación correspondiente.
- Ese riesgo crece con el número de pasos: cuantas más ramas reaccionen al
  evento inicial, más fácil es olvidar una compensación. Si el flujo de
  MICE crece más allá de estos tres o cuatro pasos, o gana más caminos de
  falla que deban revertirse, conviene revisar esta decisión.

## Alternativas consideradas

- **Saga orquestada con un coordinador central (máquina de estados)** —
  descartada para el alcance actual: añade un servicio y código explícito de
  máquina de estados para un flujo que hoy tiene solo tres pasos. El
  trade-off documentado arriba (compensación fácil de olvidar) es
  precisamente la señal para reconsiderar esta alternativa si el flujo
  crece.
