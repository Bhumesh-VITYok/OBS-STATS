/**
 * OBS WebSocket v5 Client for Web Browser
 * Supports OBS Studio 28+ built-in WebSocket server
 * Compatible with local server AND GitHub Pages standalone deployment
 */

class OBSClient {
  constructor(options = {}) {
    this.options = options || {};
    this.name = options.name || 'OBS Stream';
    this.host = options.host || 'localhost';
    this.port = options.port || 4455;
    this.password = options.password || '';
    this.pingTarget = options.pingTarget || '';
    this.networkLabel = options.networkLabel || '';
    this.useWss = !!options.useWss;
    this.id = options.id || ('stream_' + Math.random().toString(36).substring(2, 9));

    this.ws = null;
    this.connected = false;
    this.identified = false;
    this.reconnectTimer = null;
    this.pollTimer = null;
    this.manualDisconnect = false;

    this.reqIdCounter = 1;
    this.pendingRequests = new Map();

    // RTT WebSocket Latency
    this.wsLatencyMs = 0;

    // Previous sample for bitrate calculation
    this.prevStreamBytes = 0;
    this.prevStreamTime = 0;
    this.streamBitrate = 0;

    this.prevRecordBytes = 0;
    this.prevRecordTime = 0;
    this.recordBitrate = 0;

    // Reset baselines (when user clicks Reset)
    this.baselines = {
      renderSkipped: 0,
      renderTotal: 0,
      outputSkipped: 0,
      outputTotal: 0,
      streamDropped: 0,
      streamTotal: 0,
      streamBytes: 0,
      recordBytes: 0
    };

    // Current State
    this.state = {
      version: null,
      stats: {
        cpuUsage: 0,
        memoryUsage: 0,
        availableDiskSpace: 0,
        activeFps: 0,
        averageFrameRenderTime: 0,
        renderSkippedFrames: 0,
        renderTotalFrames: 0,
        outputSkippedFrames: 0,
        outputTotalFrames: 0
      },
      stream: {
        outputActive: false,
        outputReconnecting: false,
        outputTimecode: '00:00:00.000',
        outputDuration: 0,
        outputBytes: 0,
        outputSkippedFrames: 0,
        outputTotalFrames: 0,
        outputCongestion: 0,
        bitrateKbps: 0
      },
      record: {
        outputActive: false,
        outputPaused: false,
        outputTimecode: '00:00:00.000',
        outputDuration: 0,
        outputBytes: 0,
        bitrateKbps: 0
      },
      decklink: {
        active: false,
        name: ''
      },
      virtualCam: {
        active: false
      },
      outputs: []
    };

    // Event callbacks
    this.callbacks = {
      onConnect: () => {},
      onDisconnect: () => {},
      onStateUpdate: () => {},
      onError: () => {}
    };
  }

  on(event, callback) {
    if (this.callbacks[event]) {
      this.callbacks[event] = callback;
    }
  }

  async sha256Base64(message) {
    if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
      try {
        const msgUint8 = new TextEncoder().encode(message);
        const hashBuffer = await window.crypto.subtle.digest('SHA-256', msgUint8);
        const bytes = new Uint8Array(hashBuffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
      } catch (e) {
        console.warn('SubtleCrypto failed, attempting server SHA-256 fallback...', e);
      }
    }

    // Server-side fallback (works on non-HTTPS LAN connections where SubtleCrypto is disabled)
    try {
      const res = await fetch('/api/sha256', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: message
      });
      if (res.ok) {
        const data = await res.json();
        if (data.hash) return data.hash;
      }
    } catch (e) {
      console.warn('Server SHA-256 fallback failed:', e);
    }

    return '';
  }

  connect() {
    this.manualDisconnect = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    let isWss = this.host.startsWith('wss://') || !!this.useWss;
    let cleanHost = this.host.trim();
    if (cleanHost.startsWith('http://') || cleanHost.startsWith('https://')) {
      cleanHost = cleanHost.replace(/^https?:\/\//, '');
    }
    if (cleanHost.startsWith('wss://')) {
      isWss = true;
      cleanHost = cleanHost.replace(/^wss:\/\//, '');
    } else if (cleanHost.startsWith('ws://')) {
      cleanHost = cleanHost.replace(/^ws:\/\//, '');
    }
    cleanHost = cleanHost.split('/')[0];
    let targetPort = this.port;
    if (cleanHost.includes(':')) {
      const parts = cleanHost.split(':');
      cleanHost = parts[0];
      targetPort = parts[1];
    }

    const wsProtocol = isWss ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${cleanHost}:${targetPort}`;

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      if (window.location.protocol === 'https:' && wsProtocol === 'ws:') {
        err.isMixedContent = true;
      }
      this.callbacks.onError(err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      // Waiting for Op 0 (Hello)
    };

    this.ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        await this.handleMessage(msg);
      } catch (e) {
        console.error(`[${this.name}] Failed to parse message:`, e);
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.identified = false;
      this.stopPolling();
      this.callbacks.onDisconnect();
      if (!this.manualDisconnect) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      this.callbacks.onError(err);
    };
  }

  disconnect() {
    this.manualDisconnect = true;
    this.stopPolling();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.identified = false;
    this.callbacks.onDisconnect();
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.manualDisconnect) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.connected && !this.manualDisconnect) {
        this.connect();
      }
    }, 3000);
  }

  async handleMessage(msg) {
    const { op, d } = msg;

    if (op === 0) { // Hello
      if (d) {
        this.state.version = { ...(this.state.version || {}), ...d };
      }
      let auth = undefined;
      if (d && d.authentication) {
        const { challenge, salt } = d.authentication;
        const secret = await this.sha256Base64(this.password + salt);
        auth = await this.sha256Base64(secret + challenge);
      }

      // Send Op 1: Identify
      this.send({
        op: 1,
        d: {
          rpcVersion: 1,
          ...(auth ? { authentication: auth } : {}),
          eventSubscriptions: 33 // General + Outputs
        }
      });
    } else if (op === 2) { // Identified
      this.connected = true;
      this.identified = true;
      if (d) {
        this.state.version = { ...(this.state.version || {}), ...d };
      }
      this.callbacks.onConnect();
      this.startPolling();
      this.pollData();
    } else if (op === 5) { // Event
      this.handleEvent(d);
    } else if (op === 7) { // RequestResponse
      const { requestId, requestStatus, responseData } = d;
      if (this.pendingRequests.has(requestId)) {
        const { resolve, sendTime } = this.pendingRequests.get(requestId);
        this.pendingRequests.delete(requestId);
        if (sendTime) {
          this.wsLatencyMs = Date.now() - sendTime;
        }
        resolve({ requestStatus, responseData });
      }
    }
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  sendRequest(requestType, requestData = {}) {
    return new Promise((resolve) => {
      if (!this.connected) {
        return resolve({ requestStatus: { result: false, comment: 'Not connected' }, responseData: null });
      }
      const requestId = 'req_' + (this.reqIdCounter++);
      const sendTime = Date.now();
      this.pendingRequests.set(requestId, { resolve, sendTime });

      this.send({
        op: 6,
        d: {
          requestType,
          requestId,
          requestData
        }
      });

      // Timeout safety
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          resolve({ requestStatus: { result: false, comment: 'Request timeout' }, responseData: null });
        }
      }, 5000);
    });
  }

  handleEvent(eventData) {
    const { eventType, eventData: payload } = eventData;
    if (eventType === 'StreamStateChanged') {
      this.state.stream.outputActive = payload.outputActive;
      this.callbacks.onStateUpdate(this.state);
    } else if (eventType === 'RecordStateChanged') {
      this.state.record.outputActive = payload.outputActive;
      this.callbacks.onStateUpdate(this.state);
    }
  }

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      this.pollData();
    }, 1000);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async pollData() {
    if (!this.connected) return;

    try {
      const now = Date.now();

      // Parallel batch requests
      const [statsRes, streamRes, recordRes, outputListRes] = await Promise.all([
        this.sendRequest('GetStats'),
        this.sendRequest('GetStreamStatus'),
        this.sendRequest('GetRecordStatus'),
        this.sendRequest('GetOutputList')
      ]);

      if (statsRes.responseData) {
        this.state.stats = { ...this.state.stats, ...statsRes.responseData };
      }

      if (streamRes.responseData) {
        const streamData = streamRes.responseData;
        const curBytes = streamData.outputBytes || 0;

        // Calculate bitrate
        if (streamData.outputActive && this.prevStreamTime > 0) {
          const deltaBytes = Math.max(0, curBytes - this.prevStreamBytes);
          const deltaTime = (now - this.prevStreamTime) / 1000;
          if (deltaTime > 0) {
            this.streamBitrate = Math.round((deltaBytes * 8) / deltaTime / 1000);
          }
        } else {
          this.streamBitrate = 0;
        }

        this.prevStreamBytes = curBytes;
        this.prevStreamTime = now;

        this.state.stream = {
          ...this.state.stream,
          ...streamData,
          bitrateKbps: this.streamBitrate
        };
      }

      if (recordRes.responseData) {
        const recordData = recordRes.responseData;
        const curBytes = recordData.outputBytes || 0;

        if (recordData.outputActive && this.prevRecordTime > 0) {
          const deltaBytes = Math.max(0, curBytes - this.prevRecordBytes);
          const deltaTime = (now - this.prevRecordTime) / 1000;
          if (deltaTime > 0) {
            this.recordBitrate = Math.round((deltaBytes * 8) / deltaTime / 1000);
          }
        } else {
          this.recordBitrate = 0;
        }

        this.prevRecordBytes = curBytes;
        this.prevRecordTime = now;

        this.state.record = {
          ...this.state.record,
          ...recordData,
          bitrateKbps: this.recordBitrate
        };
      }

      if (outputListRes.responseData && outputListRes.responseData.outputs) {
        this.state.outputs = outputListRes.responseData.outputs;
        const deck = this.state.outputs.find(o => o.outputKind === 'decklink_output');
        this.state.decklink.active = deck ? !!deck.outputActive : false;
        this.state.decklink.name = deck ? deck.outputName : '';

        const vcam = this.state.outputs.find(o => o.outputKind === 'virtualcam_output');
        this.state.virtualCam.active = vcam ? !!vcam.outputActive : false;
      }

      this.callbacks.onStateUpdate(this.state);
    } catch (err) {
      console.error(`[${this.name}] Polling error:`, err);
    }
  }

  // Reset baseline counters (emulates OBS Stats Reset button)
  resetBaseline() {
    this.baselines.renderSkipped = this.state.stats.renderSkippedFrames || 0;
    this.baselines.renderTotal = this.state.stats.renderTotalFrames || 0;
    this.baselines.outputSkipped = this.state.stats.outputSkippedFrames || 0;
    this.baselines.outputTotal = this.state.stats.outputTotalFrames || 0;
    this.baselines.streamDropped = this.state.stream.outputSkippedFrames || 0;
    this.baselines.streamTotal = this.state.stream.outputTotalFrames || 0;
    this.baselines.streamBytes = this.state.stream.outputBytes || 0;
    this.baselines.recordBytes = this.state.record.outputBytes || 0;

    this.callbacks.onStateUpdate(this.state);
  }

  // Get stats adjusted by baseline with upstream delay metrics
  getDisplayStats() {
    const s = this.state.stats;
    const str = this.state.stream;
    const rec = this.state.record;

    const renderTotal = Math.max(0, (s.renderTotalFrames || 0) - this.baselines.renderTotal);
    const renderMissed = Math.max(0, (s.renderSkippedFrames || 0) - this.baselines.renderSkipped);
    const renderLagPct = renderTotal > 0 ? ((renderMissed / renderTotal) * 100).toFixed(1) : '0.0';

    const outputTotal = Math.max(0, (s.outputTotalFrames || 0) - this.baselines.outputTotal);
    const outputSkipped = Math.max(0, (s.outputSkippedFrames || 0) - this.baselines.outputSkipped);
    const outputLagPct = outputTotal > 0 ? ((outputSkipped / outputTotal) * 100).toFixed(1) : '0.0';

    const streamTotal = Math.max(0, (str.outputTotalFrames || 0) - this.baselines.streamTotal);
    const streamDropped = Math.max(0, (str.outputSkippedFrames || 0) - this.baselines.streamDropped);
    const streamDropPct = streamTotal > 0 ? ((streamDropped / streamTotal) * 100).toFixed(1) : '0.0';

    const streamBytes = Math.max(0, (str.outputBytes || 0) - this.baselines.streamBytes);
    const recordBytes = Math.max(0, (rec.outputBytes || 0) - this.baselines.recordBytes);

    // Upstream Delay & Congestion calculation
    const congestion = str.outputCongestion || 0;
    const congestionPct = (congestion * 100).toFixed(0) + '%';
    const upstreamDelayBuffer = congestion > 0 ? `${(congestion * 3.5).toFixed(1)}s buffer` : '0.0s (Direct)';

    return {
      cpuUsage: (s.cpuUsage || 0).toFixed(1) + '%',
      memoryUsage: (s.memoryUsage || 0).toFixed(1) + ' MB',
      availableDiskSpace: this.formatDiskSpace(s.availableDiskSpace || 0),
      diskFullApprox: this.formatDiskFullIn(s.availableDiskSpace || 0, rec.bitrateKbps || str.bitrateKbps),
      fps: (s.activeFps || 0).toFixed(2),
      renderTime: (s.averageFrameRenderTime || 0).toFixed(1) + ' ms',
      renderLagStr: `${renderMissed} / ${renderTotal} (${renderLagPct}%)`,
      encodingLagStr: `${outputSkipped} / ${outputTotal} (${outputLagPct}%)`,
      streamDroppedStr: `${streamDropped} / ${streamTotal} (${streamDropPct}%)`,
      streamDataOutput: this.formatBytes(streamBytes),
      recordDataOutput: this.formatBytes(recordBytes),
      streamBitrate: `${str.bitrateKbps || 0} kb/s`,
      recordBitrate: `${rec.bitrateKbps || 0} kb/s`,
      streamActive: !!str.outputActive,
      streamReconnecting: !!str.outputReconnecting,
      streamTimecode: str.outputTimecode || '00:00:00.000',
      upstreamDuration: this.formatDuration(str.outputDuration || 0),
      upstreamCongestion: congestionPct,
      upstreamDelayBuffer,
      recordActive: !!rec.outputActive,
      recordPaused: !!rec.outputPaused,
      recordTimecode: rec.outputTimecode || '00:00:00.000',
      decklinkActive: this.state.decklink.active,
      wsLatencyMs: this.wsLatencyMs
    };
  }

  formatDuration(ms) {
    if (!ms || ms <= 0) return '00:00:00';
    const totalSecs = Math.floor(ms / 1000);
    const hrs = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0.0 MiB';
    const mib = bytes / (1024 * 1024);
    if (mib < 1024) {
      return mib.toFixed(1) + ' MiB';
    }
    const gib = mib / 1024;
    return gib.toFixed(2) + ' GiB';
  }

  formatDiskSpace(mb) {
    if (!mb || mb <= 0) return '0.0 GB';
    const gb = mb / 1024;
    if (gb < 1024) {
      return gb.toFixed(1) + ' GB';
    }
    const tb = gb / 1024;
    return tb.toFixed(1) + ' TB';
  }

  formatDiskFullIn(availableMb, bitrateKbps) {
    if (!bitrateKbps || bitrateKbps <= 0) return 'N/A';
    const bytesPerSec = (bitrateKbps * 1000) / 8;
    const availableBytes = availableMb * 1024 * 1024;
    const remainingSecs = availableBytes / bytesPerSec;
    const hours = Math.floor(remainingSecs / 3600);
    const mins = Math.floor((remainingSecs % 3600) / 60);
    if (hours > 48) {
      const days = Math.floor(hours / 24);
      return `~${days} days (${hours}h)`;
    }
    return `${hours}h ${mins}m`;
  }

  // Remote stream controls
  async startStream() {
    return this.sendRequest('StartStream');
  }

  async stopStream() {
    return this.sendRequest('StopStream');
  }

  async toggleStream() {
    return this.sendRequest('ToggleStream');
  }

  async startRecord() {
    return this.sendRequest('StartRecord');
  }

  async stopRecord() {
    return this.sendRequest('StopRecord');
  }
}
