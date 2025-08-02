const path = require('path');
const fs = require('fs');
const Fastify = require('fastify');
const { exec } = require('child_process');
const fetch = require('node-fetch');

const fastify = Fastify({ logger: true });

// Enable CORS
fastify.register(require('@fastify/cors'));

// Serve static files (including index.html, styles.css, etc.)
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname),   // Serve from current directory
  prefix: '/',                  // Serve at root (e.g., /styles.css)
});

// Store users and running trade states
const users = new Map();        // Map<token, { token, subscribedAt }>
const runningTrades = new Set(); // Set<token>
const serverStartTime = Date.now(); // Server start time for uptime

// Serve index.html on root
fastify.get('/', async (req, reply) => {
  const filePath = path.join(__dirname, 'index.html');
  return reply.type('text/html').send(fs.readFileSync(filePath, 'utf-8'));
});

// Subscribe endpoint
fastify.post('/subscribe', async (req, reply) => {
  const { token } = req.body;
  if (!token) return reply.code(400).send({ error: 'Token is required' });

  users.set(token, { token, subscribedAt: Date.now() });
  return reply.send({ success: true, message: 'Subscribed successfully' });
});

// Unsubscribe endpoint
fastify.post('/unsubscribe', async (req, reply) => {
  const { token } = req.body;
  if (!token) return reply.code(400).send({ error: 'Token is required' });

  users.delete(token);
  return reply.send({ success: true, message: 'Unsubscribed successfully' });
});

// Check subscription status
fastify.post('/check', async (req, reply) => {
  const { token } = req.body;
  if (!token) return reply.code(400).send({ error: 'Token is required' });

  return reply.send({ subscribed: users.has(token) });
});

// Trade endpoint
fastify.get('/trade', async (req, reply) => {
  if (runningTrades.size > 0) {
    console.log("error: Trade already running for some users.");
  }

  let prediction;
  try {
    const res = await fetch('https://purplebot-official.onrender.com/predict');
    prediction = (await res.text()).trim();
  } catch (err) {
    return reply.code(500).send({ error: 'Prediction fetch failed', details: err.message });
  }

  const promises = [];

  for (const [token] of users) {
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
  return reply.send(results);
});

// Stats endpoint
fastify.get('/stat', async (req, reply) => {
  return reply.send({
    totalSubscribers: users.size,
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
    console.log(`Server running at port ${fastify.server.address().port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
