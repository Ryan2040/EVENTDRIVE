// Librería compartida: conexión al bus de eventos (RabbitMQ), pool de
// Postgres, relay del patrón outbox e idempotencia. Cada servicio de
// dominio importa esto en vez de reimplementar la plomería de mensajería.

import amqp from 'amqplib';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;

const EXCHANGE = 'hotel.events'; // exchange topic: todos los eventos de dominio
const DLX = 'hotel.events.dlx'; // exchange de "cartas muertas"
const DLQ = 'hotel.events.dlq'; // cola donde caen los mensajes que fallan sin reintento

export function createPool() {
  return new Pool({ connectionString: process.env.DATABASE_URL });
}

/**
 * Conecta a RabbitMQ y deja listos el exchange principal y el circuito de
 * dead-letter. Usa un canal con confirmaciones (confirm channel) para saber
 * con certeza que el broker recibió cada publicación.
 */
export async function connectBus() {
  const conn = await amqp.connect(process.env.RABBITMQ_URL);
  const channel = await conn.createConfirmChannel();
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(DLX, 'fanout', { durable: true });
  await channel.assertQueue(DLQ, { durable: true });
  await channel.bindQueue(DLQ, DLX, '');

  conn.on('error', (err) => console.error('[bus] error de conexión:', err.message));
  conn.on('close', () => console.error('[bus] conexión a RabbitMQ cerrada'));

  return { conn, channel };
}

/**
 * Declara la cola de un servicio consumidor y la suscribe a una o más
 * routing keys sobre el exchange de eventos. La cola queda configurada con
 * dead-letter: un mensaje rechazado sin reintento (nack con requeue=false)
 * termina en hotel.events.dlq en vez de perderse.
 */
export async function assertServiceQueue(channel, queueName, routingKeys) {
  await channel.assertQueue(queueName, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': DLX },
  });
  for (const routingKey of routingKeys) {
    await channel.bindQueue(queueName, EXCHANGE, routingKey);
  }
}

/**
 * Publica un evento de dominio ya envuelto en un sobre con metadatos
 * (id, tipo, origen, marca de tiempo). No se llama directamente desde los
 * servicios de negocio para escrituras que cambian estado: esos usan el
 * patrón outbox (ver startOutboxRelay) para que la escritura en base de
 * datos y la publicación del evento sean una sola unidad atómica.
 */
export function publishEvent(channel, tipo, aggregateId, data, extra = {}) {
  const envelope = {
    id: extra.id || randomUUID(),
    type: tipo,
    source: extra.source || 'desconocido',
    aggregateId,
    time: new Date().toISOString(),
    data,
  };
  return new Promise((resolve, reject) => {
    channel.publish(
      EXCHANGE,
      tipo,
      Buffer.from(JSON.stringify(envelope)),
      { persistent: true, contentType: 'application/json', messageId: envelope.id },
      (err) => (err ? reject(err) : resolve(envelope)),
    );
  });
}

/**
 * Relay del patrón outbox: cada servicio de negocio escribe sus eventos
 * pendientes en su propia tabla <schema>.outbox, dentro de la MISMA
 * transacción en la que cambia su estado. Este relay corre aparte, lee lo
 * no publicado y lo saca al bus. Si el proceso muere entre el commit de la
 * transacción y la publicación, el evento sigue en la tabla y se publica en
 * el siguiente tick: nunca se pierde, aunque sí podría publicarse más de
 * una vez (por eso los consumidores son idempotentes).
 */
export async function startOutboxRelay(pool, channel, schema, { intervalMs = 500, source } = {}) {
  async function tick() {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        `SELECT * FROM ${schema}.outbox WHERE publicado = false ORDER BY creado_en ASC LIMIT 20`,
      );
      for (const row of rows) {
        await publishEvent(channel, row.tipo, row.aggregate_id, row.payload, { id: row.id, source });
        await client.query(
          `UPDATE ${schema}.outbox SET publicado = true, publicado_en = now() WHERE id = $1`,
          [row.id],
        );
      }
    } finally {
      client.release();
    }
  }

  setInterval(() => {
    tick().catch((err) => console.error(`[outbox:${schema}]`, err.message));
  }, intervalMs);
}

/** ¿Ya procesamos este evento? Clave de idempotencia por servicio consumidor. */
export async function hasProcessed(client, schema, eventId) {
  const { rows } = await client.query(
    `SELECT 1 FROM ${schema}.processed_events WHERE event_id = $1`,
    [eventId],
  );
  return rows.length > 0;
}

/** Marca un evento como procesado (dentro de la misma transacción de negocio). */
export async function markProcessed(client, schema, eventId) {
  await client.query(
    `INSERT INTO ${schema}.processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [eventId],
  );
}
