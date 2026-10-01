const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const { exec, spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_FILE = path.join(__dirname, 'streams_config.json');

// MIME types dictionary
const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

// Cached network info (refreshed periodically)
let cachedNetworkInfo = null;
let lastNetworkInfoCheck = 0;

function getNetworkInfo() {
  return new Promise((resolve) => {
    const now = Date.now();
    if (cachedNetworkInfo && (now - lastNetworkInfoCheck < 10000)) {
      return resolve(cachedNetworkInfo);
    }

    const psCommand = `
      $adapters = Get-NetAdapter | Where-Object {$_.Status -eq 'Up'} | Select-Object Name, InterfaceDescription, LinkSpeed, Status;
      $wlan = (netsh wlan show interfaces) 2>$null;
      $ssidMatch = $wlan | Select-String -Pattern '^\\s*SSID\\s*:\\s*(.+)$';
      $ssid = if ($ssidMatch) { $ssidMatch.Matches[0].Groups[1].Value.Trim() } else { '' };
      
      $ipList = Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike '169.254*' -and $_.IPAddress -notlike '127.*'} | Select-Object IPAddress, InterfaceAlias;

      [PSCustomObject]@{
        Adapters = $adapters;
        WifiSsid = $ssid;
        IpAddresses = $ipList;
        Hostname = $env:COMPUTERNAME
      } | ConvertTo-Json -Depth 3 -Compress
    `;

    exec(`powershell.exe -NoProfile -NonInteractive -Command "${psCommand.replace(/\n/g, ' ')}"`, (err, stdout, stderr) => {
      if (err || !stdout) {
        // Fallback using os module
        const ifaces = os.networkInterfaces();
        const ips = [];
        let adapterName = 'Default Network';
        for (const name in ifaces) {
          for (const net of ifaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
              ips.push({ IPAddress: net.address, InterfaceAlias: name });
              adapterName = name;
            }
          }
        }
        cachedNetworkInfo = {
          adapters: [{ Name: adapterName, InterfaceDescription: adapterName, LinkSpeed: 'Unknown', Status: 'Up' }],
          primaryAdapter: adapterName,
          wifiSsid: '',
          ipAddresses: ips,
          hostname: os.hostname()
        };
        lastNetworkInfoCheck = now;
        return resolve(cachedNetworkInfo);
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        let adapters = [];
        if (parsed.Adapters) {
          adapters = Array.isArray(parsed.Adapters) ? parsed.Adapters : [parsed.Adapters];
        }
        let primaryName = 'Connected';
        if (parsed.WifiSsid) {
          primaryName = `Wi-Fi: ${parsed.WifiSsid}`;
        } else if (adapters.length > 0) {
          primaryName = `${adapters[0].InterfaceDescription || adapters[0].Name} (${adapters[0].LinkSpeed || 'Connected'})`;
        }

        cachedNetworkInfo = {
          adapters,
          primaryAdapter: primaryName,
          wifiSsid: parsed.WifiSsid || '',
          ipAddresses: parsed.IpAddresses ? (Array.isArray(parsed.IpAddresses) ? parsed.IpAddresses : [parsed.IpAddresses]) : [],
          hostname: parsed.Hostname || os.hostname()
        };
        lastNetworkInfoCheck = now;
        resolve(cachedNetworkInfo);
      } catch (parseErr) {
        resolve({
          adapters: [],
          primaryAdapter: 'Local Network',
          wifiSsid: '',
          ipAddresses: [],
          hostname: os.hostname()
        });
      }
    });
  });
}

// Single Ping Execution
function executePing(targetHost) {
  return new Promise((resolve) => {
    // Sanitize targetHost: allow IP addresses, domains
    const sanitized = (targetHost || '8.8.8.8').replace(/[^a-zA-Z0-9.-]/g, '');
    const startTime = Date.now();

    exec(`ping -n 1 -w 1500 ${sanitized}`, (err, stdout, stderr) => {
      const output = stdout || '';
      // Windows ping output format: "Reply from x.x.x.x: bytes=32 time=9ms TTL=117"
      // or "time<1ms"
      const timeMatch = output.match(/time[=<](\d+)ms/i);
      const ttlMatch = output.match(/TTL=(\d+)/i);
      const lostMatch = output.match(/Lost\s*=\s*(\d+)/i);

      if (timeMatch) {
        const ms = parseInt(timeMatch[1], 10);
        resolve({
          target: sanitized,
          alive: true,
          timeMs: ms,
          ttl: ttlMatch ? parseInt(ttlMatch[1], 10) : null,
          status: ms < 30 ? 'excellent' : ms < 80 ? 'good' : 'warning',
          timestamp: Date.now()
        });
      } else {
        const isTimeout = output.includes('timed out') || output.includes('Destination host unreachable') || err;
        resolve({
          target: sanitized,
          alive: false,
          timeMs: null,
          status: 'error',
          message: isTimeout ? 'Request timed out' : 'Host unreachable',
          timestamp: Date.now()
        });
      }
    });
  });
}

// Config file read / write
function loadSavedConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Error loading config:', e);
  }
  return { streams: [] };
}

function saveConfig(configData) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Error saving config:', e);
    return false;
  }
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS headers for flexible access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API: Network Info
  if (pathname === '/api/network-info') {
    try {
      const info = await getNetworkInfo();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: Single Ping
  if (pathname === '/api/ping') {
    const target = parsedUrl.query.target || '8.8.8.8';
    const result = await executePing(target);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // API: SHA256 Helper (Ensures OBS authentication works on all LAN IPs without HTTPS)
  if (pathname === '/api/sha256' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const hash = require('crypto').createHash('sha256').update(body).digest('base64');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hash }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: Ping Stream (Server-Sent Events)
  if (pathname === '/api/ping-stream') {
    const target = parsedUrl.query.target || '8.8.8.8';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    res.write(`data: ${JSON.stringify({ type: 'connected', target })}\n\n`);

    let active = true;
    req.on('close', () => {
      active = false;
    });

    const runStreamPing = async () => {
      if (!active) return;
      const result = await executePing(target);
      if (active) {
        res.write(`data: ${JSON.stringify(result)}\n\n`);
        setTimeout(runStreamPing, 1000);
      }
    };

    runStreamPing();
    return;
  }

  // API: Config Load & Save
  if (pathname === '/api/config') {
    if (req.method === 'GET') {
      const cfg = loadSavedConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cfg));
      return;
    } else if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          saveConfig(parsed);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
        }
      });
      return;
    }
  }

  // Static File Serving
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

  // Security check: ensure path is within PUBLIC_DIR
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Access Denied');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA routing
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(` OBS WEB CONTROLLER & STATS MONITOR SERVER RUNNING `);
  console.log(`====================================================`);
  console.log(` Local:   http://localhost:${PORT}`);
  
  // Show LAN addresses
  const ifaces = os.networkInterfaces();
  for (const name in ifaces) {
    for (const net of ifaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(` Network: http://${net.address}:${PORT}`);
      }
    }
  }
  console.log(`====================================================`);
});
