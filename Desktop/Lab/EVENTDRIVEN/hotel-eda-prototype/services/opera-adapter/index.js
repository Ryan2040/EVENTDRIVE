// opera-adapter: hace las veces del adaptador anti-corrupción hacia
// OPERA Cloud / OHIP (o Delphi / Simphony). En producción, este servicio
// sería un consumidor que hace polling a la API de Business Events de OHIP
// (o escucha su Streaming API), traduce cada evento de OPERA a un evento de
// dominio propio y lo publica en este mismo bus. Aquí lo simulamos con tres
// endpoints REST que un profesor o un estudiante puede invocar a mano.
//
// NOTA PEDAGÓGICA: este servicio publica directamente con publishEvent, sin
// pasar por el patrón outbox. Eso es correcto en este caso puntual porque no
// protege ningún estado propio en base de datos: es un simulador del mundo
// exterior. Los servicios de negocio (events-service, room-block-service,
// kitchen-service, folio-service) sí usan outbox + idempotencia, porque
// ellos necesitan que su escritura en base de datos y la emisión del evento
// sean una sola unidad atómica.

import express from 'express';
import { randomUUID } from 'node:crypto';
import { connectBus, publishEvent } from '@hotel/common';

const SOURCE = 'opera-adapter (simulador PMS/OHIP)';
const PORT = 3005;

const app = express();
app.use(express.json());

let channel;

app.post('/simulate/reserva', async (req, res) => {
  const { huesped, checkIn, checkOut, habitaciones } = req.body;
  if (!huesped || !checkIn || !checkOut) {
    return res.status(400).json({ error: 'huesped, checkIn y checkOut son obligatorios' });
  }
  const reservaId = randomUUID();
  const evt = await publishEvent(
    channel,
    'ReservaCreada',
    reservaId,
    { reservaId, huesped, checkIn, checkOut, habitaciones: habitaciones || 1 },
    { source: SOURCE },
  );
  console.log(`[opera-adapter] ReservaCreada publicada para ${huesped}`);
  res.status(202).json(evt);
});

app.post('/simulate/checkin', async (req, res) => {
  const { reservaId, habitacion } = req.body;
  if (!reservaId) return res.status(400).json({ error: 'reservaId es obligatorio' });
  const evt = await publishEvent(
    channel,
    'CheckInRealizado',
    reservaId,
    { reservaId, habitacion: habitacion || null, hora: new Date().toISOString() },
    { source: SOURCE },
  );
  console.log(`[opera-adapter] CheckInRealizado publicado para reserva ${reservaId}`);
  res.status(202).json(evt);
});

// Simula un cargo llegando desde el POS de F&B (Simphony) o el spa,
// asociado a un evento/folio. folio-service lo consume y lo suma al folio.
app.post('/simulate/cargo', async (req, res) => {
  const { eventoId, concepto, monto, origen } = req.body;
  if (!eventoId || !concepto || monto == null) {
    return res.status(400).json({ error: 'eventoId, concepto y monto son obligatorios' });
  }
  const evt = await publishEvent(
    channel,
    'CargoRegistrado',
    eventoId,
    { eventoId, concepto, monto: Number(monto), origen: origen || 'Simphony POS (simulado)' },
    { source: SOURCE },
  );
  console.log(`[opera-adapter] CargoRegistrado: $${monto} (${concepto}) -> evento ${eventoId}`);
  res.status(202).json(evt);
});

async function main() {
  const bus = await connectBus();
  channel = bus.channel;
  app.listen(PORT, () => console.log(`[opera-adapter] escuchando en :${PORT}`));
}

main().catch((err) => {
  console.error('[opera-adapter] error fatal:', err);
  process.exit(1);
});
