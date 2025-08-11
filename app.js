const path = require('path');
const fs = require('fs');
const Fastify = require('fastify');
const { spawn } = require('child_process');

const fastify = Fastify();
fastify.register(require('@fastify/cors'));
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname),
  prefix: '/',
});

const users = new Map();         // Map<token, { token, subscribedAt }>
const runningTrades = new Set(); // Set<token>
const tradeProcesses = new Map();// Map<token, child_process>
const serverStartTime = Date.now();

// Serve index.html
fastify.get('/', async (req, reply) => {
  const filePath = path.join(__dirname, 'index.html');
  try {
    const html = await fs.promises.readFile(filePath, 'utf-8');
    return reply.type('text/html').send(html);
  } catch (err) {
    reply.code(500).send({ error: 'Failed to load index.html', details: err.message });
  }
});

// Subscribe endpoint
fastify.post('/subscribe', async (req, reply) => {
  try {
    const { token } = req.body;
    if (!token) return reply.code(400).send({ error: 'Token is required' });
    users.set(token, { token, subscribedAt: Date.now() });
    console.log("✊ Registered token:", token);
    return reply.send({ success: true, message: 'Subscribed successfully' });
  } catch (err) {
    return reply.code(500).send({ error: 'Subscription failed', details: err.message });
  }
});

// Unsubscribe endpoint
fastify.post('/unsubscribe', async (req, reply) => {
  try {
    const { token } = req.body;
    if (!token) return reply.code(400).send({ error: 'Token is required' });

    users.delete(token);
    runningTrades.delete(token);

    const proc = tradeProcesses.get(token);
    if (proc) {
      const res = await terminateProcess(proc, 3000);
      console.log(`🛑 Unsubscribe killed process for ${token}:`, res);
    }
    tradeProcesses.delete(token);

    console.log("❌ Deleted token:", token);
    return reply.send({ success: true, message: 'Unsubscribed successfully' });
  } catch (err) {
    return reply.code(500).send({ error: 'Unsubscribe failed', details: err.message });
  }
});

// Check subscription
fastify.post('/check', async (req, reply) => {
  try {
    const { token } = req.body;
    if (!token) return reply.code(400).send({ error: 'Token is required' });
    return reply.send({ subscribed: users.has(token) });
  } catch (err) {
    return reply.code(500).send({ error: 'Check failed', details: err.message });
  }
});

// Helper: terminate process safely
function terminateProcess(proc, timeout = 5000) {
  return new Promise(resolve => {
    if (!proc || proc.killed) return resolve({ ok: false, reason: 'no_proc_or_already_killed' });

    let resolved = false;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    try {
      proc.kill('SIGTERM');
    } catch (err) {
      return finish({ ok: false, reason: err.message });
    }

    const t = setTimeout(() => {
      if (!proc.killed) {
        try { proc.kill('SIGKILL'); } catch {}
      }
      finish({ ok: true, forced: true });
    }, timeout);

    proc.once('exit', (code, signal) => {
      clearTimeout(t);
      finish({ ok: true, forced: false, code, signal });
    });
  });
}

// Helper: start trade process with deadline
function startTradeForToken(token) {
  if (runningTrades.has(token)) {
    return { started: false, reason: 'already_running' };
  }
  runningTrades.add(token);

  // Spawn safely without shell
  const child = spawn(process.execPath, [path.join(__dirname, 'trade.js'), token], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  tradeProcesses.set(token, child);

  // Output handling
  child.stdout.on('data', chunk => {
    chunk.toString().split(/\r?\n/).forEach(line => {
      if (line.trim()) console.log(`📤 ${token} STDOUT: ${line}`);
    });
  });

  child.stderr.on('data', chunk => {
    chunk.toString().split(/\r?\n/).forEach(line => {
      if (line.trim()) console.error(`🛑 ${token} STDERR: ${line}`);
    });
  });

  // Auto-cancel after 2 minutes
  const deadline = setTimeout(async () => {
    if (tradeProcesses.get(token) === child && !child.killed) {
      console.warn(`⏳ Trade for ${token} exceeded 2 minutes, terminating...`);
      await terminateProcess(child, 3000);
      runningTrades.delete(token);
      tradeProcesses.delete(token);
    }
  }, 120_000);

  const cleanup = (code, signal) => {
    clearTimeout(deadline);
    runningTrades.delete(token);
    tradeProcesses.delete(token);
    console.log(`✅ Trade for ${token} exited. code=${code} signal=${signal}`);
  };

  child.on('exit', cleanup);
  child.on('error', err => {
    clearTimeout(deadline);
    runningTrades.delete(token);
    tradeProcesses.delete(token);
    console.error(`❌ Trade for ${token} ERROR: ${err.message}`);
  });

  return { started: true, pid: child.pid };
}

// Trade endpoint
fastify.get('/trade', async (req, reply) => {
  const report = [];
  for (const [token] of users.entries()) {
    try {
      if (runningTrades.has(token)) {
        report.push({ token, status: 'Trading Continues' });
        continue;
      }
      const res = startTradeForToken(token);
      if (res.started) {
        report.push({ token, status: 'Trading has started', pid: res.pid });
      } else {
        report.push({ token, status: 'Not started', reason: res.reason });
      }
    } catch (err) {
      runningTrades.delete(token);
      tradeProcesses.delete(token);
      report.push({ token, error: err.message });
    }
  }
  return reply.send(report);
});

// Cancel all trades
fastify.get('/cancel', async (req, reply) => {
  const cancelled = [];
  const entries = Array.from(tradeProcesses.entries());

  for (const [token, proc] of entries) {
    try {
      const res = await terminateProcess(proc, 3000);
      cancelled.push({ token, result: res });
      console.log(`🛑 Cancelled trade for ${token}:`, res);
    } catch (err) {
      console.error(`❌ Error cancelling ${token}: ${err.message}`);
    }
    runningTrades.delete(token);
    tradeProcesses.delete(token);
  }

  return reply.send({
    cancelledCount: cancelled.length,
    cancelled
  });
});

// Stats
fastify.get('/stat', async (req, reply) => {
  return reply.send({
    totalSubscribers: users.size,
    runningTrades: [...runningTrades],
    currentTime: new Date().toISOString(),
    startTime: new Date(serverStartTime).toISOString(),
    uptime: Math.floor((Date.now() - serverStartTime) / 1000)
  });
});

// Graceful shutdown
async function shutdown() {
  console.log('🔌 Server shutting down, terminating child processes...');
  const entries = Array.from(tradeProcesses.values());
  await Promise.all(entries.map(proc => terminateProcess(proc, 2000)));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start the server
const start = async () => {
  try {
    await fastify.listen({
      port: process.env.PORT || 3000,
      host: '0.0.0.0'
    });

    const defaultToken = "JklMzewtX7Da9mT";
    users.set(defaultToken, { token: defaultToken, subscribedAt: Date.now() });
    console.log("✊ Auto-registered token on startup:", defaultToken);

    console.log(`✅ Server running at port ${fastify.server.address().port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
