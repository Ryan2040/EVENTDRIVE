// events-service: dueño del agregado "Evento" (la BEO / banquete de MICE).
// Expone la API para cotizar y confirmar un evento, y reacciona cuando el
// bloqueo de habitaciones falla (saga por coreografía con compensación).

import express from 'express';
import {
  createPool,
  connectBus,
  startOutboxRelay,
  assertServiceQueue,
  hasProcessed,
  markProcessed,
} from '@hotel/common';

const SCHEMA = 'events_svc';
const SOURCE = 'events-service';
const PORT = 3001;

const pool = createPool();
const app = express();
app.use(express.json());

app.post('/eventos', async (req, res) => {
  const { nombre, salon, fechaInicio, fechaFin, habitaciones, cubiertos, menu } = req.body;
  if (!nombre || !salon || !fechaInicio || !fechaFin) {
    return res.status(400).json({ error: 'nombre, salon, fechaInicio y fechaFin son obligatorios' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {
      rows: [evento],
    } = await client.query(
      `INSERT INTO events_svc.eventos
         (nombre, salon, fecha_inicio, fecha_fin, habitaciones_bloqueadas, cubiertos, menu)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [nombre, salon, fechaInicio, fechaFin, habitaciones || 0, cubiertos || 0, menu || null],
    );
    await client.query(
      `INSERT INTO events_svc.outbox (aggregate_id, tipo, payload) VALUES ($1,$2,$3)`,
      [evento.id, 'EventoCotizado', JSON.stringify({ eventoId: evento.id, nombre, salon, fechaInicio, fechaFin })],
    );
    await client.query('COMMIT');
    res.status(201).json(evento);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[events-service]', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/eventos/:id/confirmar', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {
      rows: [evento],
    } = await client.query(`SELECT * FROM events_svc.eventos WHERE id = $1 FOR UPDATE`, [id]);

    if (!evento) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Evento no encontrado' });
    }
    if (!['COTIZADO', 'EN_RIESGO'].includes(evento.estado)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `No se puede confirmar un evento en estado ${evento.estado}` });
    }

    const {
      rows: [actualizado],
    } = await client.query(
      `UPDATE events_svc.eventos SET estado = 'CONFIRMADO', actualizado_en = now() WHERE id = $1 RETURNING *`,
      [id],
    );

    await client.query(
      `INSERT INTO events_svc.outbox (aggregate_id, tipo, payload) VALUES ($1,$2,$3)`,
      [
        id,
        'EventoConfirmado',
        JSON.stringify({
          eventoId: id,
          nombre: actualizado.nombre,
          salon: actualizado.salon,
          fechaInicio: actualizado.fecha_inicio,
          fechaFin: actualizado.fecha_fin,
          habitacionesBloqueadas: actualizado.habitaciones_bloqueadas,
          cubiertos: actualizado.cubiertos,
          menu: actualizado.menu,
        }),
      ],
    );

    await client.query('COMMIT');
    res.json(actualizado);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[events-service]', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/eventos', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM events_svc.eventos ORDER BY creado_en DESC');
  res.json(rows);
});

app.get('/eventos/:id', async (req, res) => {
  const {
    rows: [evento],
  } = await pool.query('SELECT * FROM events_svc.eventos WHERE id = $1', [req.params.id]);
  if (!evento) return res.status(404).json({ error: 'no encontrado' });
  res.json(evento);
});

// Compensación de la saga: si room-block-service no pudo bloquear las
// habitaciones, este evento marca la BEO como EN_RIESGO en vez de dejarla
// como CONFIRMADO sin respaldo de inventario.
async function manejarBloqueRechazado(evt) {
  const { eventoId, motivo } = evt.data;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (await hasProcessed(client, SCHEMA, evt.id)) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(
      `UPDATE events_svc.eventos SET estado = 'EN_RIESGO', actualizado_en = now() WHERE id = $1`,
      [eventoId],
    );
    await markProcessed(client, SCHEMA, evt.id);
    await client.query(
      `INSERT INTO events_svc.outbox (aggregate_id, tipo, payload) VALUES ($1,$2,$3)`,
      [eventoId, 'EventoEnRiesgo', JSON.stringify({ eventoId, motivo })],
    );
    await client.query('COMMIT');
    console.log(`[events-service] Evento ${eventoId} marcado EN_RIESGO: ${motivo}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[events-service] error procesando BloqueRechazado:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const { channel } = await connectBus();
  await startOutboxRelay(pool, channel, SCHEMA, { source: SOURCE });

  const queue = 'events-service.q';
  await assertServiceQueue(channel, queue, ['BloqueRechazado']);
  channel.consume(queue, async (msg) => {
    if (!msg) return;
    try {
      const evt = JSON.parse(msg.content.toString());
      if (evt.type === 'BloqueRechazado') await manejarBloqueRechazado(evt);
      channel.ack(msg);
    } catch (err) {
      console.error('[events-service] mensaje enviado a dead-letter:', err.message);
      channel.nack(msg, false, false);
    }
  });

  app.listen(PORT, () => console.log(`[events-service] escuchando en :${PORT}`));
}

main().catch((err) => {
  console.error('[events-service] error fatal:', err);
  process.exit(1);
});
