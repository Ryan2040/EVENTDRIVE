// room-block-service: dueño del inventario de habitaciones y de los
// bloques de grupo. Es el único punto con consistencia fuerte del sistema:
// bloquea (FOR UPDATE) las filas de disponibilidad involucradas antes de
// decidir, para que dos eventos confirmados a la vez no sobrevendan el
// mismo rango de fechas.

import express from 'express';
import {
  createPool,
  connectBus,
  startOutboxRelay,
  assertServiceQueue,
  hasProcessed,
  markProcessed,
} from '@hotel/common';

const SCHEMA = 'roomblock_svc';
const SOURCE = 'room-block-service';
const PORT = 3002;

const pool = createPool();
const app = express();
app.use(express.json());

function diasEnRango(fechaInicioISO, fechaFinISO) {
  const dias = [];
  const inicio = new Date(fechaInicioISO);
  const fin = new Date(fechaFinISO);
  const cursor = new Date(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth(), inicio.getUTCDate()));
  const finDia = new Date(Date.UTC(fin.getUTCFullYear(), fin.getUTCMonth(), fin.getUTCDate()));
  while (cursor <= finDia) {
    dias.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dias;
}

async function manejarEventoConfirmado(evt) {
  const { eventoId, salon, fechaInicio, fechaFin, habitacionesBloqueadas } = evt.data;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (await hasProcessed(client, SCHEMA, evt.id)) {
      await client.query('ROLLBACK');
      return;
    }

    const dias = diasEnRango(fechaInicio, fechaFin);
    const { rows: disponibilidad } = await client.query(
      `SELECT fecha::text AS fecha, habitaciones_disponibles
         FROM roomblock_svc.disponibilidad
        WHERE fecha = ANY($1::date[])
        FOR UPDATE`,
      [dias],
    );
    const porFecha = new Map(disponibilidad.map((r) => [r.fecha, r.habitaciones_disponibles]));
    const faltante = dias.find((d) => (porFecha.get(d) ?? 0) < habitacionesBloqueadas);

    if (faltante) {
      await markProcessed(client, SCHEMA, evt.id);
      await client.query(
        `INSERT INTO roomblock_svc.outbox (aggregate_id, tipo, payload) VALUES ($1,$2,$3)`,
        [
          eventoId,
          'BloqueRechazado',
          JSON.stringify({
            eventoId,
            motivo: `Sin disponibilidad suficiente el ${faltante} (solicitadas: ${habitacionesBloqueadas})`,
          }),
        ],
      );
      await client.query('COMMIT');
      console.log(`[room-block-service] Rechazado evento ${eventoId}: sin disponibilidad el ${faltante}`);
      return;
    }

    for (const dia of dias) {
      await client.query(
        `UPDATE roomblock_svc.disponibilidad
            SET habitaciones_disponibles = habitaciones_disponibles - $1
          WHERE fecha = $2::date`,
        [habitacionesBloqueadas, dia],
      );
    }

    const {
      rows: [bloque],
    } = await client.query(
      `INSERT INTO roomblock_svc.bloques (evento_id, fecha_inicio, fecha_fin, habitaciones)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [eventoId, fechaInicio, fechaFin, habitacionesBloqueadas],
    );

    await markProcessed(client, SCHEMA, evt.id);
    await client.query(
      `INSERT INTO roomblock_svc.outbox (aggregate_id, tipo, payload) VALUES ($1,$2,$3)`,
      [
        eventoId,
        'BloqueCreado',
        JSON.stringify({
          eventoId,
          bloqueId: bloque.id,
          salon,
          fechaInicio,
          fechaFin,
          habitaciones: habitacionesBloqueadas,
        }),
      ],
    );

    await client.query('COMMIT');
    console.log(
      `[room-block-service] Bloque ${bloque.id} creado para evento ${eventoId} (${habitacionesBloqueadas} habitaciones)`,
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

app.get('/bloques', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM roomblock_svc.bloques ORDER BY creado_en DESC');
  res.json(rows);
});

app.get('/disponibilidad', async (req, res) => {
  const limite = Number(req.query.dias) || 14;
  const { rows } = await pool.query(
    `SELECT fecha::text AS fecha, habitaciones_totales, habitaciones_disponibles
       FROM roomblock_svc.disponibilidad
      WHERE fecha >= CURRENT_DATE
      ORDER BY fecha
      LIMIT $1`,
    [limite],
  );
  res.json(rows);
});

async function main() {
  const { channel } = await connectBus();
  await startOutboxRelay(pool, channel, SCHEMA, { source: SOURCE });

  const queue = 'room-block-service.q';
  await assertServiceQueue(channel, queue, ['EventoConfirmado']);
  channel.consume(queue, async (msg) => {
    if (!msg) return;
    try {
      const evt = JSON.parse(msg.content.toString());
      await manejarEventoConfirmado(evt);
      channel.ack(msg);
    } catch (err) {
      console.error('[room-block-service] mensaje enviado a dead-letter:', err.message);
      channel.nack(msg, false, false);
    }
  });

  app.listen(PORT, () => console.log(`[room-block-service] escuchando en :${PORT}`));
}

main().catch((err) => {
  console.error('[room-block-service] error fatal:', err);
  process.exit(1);
});
