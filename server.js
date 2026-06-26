const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const PORT = process.env.PORT || 8090;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'records.json');
const LOG_FILE = path.join(DATA_DIR, 'activity.log');
const LOG_MAX_BYTES = 1 * 1024 * 1024; // 1 MB

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Helper: Get primary IPv4 address of the physical interface
function getPrimaryIP() {
  const interfaces = os.networkInterfaces();
  // Prefer physical-looking interfaces first
  for (const name of Object.keys(interfaces)) {
    if (name.startsWith('lo') || name.startsWith('docker') || name.startsWith('br-') || name.startsWith('veth')) {
      continue;
    }
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  // Fallback to any non-internal IPv4
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

const SERVER_IP = getPrimaryIP();

// Load or initialize records
let records = [];
if (!fs.existsSync(DATA_FILE)) {
  records = [];
  fs.writeFileSync(DATA_FILE, JSON.stringify(records, null, 2));
} else {
  try {
    records = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('Error reading records file, resetting:', err);
    records = [];
  }
}

function saveRecords() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(records, null, 2));
  } catch (err) {
    console.error('Error saving records:', err);
  }
}

// Trim activity.log to stay under LOG_MAX_BYTES by dropping oldest lines
function trimLogFile() {
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    let i = 0;
    while (i < lines.length - 1 && Buffer.byteLength(lines.slice(i).join('\n') + '\n') > LOG_MAX_BYTES * 0.8) {
      i++;
    }
    fs.writeFileSync(LOG_FILE, lines.slice(i).join('\n') + '\n');
  } catch (err) {
    console.error('Error trimming log file:', err);
  }
}

function appendLogToFile(entry) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
    if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) trimLogFile();
  } catch (err) {
    console.error('Error writing to log file:', err);
  }
}

// Activity logging buffer (last 50 entries for the dashboard)
const activityLog = [];

// Seed in-memory buffer from existing log file on startup
if (fs.existsSync(LOG_FILE)) {
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(l => l.trim());
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    activityLog.push(...entries.slice(-50).reverse());
  } catch (err) {
    console.error('Error loading log file:', err);
  }
}

function logActivity(type, message, details = '') {
  const logEntry = {
    timestamp: new Date().toISOString(),
    type, // 'query', 'response', 'api', 'system'
    message,
    details
  };
  activityLog.unshift(logEntry);
  if (activityLog.length > 50) activityLog.pop();
  appendLogToFile(logEntry);
  console.log(`[${logEntry.type.toUpperCase()}] ${message} ${details ? '(' + details + ')' : ''}`);
}

logActivity('system', 'mDNS Manager starting up', `Primary server IP detected: ${SERVER_IP}`);

// Setup mDNS Responder using multicast-dns
let mdns;
try {
  mdns = require('multicast-dns')();

  mdns.on('query', (query) => {
    if (!query.questions) return;

    query.questions.forEach((q) => {
      const qName = q.name.toLowerCase().replace(/\.$/, '');

      // A record lookups
      if (q.type === 'A' || q.type === 'ANY') {
        const record = records.find(r => r.enabled && r.name.toLowerCase().replace(/\.$/, '') === qName);
        if (record) {
          logActivity('query', `Received query for ${q.name}`, 'Source: Multicast UDP');
          mdns.respond({
            answers: [{ name: q.name, type: 'A', ttl: 120, data: record.ip }]
          });
          logActivity('response', `Responded to ${q.name} -> A ${record.ip}`);
        }
      }

      // DNS-SD PTR browse (e.g. _http._tcp.local or _https._tcp.local)
      if (q.type === 'PTR' || q.type === 'ANY') {
        const advertisedRecords = records.filter(r => {
          if (!r.enabled || !r.port) return false;
          const st = r.serviceType || '_http._tcp';
          return qName === `${st}.local` || qName === st;
        });

        if (advertisedRecords.length > 0) {
          logActivity('query', `DNS-SD browse for ${q.name}`, 'Source: Multicast UDP');
          const answers = [];
          const additionals = [];

          for (const record of advertisedRecords) {
            const st = record.serviceType || '_http._tcp';
            const instanceName = `${record.name.replace(/\.local$/, '')}.${st}.local`;

            answers.push({ name: `${st}.local`, type: 'PTR', ttl: 4500, data: instanceName });
            additionals.push({ name: instanceName, type: 'SRV', ttl: 120, data: { priority: 0, weight: 0, port: record.port, target: record.name } });
            additionals.push({ name: instanceName, type: 'TXT', ttl: 4500, data: [''] });
            additionals.push({ name: record.name, type: 'A', ttl: 120, data: record.ip });

            logActivity('response', `Advertised ${instanceName} -> ${record.ip}:${record.port}`);
          }

          mdns.respond({ answers, additionals });
        }
      }

      // DNS-SD SRV / TXT for a specific service instance
      if (q.type === 'SRV' || q.type === 'TXT') {
        for (const record of records.filter(r => r.enabled && r.port)) {
          const st = record.serviceType || '_http._tcp';
          const instanceName = `${record.name.replace(/\.local$/, '')}.${st}.local`;
          if (qName !== instanceName) continue;

          const answers = [];
          if (q.type === 'SRV') {
            answers.push({ name: instanceName, type: 'SRV', ttl: 120, data: { priority: 0, weight: 0, port: record.port, target: record.name } });
          } else {
            answers.push({ name: instanceName, type: 'TXT', ttl: 4500, data: [''] });
          }
          mdns.respond({ answers, additionals: [{ name: record.name, type: 'A', ttl: 120, data: record.ip }] });
        }
      }
    });
  });

  logActivity('system', 'mDNS listener successfully initialized on port 5353');
} catch (err) {
  logActivity('system', 'Failed to initialize mDNS responder', err.message);
  console.error(err);
}

// Setup Express web framework
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// REST API Endpoints
app.get('/api/records', (req, res) => {
  res.json({
    records,
    serverIp: SERVER_IP,
    serverName: os.hostname(),
    status: mdns ? 'online' : 'offline'
  });
});

app.post('/api/records', (req, res) => {
  const { name, ip, enabled, description, port, serviceType } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Record name is required' });
  }

  // Normalize: ensure it ends with .local
  let normalizedName = name.trim().toLowerCase();
  if (normalizedName.endsWith('.')) {
    normalizedName = normalizedName.slice(0, -1);
  }
  if (!normalizedName.endsWith('.local')) {
    normalizedName += '.local';
  }

  // Validate hostname format briefly
  if (!/^[a-z0-9-_.]+\.local$/.test(normalizedName)) {
    return res.status(400).json({ error: 'Invalid hostname format. Use alphanumeric characters, dashes, and underscores.' });
  }

  const recordIp = ip ? ip.trim() : SERVER_IP;

  // Simple IP validation
  if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(recordIp)) {
    return res.status(400).json({ error: 'Invalid IPv4 address format.' });
  }

  // Prevent duplicate names
  if (records.some(r => r.name.toLowerCase() === normalizedName)) {
    return res.status(400).json({ error: 'A record with this domain name already exists.' });
  }

  const recordPort = (port !== undefined && port !== '' && port !== null) ? parseInt(port, 10) : null;
  if (recordPort !== null && (isNaN(recordPort) || recordPort < 1 || recordPort > 65535)) {
    return res.status(400).json({ error: 'Invalid port number (1–65535).' });
  }
  const recordServiceType = (serviceType && ['_http._tcp', '_https._tcp'].includes(serviceType)) ? serviceType : '_http._tcp';

  const newRecord = {
    id: Date.now().toString(),
    name: normalizedName,
    ip: recordIp,
    enabled: enabled !== false,
    description: description ? description.trim() : '',
    port: recordPort,
    serviceType: recordPort !== null ? recordServiceType : null,
  };

  records.push(newRecord);
  saveRecords();
  logActivity('api', `Created record ${normalizedName} -> ${recordIp}${recordPort ? ':' + recordPort : ''}`);
  res.status(201).json(newRecord);
});

app.put('/api/records/:id', (req, res) => {
  const { id } = req.params;
  const { name, ip, enabled, description, port, serviceType } = req.body;

  const recordIndex = records.findIndex(r => r.id === id);
  if (recordIndex === -1) {
    return res.status(404).json({ error: 'Record not found' });
  }

  const record = records[recordIndex];

  if (name !== undefined) {
    let normalizedName = name.trim().toLowerCase();
    if (normalizedName.endsWith('.')) {
      normalizedName = normalizedName.slice(0, -1);
    }
    if (!normalizedName.endsWith('.local') && normalizedName.length > 0) {
      normalizedName += '.local';
    }
    if (normalizedName.length > 0 && !/^[a-z0-9-_.]+\.local$/.test(normalizedName)) {
      return res.status(400).json({ error: 'Invalid hostname format.' });
    }
    // Prevent duplicate names
    if (normalizedName.length > 0 && records.some(r => r.id !== id && r.name.toLowerCase() === normalizedName)) {
      return res.status(400).json({ error: 'A record with this domain name already exists.' });
    }
    if (normalizedName.length > 0) {
      record.name = normalizedName;
    }
  }

  if (ip !== undefined) {
    const recordIp = ip.trim();
    if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(recordIp)) {
      return res.status(400).json({ error: 'Invalid IPv4 address format.' });
    }
    record.ip = recordIp;
  }

  if (enabled !== undefined) {
    record.enabled = !!enabled;
  }

  if (description !== undefined) {
    record.description = description.trim();
  }

  if (port !== undefined) {
    const recordPort = (port !== '' && port !== null) ? parseInt(port, 10) : null;
    if (recordPort !== null && (isNaN(recordPort) || recordPort < 1 || recordPort > 65535)) {
      return res.status(400).json({ error: 'Invalid port number (1–65535).' });
    }
    record.port = recordPort;
  }

  if (serviceType !== undefined) {
    record.serviceType = (['_http._tcp', '_https._tcp'].includes(serviceType)) ? serviceType : '_http._tcp';
  }

  // Clear serviceType if port is removed
  if (record.port === null) {
    record.serviceType = null;
  }

  saveRecords();
  logActivity('api', `Updated record ID ${id}: ${record.name} -> ${record.ip}${record.port ? ':' + record.port : ''} (${record.enabled ? 'enabled' : 'disabled'})`);
  res.json(record);
});

app.delete('/api/records/:id', (req, res) => {
  const { id } = req.params;
  const recordIndex = records.findIndex(r => r.id === id);
  if (recordIndex === -1) {
    return res.status(404).json({ error: 'Record not found' });
  }

  const deletedRecord = records.splice(recordIndex, 1)[0];
  saveRecords();
  logActivity('api', `Deleted record ${deletedRecord.name}`);
  res.json(deletedRecord);
});

app.get('/api/status', (req, res) => {
  res.json({
    activityLog,
    uptime: os.uptime(),
    memory: {
      free: os.freemem(),
      total: os.totalmem()
    },
    loadavg: os.loadavg(),
    platform: os.platform()
  });
});

app.get('/api/docker-scan', (req, res) => {
  const dockerReq = http.request(
    { socketPath: '/var/run/docker.sock', path: '/containers/json', method: 'GET' },
    (dockerRes) => {
      let raw = '';
      dockerRes.on('data', chunk => raw += chunk);
      dockerRes.on('end', () => {
        try {
          const containers = JSON.parse(raw);
          const candidates = [];
          const seen = new Set();

          for (const c of containers) {
            const rawName = (c.Names[0] || '').replace(/^\//, '');
            const hostname = rawName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
            if (!hostname) continue;

            const tcpPorts = c.Ports.filter(p => p.Type === 'tcp' && p.PublicPort && (p.IP === '0.0.0.0' || p.IP === '::'));
            const uniquePorts = [...new Map(tcpPorts.map(p => [p.PublicPort, p])).values()];

            for (const p of uniquePorts) {
              const key = `${hostname}:${p.PublicPort}`;
              if (seen.has(key)) continue;
              seen.add(key);
              candidates.push({
                name: `${hostname}.local`,
                ip: SERVER_IP,
                port: p.PublicPort,
                serviceType: '_http._tcp',
                description: `Docker: ${rawName}`,
              });
            }
          }

          logActivity('api', `Docker scan found ${candidates.length} port binding(s)`);
          res.json({ candidates });
        } catch (err) {
          res.status(500).json({ error: 'Failed to parse Docker API response: ' + err.message });
        }
      });
    }
  );

  dockerReq.on('error', (err) => {
    res.status(503).json({ error: 'Cannot reach Docker socket. Ensure /var/run/docker.sock is mounted.' });
  });

  dockerReq.end();
});

// Start Web Server
app.listen(PORT, '0.0.0.0', () => {
  logActivity('system', `Web management dashboard listening on port ${PORT}`);
});
