-- Se ejecuta automáticamente al crear el contenedor de Postgres
-- (docker-entrypoint-initdb.d). Un esquema por servicio: cada uno
-- es dueño exclusivo de sus tablas, nadie más las toca directamente.

CREATE SCHEMA IF NOT EXISTS events_svc;
CREATE SCHEMA IF NOT EXISTS roomblock_svc;
CREATE SCHEMA IF NOT EXISTS kitchen_svc;
CREATE SCHEMA IF NOT EXISTS folio_svc;

-- ============================================================
-- events_svc: dueño del agregado "Evento" (BEO / banquetes)
-- ============================================================
CREATE TABLE events_svc.eventos (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre                   TEXT NOT NULL,
    salon                    TEXT NOT NULL,
    fecha_inicio             TIMESTAMPTZ NOT NULL,
    fecha_fin                TIMESTAMPTZ NOT NULL,
    habitaciones_bloqueadas  INT NOT NULL DEFAULT 0,
    cubiertos                INT NOT NULL DEFAULT 0,
    menu                     TEXT,
    estado                   TEXT NOT NULL DEFAULT 'COTIZADO',
    creado_en                TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE events_svc.outbox (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_id  UUID NOT NULL,
    tipo          TEXT NOT NULL,
    payload       JSONB NOT NULL,
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
    publicado     BOOLEAN NOT NULL DEFAULT false,
    publicado_en  TIMESTAMPTZ
);
CREATE INDEX idx_events_outbox_pendientes ON events_svc.outbox (creado_en) WHERE publicado = false;

CREATE TABLE events_svc.processed_events (
    event_id     UUID PRIMARY KEY,
    procesado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- roomblock_svc: inventario de habitaciones y bloques de grupo
-- ============================================================
CREATE TABLE roomblock_svc.disponibilidad (
    fecha                     DATE PRIMARY KEY,
    habitaciones_totales      INT NOT NULL,
    habitaciones_disponibles  INT NOT NULL
);

CREATE TABLE roomblock_svc.bloques (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evento_id     UUID NOT NULL,
    fecha_inicio  TIMESTAMPTZ NOT NULL,
    fecha_fin     TIMESTAMPTZ NOT NULL,
    habitaciones  INT NOT NULL,
    estado        TEXT NOT NULL DEFAULT 'CREADO',
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE roomblock_svc.outbox (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_id  UUID NOT NULL,
    tipo          TEXT NOT NULL,
    payload       JSONB NOT NULL,
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
    publicado     BOOLEAN NOT NULL DEFAULT false,
    publicado_en  TIMESTAMPTZ
);
CREATE INDEX idx_roomblock_outbox_pendientes ON roomblock_svc.outbox (creado_en) WHERE publicado = false;

CREATE TABLE roomblock_svc.processed_events (
    event_id     UUID PRIMARY KEY,
    procesado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Semilla: disponibilidad para los próximos 120 días.
-- 257 habitaciones totales, como el JW Marriott Quito.
INSERT INTO roomblock_svc.disponibilidad (fecha, habitaciones_totales, habitaciones_disponibles)
SELECT d::date, 257, 257
FROM generate_series(CURRENT_DATE, CURRENT_DATE + INTERVAL '120 days', INTERVAL '1 day') AS d;

-- ============================================================
-- kitchen_svc: comandas de banquetes (cocina / F&B de eventos)
-- ============================================================
CREATE TABLE kitchen_svc.comandas (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evento_id  UUID NOT NULL,
    cubiertos  INT NOT NULL,
    menu       TEXT,
    estado     TEXT NOT NULL DEFAULT 'PLANIFICADA',
    creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE kitchen_svc.outbox (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_id  UUID NOT NULL,
    tipo          TEXT NOT NULL,
    payload       JSONB NOT NULL,
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
    publicado     BOOLEAN NOT NULL DEFAULT false,
    publicado_en  TIMESTAMPTZ
);
CREATE INDEX idx_kitchen_outbox_pendientes ON kitchen_svc.outbox (creado_en) WHERE publicado = false;

CREATE TABLE kitchen_svc.processed_events (
    event_id     UUID PRIMARY KEY,
    procesado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- folio_svc: folio consolidado y cargos (habitación, F&B, spa)
-- ============================================================
CREATE TABLE folio_svc.folios (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evento_id  UUID NOT NULL UNIQUE,
    estado     TEXT NOT NULL DEFAULT 'ABIERTO',
    total      NUMERIC(12,2) NOT NULL DEFAULT 0,
    creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE folio_svc.cargos (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    folio_id   UUID NOT NULL REFERENCES folio_svc.folios(id),
    concepto   TEXT NOT NULL,
    origen     TEXT,
    monto      NUMERIC(12,2) NOT NULL,
    creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE folio_svc.outbox (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_id  UUID NOT NULL,
    tipo          TEXT NOT NULL,
    payload       JSONB NOT NULL,
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
    publicado     BOOLEAN NOT NULL DEFAULT false,
    publicado_en  TIMESTAMPTZ
);
CREATE INDEX idx_folio_outbox_pendientes ON folio_svc.outbox (creado_en) WHERE publicado = false;

CREATE TABLE folio_svc.processed_events (
    event_id     UUID PRIMARY KEY,
    procesado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
