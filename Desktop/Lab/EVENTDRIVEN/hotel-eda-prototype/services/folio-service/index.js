// folio-service: abre el folio consolidado del evento en cuanto se crea el
// bloque de habitaciones, y va sumando cada cargo (banquete, F&B, spa) a
// medida que llega desde el adaptador de OPERA/Simphony. Es la pieza que
// resuelve la conciliación de cargos entre salón, cocina y habitaciones.

import express from 'express';
import {
  createPool,
  connectBus,
  startOutboxRelay,
  assertServiceQueue,
  hasProcessed,
  markProcessed,
} from '@hotel/common';

const SCHEMA = 'folio_svc';
const SOURCE = 'folio-service';
const PORT = 3004;

const pool = createPool();
const app = express();
app.use(express.json());

async function abrirFolioSiNoExiste(client, eventoId) {
  const {
    rows: [existente],
  } = await client.query(`SELECT * FROM folio_svc.folios WHERE evento_id = $1`, [eventoId]);
  if (existente) return existente;
  const {
    rows: [folio],
  } = await client.query(`INSERT INTO folio_svc.folios (evento_id) VALUES ($1) RETURNING *`, [eventoId]);
  return folio;
}

async function manejarBloqueCreado(evt) {
  const { eventoId } = evt.data;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (await hasProcessed(client, SCHEMA, evt.id)) {
      await client.query('ROLLBACK');
      return;
    }

    const folio = await abrirFolioSiNoExiste(client, eventoId);

    await markProcessed(client, SCHEMA, evt.id);
    await client.query(
      `INSERT INTO folio_svc.outbox (aggregate_id, tipo, payload) VALUES ($1,$2,$3)`,
      [eventoId, 'FolioAbierto', JSON.stringify({ eventoId, folioId: folio.id })],
    );

    await client.query('COMMIT');
    console.log(`[folio-service] Folio ${folio.id} abierto para evento ${eventoId}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function manejarCargoRegistrado(evt) {
  const { eventoId, concepto, monto, origen } = evt.data;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (await hasProcessed(client, SCHEMA, evt.id)) {
      await client.query('ROLLBACK');
      return;
    }

    const folio = await abrirFolioSiNoExiste(client, eventoId);

    await client.query(
      `INSERT INTO folio_svc.cargos (folio_id, concepto, origen, monto) VALUES ($1,$2,$3,$4)`,
      [folio.id, concepto, origen || null, monto],
    );
    const {
      rows: [actualizado],
    } = await client.query(
      `UPDATE folio_svc.folios SET total = total + $1 WHERE id = $2 RETURNING *`,
      [monto, folio.id],
    );

    await markProcessed(client, SCHEMA, evt.id);
    await client.query(
      `INSERT INTO folio_svc.outbox (aggregate_id, tipo, payload) VALUES ($1,$2,$3)`,
      [
        eventoId,
        'FolioActualizado',
        JSON.stringify({ eventoId, folioId: folio.id, concepto, monto, total: actualizado.total }),
      ],
    );

    await client.query('COMMIT');
    console.log(
      `[folio-service] Cargo de $${monto} (${concepto}) aplicado al folio del evento ${eventoId}, total: $${actualizado.total}`,
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

app.get('/folios/:eventoId', async (req, res) => {
  const {
    rows: [folio],
  } = await pool.query('SELECT * FROM folio_svc.folios WHERE evento_id = $1', [req.params.eventoId]);
  if (!folio) return res.status(404).json({ error: 'no encontrado' });
  const { rows: cargos } = await pool.query(
    'SELECT * FROM folio_svc.cargos WHERE folio_id = $1 ORDER BY creado_en',
    [folio.id],
  );
  res.json({ ...folio, cargos });
});

async function main() {
  const { channel } = await connectBus();
  await startOutboxRelay(pool, channel, SCHEMA, { source: SOURCE });

  const queue = 'folio-service.q';
  await assertServiceQueue(channel, queue, ['BloqueCreado', 'CargoRegistrado']);
  channel.consume(queue, async (msg) => {
    if (!msg) return;
    try {
      const evt = JSON.parse(msg.content.toString());
      if (evt.type === 'BloqueCreado') await manejarBloqueCreado(evt);
      else if (evt.type === 'CargoRegistrado') await manejarCargoRegistrado(evt);
      channel.ack(msg);
    } catch (err) {
      console.error('[folio-service] mensaje enviado a dead-letter:', err.message);
      channel.nack(msg, false, false);
    }
  });

  app.listen(PORT, () => console.log(`[folio-service] escuchando en :${PORT}`));
}

main().catch((err) => {
  console.error('[folio-service] error fatal:', err);
  process.exit(1);
});
