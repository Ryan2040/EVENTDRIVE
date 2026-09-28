// kitchen-service: crea la comanda de banquetes (menú + cubiertos) en
// cuanto un evento queda confirmado, en paralelo con el bloqueo de
// habitaciones. Nadie tuvo que llamar a nadie: ambos reaccionan al mismo
// EventoConfirmado.

import express from 'express';
import {
  createPool,
  connectBus,
  startOutboxRelay,
  assertServiceQueue,
  hasProcessed,
  markProcessed,
} from '@hotel/common';

const SCHEMA = 'kitchen_svc';
const SOURCE = 'kitchen-service';
const PORT = 3003;

const pool = createPool();
const app = express();
app.use(express.json());

async function manejarEventoConfirmado(evt) {
  const { eventoId, cubiertos, menu } = evt.data;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (await hasProcessed(client, SCHEMA, evt.id)) {
      await client.query('ROLLBACK');
      return;
    }

    const {
      rows: [comanda],
    } = await client.query(
      `INSERT INTO kitchen_svc.comandas (evento_id, cubiertos, menu) VALUES ($1,$2,$3) RETURNING id`,
      [eventoId, cubiertos || 0, menu || null],
    );

    await markProcessed(client, SCHEMA, evt.id);
    await client.query(
      `INSERT INTO kitchen_svc.outbox (aggregate_id, tipo, payload) VALUES ($1,$2,$3)`,
      [eventoId, 'ComandaCreada', JSON.stringify({ eventoId, comandaId: comanda.id, cubiertos, menu })],
    );

    await client.query('COMMIT');
    console.log(`[kitchen-service] Comanda ${comanda.id} creada para evento ${eventoId} (${cubiertos} cubiertos)`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

app.get('/comandas', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM kitchen_svc.comandas ORDER BY creado_en DESC');
  res.json(rows);
});

async function main() {
  const { channel } = await connectBus();
  await startOutboxRelay(pool, channel, SCHEMA, { source: SOURCE });

  const queue = 'kitchen-service.q';
  await assertServiceQueue(channel, queue, ['EventoConfirmado']);
  channel.consume(queue, async (msg) => {
    if (!msg) return;
    try {
      const evt = JSON.parse(msg.content.toString());
      await manejarEventoConfirmado(evt);
      channel.ack(msg);
    } catch (err) {
      console.error('[kitchen-service] mensaje enviado a dead-letter:', err.message);
      channel.nack(msg, false, false);
    }
  });

  app.listen(PORT, () => console.log(`[kitchen-service] escuchando en :${PORT}`));
}

main().catch((err) => {
  console.error('[kitchen-service] error fatal:', err);
  process.exit(1);
});
