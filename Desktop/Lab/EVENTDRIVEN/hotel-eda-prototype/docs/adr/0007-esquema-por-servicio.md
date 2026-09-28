# ADR-0007: Un esquema de Postgres por servicio, una sola instancia

## Estado

Aceptada — 2026-09-28

## Contexto

Cada servicio de dominio necesita ser dueño exclusivo de sus datos — nadie
más debería leer o escribir sus tablas directamente — pero levantar y
operar cuatro instancias de Postgres separadas es un costo de
infraestructura que no se justifica en esta etapa del proyecto.

## Decisión

Una sola instancia de Postgres, con un esquema por servicio
(`events_svc`, `roomblock_svc`, `kitchen_svc`, `folio_svc`). Cada servicio
se conecta con su propio pool y solo consulta su propio esquema.

## Consecuencias

### Positivas

- Da la regla "cada servicio es dueño de sus datos" sin el costo operativo
  de administrar varios servidores de base de datos.
- Simplifica sembrar, resetear y respaldar el entorno de desarrollo como una
  sola unidad.

### Negativas / trade-offs

- Los esquemas comparten la misma instancia física: un problema de recursos
  en un esquema (una consulta pesada, un bloqueo largo) puede afectar a los
  demás, y la instancia sigue siendo un único punto de falla a nivel de
  infraestructura.
- Nada a nivel de permisos de base de datos impide hoy que el código de un
  servicio consulte el esquema de otro — es una convención que sostiene el
  código, no una frontera dura. Antes de producción conviene reforzarla con
  roles y `GRANT`s por esquema.

## Alternativas consideradas

- **Una instancia de base de datos por servicio desde el día uno** —
  descartada para el prototipo: multiplica la infraestructura a mantener sin
  beneficio todavía; revisar si el perfil de carga de un servicio diverge
  claramente del resto.
- **Un único esquema compartido con tablas prefijadas** — descartada:
  comunica peor la propiedad de los datos y facilita acoplar dos servicios
  sin querer a través de una tabla compartida.
