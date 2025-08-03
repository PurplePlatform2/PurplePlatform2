const path = require('path');
const fs = require('fs');
const Fastify = require('fastify');
const { exec } = require('child_process');
const fetch = require('node-fetch');
const pLimit = require('p-limit');

const fastify = Fastify();
fastify.register(require('@fastify/cors'));
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname),
  prefix: '/',
});

const users = new Map();         // Map<token, { token, subscribedAt }>
const runningTrades = new Set(); // Set<token>
const serverStartTime = Date.now();
const MAX_PARALLEL_TRADES = 5;

// Serve index.html on root
fastify.get('/', async (req, reply) => {
  const filePath = path.join(__dirname, 'index.html');
  return reply.type('text/html').send(await fs.promises.readFile(filePath, 'utf-8'));
});

// Subscribe endpoint
fastify.post('/subscribe', async (req, reply) => {
  const { token } = req.body;
  if (!token) return reply.code(400).send({ error: 'Token is required' });
  users.set(token, { token, subscribedAt: Date.now() });
  console.log("✊ Registered token:", token);
  return reply.send({ success: true, message: 'Subscribed successfully' });
});

// Unsubscribe endpoint
fastify.post('/unsubscribe', async (req, reply) => {
  const { token } = req.body;
  if (!token) return reply.code(400).send({ error: 'Token is required' });
  users.delete(token);
  runningTrades.delete(token); // Clean up in case trade was running
  console.log("❌ Deleted token:", token);
  return reply.send({ success: true, message: 'Unsubscribed successfully' });
});

// Check subscription
fastify.post('/check', async (req, reply) => {
  const { token } = req.body;
  if (!token) return reply.code(400).send({ error: 'Token is required' });
  return reply.send({ subscribed: users.has(token) });
});

// Trade endpoint
fastify.get('/trade', async (req, reply) => {
  const activeUsers = Array.from(users.entries()).filter(
    ([token]) => !runningTrades.has(token)
  );

  if (activeUsers.length === 0) {
    console.log("⚠️ No available users to trade.");
    return reply.send({ message: 'No available users to trade.' });
  }

  let prediction;
  try {
    const res = await fetch('https://purplebot-official.onrender.com/predict');
    prediction = (await res.text()).trim();
    console.log("📈 Prediction fetched:", prediction);
  } catch (err) {
    return reply.code(500).send({ error: 'Prediction fetch failed', details: err.message });
  }

  const limit = pLimit(MAX_PARALLEL_TRADES);
  const promises = activeUsers.map(([token]) => {
    runningTrades.add(token);
    const cmd = `node trade.js ${token} ${prediction}`;
    console.log(`🚀 Launching trade for ${token}: ${cmd}`);

    return limit(() =>
      new Promise((resolve) => {
        const process = exec(cmd);

        process.stdout.on('data', (data) => {
          console.log(`📤 ${token} STDOUT: ${data.trim()}`);
        });

        process.stderr.on('data', (data) => {
          console.error(`🛑 ${token} STDERR: ${data.trim()}`);
        });

        process.on('close', (code) => {
          runningTrades.delete(token);
          if (code === 0) {
            resolve({ token, result: `Trade completed successfully` });
          } else {
            resolve({ token, error: `Trade exited with code ${code}` });
          }
        });

        process.on('error', (err) => {
          runningTrades.delete(token);
          console.error(`❌ ${token} ERROR: ${err.message}`);
          resolve({ token, error: err.message });
        });
      })
    );
  });

  const results = await Promise.all(promises);
  return reply.send(results);
});

// Stats endpoint
fastify.get('/stat', async (req, reply) => {
  return reply.send({
    totalSubscribers: users.size,
    runningTrades: [...runningTrades],
    currentTime: new Date().toISOString(),
    startTime: new Date(serverStartTime).toISOString(),
    uptime: Math.floor((Date.now() - serverStartTime) / 1000)
  });
});

// Start server
const start = async () => {
  try {
    await fastify.listen({
      port: process.env.PORT || 3000,
      host: '0.0.0.0'
    });
    console.log(`✅ Server running at port ${fastify.server.address().port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
