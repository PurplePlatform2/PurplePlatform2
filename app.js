const path = require('path');
const fs = require('fs');
const Fastify = require('fastify');
const { exec } = require('child_process');
const fetch = require('node-fetch');

const fastify = Fastify({ logger: true });

const users = new Map();         // Map<token, { token, subscribedAt }>
const runningTrades = new Set(); // Set<token>

// Serve index.html
fastify.get('/', async (req, reply) => {
  const filePath = path.join(__dirname, 'index.html');
  reply.type('text/html').send(fs.readFileSync(filePath, 'utf-8'));
});

// Subscribe user with token only
fastify.post('/subscribe', async (req, reply) => {
  const { token } = req.body;
  if (!token) return reply.code(400).send({ error: 'Token is required' });

  users.set(token, { token, subscribedAt: Date.now() });
  reply.send({ success: true, message: 'Subscribed successfully' });
});

// Unsubscribe user
fastify.post('/unsubscribe', async (req, reply) => {
  const { token } = req.body;
  if (!token) return reply.code(400).send({ error: 'Token is required' });

  users.delete(token);
  reply.send({ success: true, message: 'Unsubscribed successfully' });
});

// Check subscription
fastify.post('/check', async (req, reply) => {
  const { token } = req.body;
  if (!token) return reply.code(200).send({ error: 'Token is required' });

  reply.send({ subscribed: users.has(token) });
});

// Trade endpoint: fetch prediction + run trade.js per user
fastify.get('/trade', async (req, reply) => {
  if (runningTrades.size > 0) {
    return reply.code(429).send({ error: 'Trade already running for some users.' });
  }

  let prediction;
  try {
    const res = await fetch('https://purplebot-official.onrender.com/predict');
    prediction = (await res.text()).trim();
  } catch (err) {
    return reply.code(500).send({ error: 'Prediction fetch failed', details: err.message });
  }

  const promises = [];

  for (const [token, info] of users.entries()) {
    if (runningTrades.has(token)) continue;
    runningTrades.add(token);

    const cmd = `node trade.js ${token} ${prediction}`;
    const promise = new Promise((resolve) => {
      exec(cmd, (error, stdout, stderr) => {
        runningTrades.delete(token);
        if (error) {
          resolve({ token, error: stderr || error.message });
        } else {
          resolve({ token, result: stdout.trim() });
        }
      });
    });

    promises.push(promise);
  }

  const results = await Promise.all(promises);
  reply.send(results);
});

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' });
    console.log('Server running at http://localhost:3000');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
