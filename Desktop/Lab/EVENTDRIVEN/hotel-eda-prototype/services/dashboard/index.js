// dashboard: proyección de lectura (CQRS) construida escuchando TODOS los
// eventos del exchange ("#"). No es fuente de verdad de nada — cada
// servicio de negocio manda en su propia base de datos — es solo una vista
// en memoria para ver el sistema moverse en vivo, empujada al navegador por
// Server-Sent Events.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectBus, assertServiceQueue } from '@hotel/common';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const eventosPorId = new Map();
const bitacora = [];
const MAX_BITACORA = 200;
const clientesSSE = new Set();

function enviarATodos(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clientesSSE) res.write(data);
}

function obtenerOCrearEvento(eventoId) {
  if (!eventosPorId.has(eventoId)) {
    eventosPorId.set(eventoId, {
      eventoId,
      nombre: null,
      salon: null,
      fechaInicio: null,
      fechaFin: null,
      cubiertos: null,
      estado: 'DESCONOCIDO',
      bloque: null,
      comanda: null,
      folio: null,
    });
  }
  return eventosPorId.get(eventoId);
}

function proyectar(evt) {
  const d = evt.data || {};
  const eventoId = d.eventoId;
  if (!eventoId) return;
  const ev = obtenerOCrearEvento(eventoId);

  switch (evt.type) {
    case 'EventoCotizado':
      Object.assign(ev, {
        nombre: d.nombre,
        salon: d.salon,
        fechaInicio: d.fechaInicio,
        fechaFin: d.fechaFin,
        estado: 'COTIZADO',
      });
      break;
    case 'EventoConfirmado':
      Object.assign(ev, {
        nombre: d.nombre,
        salon: d.salon,
        fechaInicio: d.fechaInicio,
        fechaFin: d.fechaFin,
        cubiertos: d.cubiertos,
        menu: d.menu,
        estado: 'CONFIRMADO',
      });
      break;
    case 'BloqueCreado':
      ev.bloque = { bloqueId: d.bloqueId, habitaciones: d.habitaciones, estado: 'CREADO' };
      break;
    case 'BloqueRechazado':
      ev.bloque = { estado: 'RECHAZADO', motivo: d.motivo };
      break;
    case 'EventoEnRiesgo':
      ev.estado = 'EN_RIESGO';
      break;
    case 'ComandaCreada':
      ev.comanda = { comandaId: d.comandaId, cubiertos: d.cubiertos, menu: d.menu, estado: 'PLANIFICADA' };
      break;
    case 'FolioAbierto':
      ev.folio = { folioId: d.folioId, total: 0 };
      break;
    case 'FolioActualizado':
      ev.folio = { folioId: d.folioId, total: d.total, ultimoCargo: { concepto: d.concepto, monto: d.monto } };
      break;
    default:
      break;
  }
}

app.get('/api/estado', (_req, res) => {
  res.json({ eventos: [...eventosPorId.values()], bitacora });
});

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');
  clientesSSE.add(res);
  req.on('close', () => clientesSSE.delete(res));
});

async function main() {
  const { channel } = await connectBus();
  const queue = 'dashboard.readmodel';
  await assertServiceQueue(channel, queue, ['#']);
  channel.consume(queue, (msg) => {
    if (!msg) return;
    try {
      const evt = JSON.parse(msg.content.toString());
      proyectar(evt);
      bitacora.unshift({ id: evt.id, tipo: evt.type, aggregateId: evt.aggregateId, time: evt.time, data: evt.data });
      if (bitacora.length > MAX_BITACORA) bitacora.length = MAX_BITACORA;
      enviarATodos({ evento: evt, eventos: [...eventosPorId.values()] });
      channel.ack(msg);
    } catch (err) {
      console.error('[dashboard] error procesando mensaje (se descarta, es solo una vista):', err.message);
      channel.ack(msg);
    }
  });

  app.listen(PORT, () => console.log(`[dashboard] escuchando en :${PORT}`));
}

main().catch((err) => {
  console.error('[dashboard] error fatal:', err);
  process.exit(1);
});
