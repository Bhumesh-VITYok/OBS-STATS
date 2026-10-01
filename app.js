/**
 * OBS Web Controller & Broadcast Stats Monitor
 * Multi-Stream Management, Upstream Delay Tracking, Spike Detection & Excel Export
 */

(function () {
  'use strict';

  // --- STATE ---
  let streams = [];
  let clients = new Map(); // id -> OBSClient
  let pingMonitors = new Map(); // id -> PingMonitor
  let activeFocusStreamId = null;
  let viewMode = 'grid'; // 'grid' | 'focus'
  let soundAlertEnabled = true;

  // Web Audio Context for Spike Beep Alerts
  let audioCtx = null;
  function playAlertBeep(freq = 880, duration = 0.15) {
    if (!soundAlertEnabled) return;
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + duration);
    } catch (e) {}
  }

  // Default Stats Visibility Filter
  const DEFAULT_STATS_FILTER = {
    cpuUsage: true,
    memoryUsage: true,
    availableDiskSpace: true,
    diskFullApprox: true,
    fps: true,
    renderTime: true,
    renderLag: true,
    encodingLag: true,
    upstreamStrip: true,
    pingWindow: true,
    outputTable: true
  };
  let statsFilter = { ...DEFAULT_STATS_FILTER };

  // DOM Elements
  const masterTally = document.getElementById('masterTally');
  const masterStatusText = document.getElementById('masterStatusText');
  const masterDetailText = document.getElementById('masterDetailText');
  const globalNetName = document.getElementById('globalNetName');
  const globalNetIp = document.getElementById('globalNetIp');
  const dashboardContainer = document.getElementById('dashboardContainer');
  const emptyState = document.getElementById('emptyState');
  const focusTabsBar = document.getElementById('focusTabsBar');
  const viewGridBtn = document.getElementById('viewGridBtn');
  const viewFocusBtn = document.getElementById('viewFocusBtn');
  const addStreamBtn = document.getElementById('addStreamBtn');
  const emptyAddBtn = document.getElementById('emptyAddBtn');
  const quickAddLocalBtn = document.getElementById('quickAddLocalBtn');
  const resetAllBtn = document.getElementById('resetAllBtn');

  // Filter Dropdown DOM
  const statsFilterBtn = document.getElementById('statsFilterBtn');
  const statsFilterMenu = document.getElementById('statsFilterMenu');
  const filterCountBadge = document.getElementById('filterCountBadge');

  // Modal Dialog DOM
  const streamDialog = document.getElementById('streamDialog');
  const streamForm = document.getElementById('streamForm');
  const modalTitle = document.getElementById('modalTitle');
  const editStreamId = document.getElementById('editStreamId');
  const streamNameInput = document.getElementById('streamNameInput');
  const streamHostInput = document.getElementById('streamHostInput');
  const streamPortInput = document.getElementById('streamPortInput');
  const streamPasswordInput = document.getElementById('streamPasswordInput');
  const togglePasswordBtn = document.getElementById('togglePasswordBtn');
  const streamPingTargetInput = document.getElementById('streamPingTargetInput');
  const streamNetworkLabelInput = document.getElementById('streamNetworkLabelInput');
  const closeModalBtn = document.getElementById('closeModalBtn');
  const cancelModalBtn = document.getElementById('cancelModalBtn');
  const testConnBtn = document.getElementById('testConnBtn');
  const connTestResult = document.getElementById('connTestResult');
  const httpsSecurityBanner = document.getElementById('httpsSecurityBanner');
  const dismissSecBannerBtn = document.getElementById('dismissSecBannerBtn');

  // Auth & Roles DOM
  const loginDialog = document.getElementById('loginDialog');
  const adminLoginForm = document.getElementById('adminLoginForm');
  const adminUsernameInput = document.getElementById('adminUsernameInput');
  const adminPasswordInput = document.getElementById('adminPasswordInput');
  const adminLoginError = document.getElementById('adminLoginError');
  const continueAsUserBtn = document.getElementById('continueAsUserBtn');
  const userRoleBadge = document.getElementById('userRoleBadge');
  const roleIcon = document.getElementById('roleIcon');
  const roleNameText = document.getElementById('roleNameText');
  const roleSubText = document.getElementById('roleSubText');
  const authSwitchBtn = document.getElementById('authSwitchBtn');

  let currentRole = localStorage.getItem('obs_auth_role') || null;

  function applyRole(role) {
    currentRole = role;
    if (role === 'admin') {
      document.body.classList.add('role-admin');
      document.body.classList.remove('role-user');
      if (roleIcon) roleIcon.textContent = '👑';
      if (roleNameText) roleNameText.textContent = 'Admin';
      if (roleSubText) roleSubText.textContent = 'Full Access';
      if (authSwitchBtn) authSwitchBtn.textContent = 'Logout';
    } else {
      document.body.classList.add('role-user');
      document.body.classList.remove('role-admin');
      if (roleIcon) roleIcon.textContent = '👁️';
      if (roleNameText) roleNameText.textContent = 'User';
      if (roleSubText) roleSubText.textContent = 'Monitor Only';
      if (authSwitchBtn) authSwitchBtn.textContent = 'Login Admin';
    }
    updateRestoreButton();
  }

  function showSecurityBanner() {
    if (httpsSecurityBanner && window.location.protocol === 'https:') {
      httpsSecurityBanner.classList.remove('hidden');
    }
  }

  // --- INITIALIZATION ---
  async function init() {
    loadPreferences();
    setupEventListeners();
    await fetchNetworkInfo();
    await loadStreamsConfig();

    if (!currentRole) {
      if (loginDialog) loginDialog.showModal();
      applyRole('user');
    } else {
      applyRole(currentRole);
    }

    if (streams.length === 0) {
      if (currentRole === 'admin') openStreamModal(null, true);
    } else {
      renderDashboard();
    }
  }

  // --- STORAGE & CONFIG ---
  function loadPreferences() {
    try {
      const savedFilter = localStorage.getItem('obs_stats_filter');
      if (savedFilter) {
        statsFilter = { ...DEFAULT_STATS_FILTER, ...JSON.parse(savedFilter) };
      }
      const savedView = localStorage.getItem('obs_view_mode');
      if (savedView) {
        viewMode = savedView;
        updateViewModeUI();
      }
      const savedSound = localStorage.getItem('obs_sound_alert');
      if (savedSound !== null) {
        soundAlertEnabled = savedSound === 'true';
      }
    } catch (e) {
      console.warn('Could not load preferences:', e);
    }
    updateFilterUI();
  }

  function saveFilterPreferences() {
    try {
      localStorage.setItem('obs_stats_filter', JSON.stringify(statsFilter));
    } catch (e) {}
    updateFilterUI();
    applyFilterToDOM();
  }

  async function loadStreamsConfig() {
    // 1) Try server API if running in server mode (authoritative single source of truth)
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.streams)) {
          streams = data.streams;
          localStorage.setItem('obs_streams', JSON.stringify(streams));
          return;
        }
      }
    } catch (e) {}

    // 2) Fallback to localStorage (used when running standalone without server)
    try {
      const local = localStorage.getItem('obs_streams');
      if (local !== null) {
        streams = JSON.parse(local);
      }
    } catch (e) {}
  }

  async function saveStreamsConfig() {
    try {
      localStorage.setItem('obs_streams', JSON.stringify(streams));
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streams })
      });
    } catch (e) {
      console.warn('Could not save streams to server:', e);
    }
  }

  // --- NETWORK INFO ---
  async function fetchNetworkInfo() {
    try {
      const res = await fetch('/api/network-info');
      if (res.ok) {
        const info = await res.json();
        if (info.primaryAdapter) {
          globalNetName.textContent = info.primaryAdapter;
        }
        if (info.ipAddresses && info.ipAddresses.length > 0) {
          const mainIp = info.ipAddresses[0].IPAddress;
          globalNetIp.textContent = `Host IP: ${mainIp} (${info.hostname || 'PC'})`;
        }
        return;
      }
    } catch (e) {}

    // Standalone / GitHub Pages fallback
    globalNetName.textContent = 'Web Browser Direct';
    globalNetIp.textContent = 'Standalone Mode';
  }

  // --- EVENT LISTENERS ---
  function setupEventListeners() {
    statsFilterBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      statsFilterMenu.classList.toggle('hidden');
    });

    document.addEventListener('click', (e) => {
      if (!statsFilterMenu.contains(e.target) && e.target !== statsFilterBtn) {
        statsFilterMenu.classList.add('hidden');
      }
    });

    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        applyPresetFilter(btn.dataset.preset);
      });
    });

    statsFilterMenu.querySelectorAll('input[type="checkbox"]').forEach(chk => {
      chk.addEventListener('change', () => {
        statsFilter[chk.dataset.stat] = chk.checked;
        saveFilterPreferences();
      });
    });

    viewGridBtn.addEventListener('click', () => setViewMode('grid'));
    viewFocusBtn.addEventListener('click', () => setViewMode('focus'));

    addStreamBtn.addEventListener('click', () => openStreamModal());
    emptyAddBtn.addEventListener('click', () => openStreamModal());
    quickAddLocalBtn.addEventListener('click', () => quickAddLocalOBS());
    closeModalBtn.addEventListener('click', () => streamDialog.close());
    cancelModalBtn.addEventListener('click', () => streamDialog.close());

    togglePasswordBtn.addEventListener('click', () => {
      const type = streamPasswordInput.type === 'password' ? 'text' : 'password';
      streamPasswordInput.type = type;
      togglePasswordBtn.textContent = type === 'password' ? '👁' : '🔒';
    });

    testConnBtn.addEventListener('click', testModalConnection);

    streamForm.addEventListener('submit', (e) => {
      e.preventDefault();
      handleSaveStream();
    });

    if (dismissSecBannerBtn) {
      dismissSecBannerBtn.addEventListener('click', () => {
        if (httpsSecurityBanner) httpsSecurityBanner.classList.add('hidden');
      });
    }

    resetAllBtn.addEventListener('click', () => {
      if (currentRole !== 'admin') return;
      clients.forEach(client => client.resetBaseline());
      flashElement(resetAllBtn);
    });

    // --- ROLE & AUTH EVENT LISTENERS ---
    if (adminLoginForm) {
      adminLoginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const user = adminUsernameInput.value.trim();
        const pass = adminPasswordInput.value.trim();
        if (user === 'admin' && pass === 'admin@123') {
          if (adminLoginError) adminLoginError.classList.add('hidden');
          localStorage.setItem('obs_auth_role', 'admin');
          applyRole('admin');
          loginDialog.close();
          renderDashboard();
        } else {
          if (adminLoginError) adminLoginError.classList.remove('hidden');
        }
      });
    }

    if (continueAsUserBtn) {
      continueAsUserBtn.addEventListener('click', () => {
        localStorage.setItem('obs_auth_role', 'user');
        applyRole('user');
        loginDialog.close();
        renderDashboard();
      });
    }

    if (authSwitchBtn) {
      authSwitchBtn.addEventListener('click', () => {
        if (currentRole === 'admin') {
          // Log out from admin
          localStorage.removeItem('obs_auth_role');
          applyRole('user');
          renderDashboard();
          if (adminLoginError) adminLoginError.classList.add('hidden');
          if (adminPasswordInput) adminPasswordInput.value = '';
          if (loginDialog) loginDialog.showModal();
        } else {
          // Switch to admin login modal
          if (adminLoginError) adminLoginError.classList.add('hidden');
          if (adminPasswordInput) adminPasswordInput.value = '';
          if (loginDialog) loginDialog.showModal();
        }
      });
    }

    // Default to user role if login modal closed without submitting
    if (loginDialog) {
      loginDialog.addEventListener('cancel', () => {
        if (!currentRole) {
          applyRole('user');
          renderDashboard();
        }
      });
    }

    // --- QUICK FILL BUTTONS IN STREAM MODAL ---
    const quickFillLastBtn = document.getElementById('quickFillLastBtn');
    if (quickFillLastBtn) {
      quickFillLastBtn.addEventListener('click', () => {
        const lastHost = localStorage.getItem('obs_last_host') || '10.10.101.130';
        const lastPort = localStorage.getItem('obs_last_port') || '4455';
        const lastPass = localStorage.getItem('obs_last_password') || '123456';
        const lastPing = localStorage.getItem('obs_last_ping_target') || lastHost;
        const lastNet = localStorage.getItem('obs_last_network_label') || 'Ethernet Realtek 2.5GbE';
        streamHostInput.value = lastHost;
        streamPortInput.value = lastPort;
        streamPasswordInput.value = lastPass;
        streamPingTargetInput.value = lastPing;
        streamNetworkLabelInput.value = lastNet;
        flashElement(quickFillLastBtn);
      });
    }

    const quickFillRemoteBtn = document.getElementById('quickFillRemoteBtn');
    if (quickFillRemoteBtn) {
      quickFillRemoteBtn.addEventListener('click', () => {
        streamNameInput.value = 'Hindi Stream';
        streamHostInput.value = '10.10.101.130';
        streamPortInput.value = '4455';
        streamPasswordInput.value = '123456';
        streamPingTargetInput.value = '10.10.101.130';
        streamNetworkLabelInput.value = 'Ethernet Realtek 2.5GbE';
        flashElement(quickFillRemoteBtn);
      });
    }

    const quickFillLocalBtn = document.getElementById('quickFillLocalBtn');
    if (quickFillLocalBtn) {
      quickFillLocalBtn.addEventListener('click', () => {
        streamNameInput.value = 'English Stream';
        streamHostInput.value = '127.0.0.1';
        streamPortInput.value = '4455';
        streamPasswordInput.value = '12345678';
        streamPingTargetInput.value = '127.0.0.1';
        streamNetworkLabelInput.value = 'Local Host';
        flashElement(quickFillLocalBtn);
      });
    }

    const copyHostToPingBtn = document.getElementById('copyHostToPingBtn');
    if (copyHostToPingBtn) {
      copyHostToPingBtn.addEventListener('click', () => {
        streamPingTargetInput.value = streamHostInput.value.trim();
        flashElement(copyHostToPingBtn);
      });
    }

    // Auto-sync host IP into ping IP as user types (when ping is matching or default)
    if (streamHostInput) {
      streamHostInput.addEventListener('input', () => {
        const curPing = streamPingTargetInput.value.trim();
        if (!curPing || curPing === '8.8.8.8' || curPing === '127.0.0.1' || curPing.startsWith('10.10.')) {
          streamPingTargetInput.value = streamHostInput.value.trim();
        }
      });
    }

    // Quick ping presets in modal
    document.querySelectorAll('.quick-ping-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.ip) {
          streamPingTargetInput.value = btn.dataset.ip;
          flashElement(btn);
        }
      });
    });

    // Restore Deleted Stream Button
    const restoreDeletedBtn = document.getElementById('restoreDeletedBtn');
    if (restoreDeletedBtn) {
      restoreDeletedBtn.addEventListener('click', () => {
        if (currentRole !== 'admin') return;
        const lastDeleted = localStorage.getItem('obs_last_deleted_stream');
        if (lastDeleted) {
          try {
            const restored = JSON.parse(lastDeleted);
            restored.id = 'stream_' + Math.random().toString(36).substring(2, 9);
            streams.push(restored);
            localStorage.removeItem('obs_last_deleted_stream');
            updateRestoreButton();
            saveStreamsConfig();
            renderDashboard();
          } catch (e) {}
        }
      });
    }
  }

  // --- STATS FILTER PRESETS ---
  function applyPresetFilter(preset) {
    if (preset === 'all') {
      for (const k in statsFilter) statsFilter[k] = true;
    } else if (preset === 'stream') {
      statsFilter.cpuUsage = true;
      statsFilter.fps = true;
      statsFilter.renderLag = true;
      statsFilter.encodingLag = true;
      statsFilter.upstreamStrip = true;
      statsFilter.pingWindow = true;
      statsFilter.outputTable = true;
      statsFilter.memoryUsage = false;
      statsFilter.availableDiskSpace = false;
      statsFilter.diskFullApprox = false;
      statsFilter.renderTime = false;
    } else if (preset === 'hardware') {
      statsFilter.cpuUsage = true;
      statsFilter.memoryUsage = true;
      statsFilter.availableDiskSpace = true;
      statsFilter.diskFullApprox = true;
      statsFilter.fps = true;
      statsFilter.renderTime = true;
      statsFilter.renderLag = true;
      statsFilter.encodingLag = true;
      statsFilter.upstreamStrip = false;
      statsFilter.pingWindow = false;
      statsFilter.outputTable = false;
    } else if (preset === 'minimal') {
      statsFilter.fps = true;
      statsFilter.upstreamStrip = true;
      statsFilter.outputTable = true;
      statsFilter.pingWindow = true;
      statsFilter.cpuUsage = false;
      statsFilter.memoryUsage = false;
      statsFilter.availableDiskSpace = false;
      statsFilter.diskFullApprox = false;
      statsFilter.renderTime = false;
      statsFilter.renderLag = false;
      statsFilter.encodingLag = false;
    }
    saveFilterPreferences();
  }

  function updateFilterUI() {
    statsFilterMenu.querySelectorAll('input[type="checkbox"]').forEach(chk => {
      const key = chk.dataset.stat;
      if (statsFilter[key] !== undefined) {
        chk.checked = !!statsFilter[key];
      }
    });

    const activeCount = Object.values(statsFilter).filter(Boolean).length;
    const totalCount = Object.keys(statsFilter).length;
    filterCountBadge.textContent = activeCount === totalCount ? 'All' : `${activeCount}/${totalCount}`;
  }

  function applyFilterToDOM() {
    for (const [key, visible] of Object.entries(statsFilter)) {
      document.querySelectorAll(`[data-filter-id="${key}"]`).forEach(el => {
        el.style.display = visible ? '' : 'none';
      });
    }
  }

  // --- VIEW MODE ---
  function setViewMode(mode) {
    viewMode = mode;
    localStorage.setItem('obs_view_mode', mode);
    updateViewModeUI();
    renderDashboard();
  }

  function updateViewModeUI() {
    viewGridBtn.classList.toggle('active', viewMode === 'grid');
    viewFocusBtn.classList.toggle('active', viewMode === 'focus');
    focusTabsBar.classList.toggle('hidden', viewMode !== 'focus');
    dashboardContainer.classList.toggle('focus-mode', viewMode === 'focus');
  }

  // --- QUICK LOCAL ADD ---
  function quickAddLocalOBS() {
    if (currentRole !== 'admin') return;
    const newStream = {
      id: 'stream_' + Math.random().toString(36).substring(2, 9),
      name: 'Hindi Stream',
      host: '127.0.0.1',
      port: 4455,
      password: '12345678',
      pingTarget: '8.8.8.8',
      networkLabel: 'Ethernet Realtek 2.5GbE'
    };
    streams.push(newStream);
    saveStreamsConfig();
    renderDashboard();
  }

  // --- MODAL DIALOG ---
  function openStreamModal(streamId = null, isInitialPrompt = false) {
    if (currentRole !== 'admin') return;
    connTestResult.classList.add('hidden');
    editStreamId.value = streamId || '';

    if (streamId) {
      const s = streams.find(item => item.id === streamId);
      if (s) {
        modalTitle.textContent = `Edit Stream PC: ${s.name}`;
        streamNameInput.value = s.name;
        streamHostInput.value = s.host;
        streamPortInput.value = s.port;
        streamPasswordInput.value = s.password || '';
        streamPingTargetInput.value = s.pingTarget || s.host || '10.10.101.130';
        streamNetworkLabelInput.value = s.networkLabel || '';
      }
    } else {
      modalTitle.textContent = isInitialPrompt ? 'Setup Your First OBS Stream PC' : 'Add New OBS Stream PC';
      
      // Auto-prefill with last used data so user never has to re-type
      const lastHost = localStorage.getItem('obs_last_host') || '10.10.101.130';
      const lastPort = localStorage.getItem('obs_last_port') || '4455';
      const lastPass = localStorage.getItem('obs_last_password') || '123456';
      const lastPing = localStorage.getItem('obs_last_ping_target') || lastHost;
      const lastNet = localStorage.getItem('obs_last_network_label') || 'Ethernet Realtek 2.5GbE';
      const count = streams.length;
      const suggestedName = count === 0 ? 'Hindi Stream' : count === 1 ? 'English Stream' : `Stream PC ${count + 1}`;

      streamNameInput.value = suggestedName;
      streamHostInput.value = lastHost;
      streamPortInput.value = lastPort;
      streamPasswordInput.value = lastPass;
      streamPingTargetInput.value = lastPing;
      streamNetworkLabelInput.value = lastNet;
    }

    streamDialog.showModal();
    streamNameInput.select();
  }

  async function testModalConnection() {
    const host = streamHostInput.value.trim() || '127.0.0.1';
    const port = streamPortInput.value.trim() || '4455';
    const password = streamPasswordInput.value;

    connTestResult.className = 'conn-test-banner';
    connTestResult.innerHTML = `<span>⏳ Testing connection to ws://${host}:${port}...</span>`;
    connTestResult.classList.remove('hidden');

    try {
      const testClient = new OBSClient({
        name: 'Test',
        host,
        port: parseInt(port, 10),
        password
      });

      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timed out after 4 seconds')), 4000));
      const connPromise = new Promise((resolve, reject) => {
        testClient.on('onConnect', () => resolve(testClient.state.version));
        testClient.on('onError', (err) => reject(err));
        testClient.connect();
      });

      const versionData = await Promise.race([connPromise, timeout]);
      testClient.disconnect();

      const obsVer = versionData?.obsStudioVersion ? `OBS Studio v${versionData.obsStudioVersion}` : 'OBS Studio';
      connTestResult.className = 'conn-test-banner success';
      connTestResult.innerHTML = `<span>✓ Successfully connected to ${obsVer}!</span>`;
    } catch (err) {
      connTestResult.className = 'conn-test-banner error';
      let errorMsg = err.message || 'Check IP, Port & Password';
      if (window.location.protocol === 'https:' && !host.startsWith('wss://')) {
        errorMsg = 'Browser blocked connection (Mixed Content). Allow "Insecure content" in site settings (padlock icon) to enable local OBS connection!';
        showSecurityBanner();
      }
      connTestResult.innerHTML = `<span>✕ Connection Failed: ${errorMsg}</span>`;
    }
  }

  function handleSaveStream() {
    if (currentRole !== 'admin') return;
    const streamId = editStreamId.value;
    const name = streamNameInput.value.trim();
    const host = streamHostInput.value.trim();
    const port = parseInt(streamPortInput.value.trim(), 10) || 4455;
    const password = streamPasswordInput.value;
    const pingTarget = streamPingTargetInput.value.trim() || host || '10.10.101.130';
    const networkLabel = streamNetworkLabelInput.value.trim();

    if (!name || !host) return;

    // Save to localStorage memory so user never has to re-type
    try {
      localStorage.setItem('obs_last_name', name);
      localStorage.setItem('obs_last_host', host);
      localStorage.setItem('obs_last_port', port.toString());
      localStorage.setItem('obs_last_password', password);
      localStorage.setItem('obs_last_ping_target', pingTarget);
      localStorage.setItem('obs_last_network_label', networkLabel);
    } catch (e) {}

    if (streamId) {
      const idx = streams.findIndex(s => s.id === streamId);
      if (idx !== -1) {
        streams[idx] = { ...streams[idx], name, host, port, password, pingTarget, networkLabel };
        if (clients.has(streamId)) {
          clients.get(streamId).disconnect();
          clients.delete(streamId);
        }
      }
    } else {
      const newId = 'stream_' + Math.random().toString(36).substring(2, 9);
      streams.push({ id: newId, name, host, port, password, pingTarget, networkLabel });
    }

    saveStreamsConfig();
    streamDialog.close();
    renderDashboard();
  }

  function removeStream(streamId) {
    if (currentRole !== 'admin') return;
    const s = streams.find(item => item.id === streamId);
    const streamName = s ? s.name : 'this stream';
    if (confirm(`Are you sure you want to remove "${streamName}"?`)) {
      if (s) {
        localStorage.setItem('obs_last_deleted_stream', JSON.stringify(s));
        updateRestoreButton();
      }
      if (clients.has(streamId)) {
        clients.get(streamId).disconnect();
        clients.delete(streamId);
      }
      if (pingMonitors.has(streamId)) {
        pingMonitors.get(streamId).stop();
        pingMonitors.delete(streamId);
      }
      streams = streams.filter(s => s.id !== streamId);
      if (activeFocusStreamId === streamId) {
        activeFocusStreamId = streams.length > 0 ? streams[0].id : null;
      }
      saveStreamsConfig();
      renderDashboard();
    }
  }

  function updateRestoreButton() {
    const restoreBtn = document.getElementById('restoreDeletedBtn');
    if (!restoreBtn) return;
    const lastDeleted = localStorage.getItem('obs_last_deleted_stream');
    if (lastDeleted && currentRole === 'admin') {
      try {
        const item = JSON.parse(lastDeleted);
        restoreBtn.textContent = `↩ Restore "${item.name}"`;
        restoreBtn.classList.remove('hidden');
      } catch (e) {
        restoreBtn.classList.add('hidden');
      }
    } else {
      restoreBtn.classList.add('hidden');
    }
  }

  // --- PING MONITOR CLASS (WITH CONTINUOUS `ping -t` LOGGING, SPIKE ALERTS & EXCEL EXPORT) ---
  class PingMonitor {
    constructor(streamConfig, cardElement) {
      this.streamConfig = streamConfig;
      this.cardElement = cardElement;
      this.target = streamConfig.pingTarget || '8.8.8.8';
      this.timer = null;
      this.history = [];
      this.maxPoints = 60; // Up to 60 points on the graph
      this.packetSent = 0;
      this.packetReceived = 0;
      this.spikesDetected = 0;

      // Complete Continuous Log (like cmd `ping 8.8.8.8 -t`)
      this.fullPingLog = [];
      this.startTime = new Date();

      this.canvas = cardElement.querySelector('.ping-canvas');
      this.ctx = this.canvas ? this.canvas.getContext('2d') : null;

      this.valText = cardElement.querySelector('.ping-val-num');
      this.badge = cardElement.querySelector('.ping-quality-badge');
      this.minText = cardElement.querySelector('.ping-min');
      this.maxText = cardElement.querySelector('.ping-max');
      this.avgText = cardElement.querySelector('.ping-avg');
      this.lossText = cardElement.querySelector('.ping-loss');
      this.spikesText = cardElement.querySelector('.ping-spikes');
      this.spikeBanner = cardElement.querySelector('.spike-alert-banner');
      this.spikeMsg = cardElement.querySelector('.spike-alert-msg');

      this.initCanvas();
      this.start();
    }

    initCanvas() {
      if (!this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = (rect.width || 400) * dpr;
      this.canvas.height = (rect.height || 80) * dpr;
      if (this.ctx) {
        this.ctx.scale(dpr, dpr);
      }
    }

    setTarget(newTarget) {
      this.target = newTarget;
      this.history = [];
      this.packetSent = 0;
      this.packetReceived = 0;
      this.spikesDetected = 0;
      this.drawChart();
    }

    start() {
      this.stop();
      this.pingOnce();
      this.timer = setInterval(() => this.pingOnce(), 1000);
    }

    stop() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }

    async pingOnce() {
      this.packetSent++;
      const client = clients.get(this.streamConfig.id);
      const streamState = client && client.state.stream.outputActive ? 'ON AIR' : 'OFFLINE';
      const streamBitrate = client ? `${client.state.stream.bitrateKbps || 0} kb/s` : '0 kb/s';
      const droppedFrames = client ? client.getDisplayStats().streamDroppedStr : '0 / 0 (0.0%)';

      const now = new Date();
      const timeStr = now.toLocaleTimeString();

      try {
        // Try server endpoint first
        let timeMs = null;
        let ttl = null;
        let isAlive = false;

        try {
          const encodedTarget = encodeURIComponent(this.target);
          const res = await fetch(`/api/ping?target=${encodedTarget}`);
          if (res.ok) {
            const data = await res.json();
            if (data.alive && data.timeMs !== null) {
              timeMs = data.timeMs;
              ttl = data.ttl || 117;
              isAlive = true;
            }
          }
        } catch (serverErr) {
          // Running standalone / GitHub Pages without local server:
          // Fall back to OBS WebSocket round-trip control latency or fetch timing!
          if (client && client.connected) {
            timeMs = client.wsLatencyMs || 2;
            isAlive = true;
            ttl = 64;
          }
        }

        if (isAlive && timeMs !== null) {
          this.packetReceived++;

          // Moving average calculation for spike threshold
          const validHistory = this.history.filter(v => v !== null && v.timeMs !== null).map(v => v.timeMs);
          const currentAvg = validHistory.length > 0 ? (validHistory.reduce((a, b) => a + b, 0) / validHistory.length) : timeMs;

          // Spike condition: > 70ms OR > 1.8x moving average (when avg >= 15ms)
          const isSpike = (timeMs >= 70) || (currentAvg >= 15 && timeMs >= currentAvg * 1.8);

          if (isSpike) {
            this.spikesDetected++;
            this.triggerSpikeAlert(timeMs, this.target);
          }

          const sample = {
            seq: this.packetSent,
            timestamp: now.toISOString().replace('T', ' ').substring(0, 19),
            target: this.target,
            timeMs,
            ttl,
            status: isSpike ? 'SPIKE' : 'Reply',
            streamState,
            streamBitrate,
            droppedFrames
          };

          this.history.push(sample);
          this.fullPingLog.push(sample);
          if (this.history.length > this.maxPoints) this.history.shift();

          this.updateUI(timeMs, isSpike);
        } else {
          // Packet loss / Timeout
          this.spikesDetected++;
          this.triggerSpikeAlert(null, this.target);

          const sample = {
            seq: this.packetSent,
            timestamp: now.toISOString().replace('T', ' ').substring(0, 19),
            target: this.target,
            timeMs: null,
            ttl: null,
            status: 'TIMEOUT / LOST',
            streamState,
            streamBitrate,
            droppedFrames
          };

          this.history.push(sample);
          this.fullPingLog.push(sample);
          if (this.history.length > this.maxPoints) this.history.shift();

          this.updateUI(null, true);
        }

        this.drawChart();
      } catch (err) {
        this.updateUI(null, true);
      }
    }

    triggerSpikeAlert(timeMs, target) {
      if (!this.spikeBanner) return;

      const msg = timeMs !== null
        ? `⚠️ PING SPIKE: ${timeMs} ms on ${target} (${new Date().toLocaleTimeString()})`
        : `⚠️ PACKET LOSS / TIMEOUT on ${target} (${new Date().toLocaleTimeString()})`;

      if (this.spikeMsg) this.spikeMsg.textContent = msg;
      this.spikeBanner.classList.remove('hidden');

      const pingWin = this.cardElement.querySelector('.network-ping-window');
      if (pingWin) {
        pingWin.classList.add('has-spike');
        setTimeout(() => pingWin.classList.remove('has-spike'), 3000);
      }

      // Audio Beep Alert
      playAlertBeep(920, 0.18);

      // Auto hide banner after 6 seconds
      setTimeout(() => {
        if (this.spikeBanner) this.spikeBanner.classList.add('hidden');
      }, 6000);
    }

    updateUI(currentMs, isSpike) {
      if (!this.valText) return;

      if (currentMs !== null) {
        this.valText.textContent = `${currentMs} ms`;
        if (isSpike) {
          this.valText.style.color = 'var(--color-danger)';
          this.badge.className = 'ping-quality-badge danger';
          this.badge.textContent = 'Spike Alert!';
        } else if (currentMs < 30) {
          this.valText.style.color = 'var(--color-rec)';
          this.badge.className = 'ping-quality-badge';
          this.badge.textContent = 'Excellent';
        } else if (currentMs < 80) {
          this.valText.style.color = 'var(--color-warning)';
          this.badge.className = 'ping-quality-badge warning';
          this.badge.textContent = 'Moderate';
        } else {
          this.valText.style.color = 'var(--color-danger)';
          this.badge.className = 'ping-quality-badge danger';
          this.badge.textContent = 'High Latency';
        }
      } else {
        this.valText.textContent = 'Loss';
        this.valText.style.color = 'var(--color-danger)';
        this.badge.className = 'ping-quality-badge danger';
        this.badge.textContent = 'Request Timeout';
      }

      // Aggregate Stats
      const validSamples = this.history.filter(x => x && x.timeMs !== null).map(x => x.timeMs);
      if (validSamples.length > 0) {
        const min = Math.min(...validSamples);
        const max = Math.max(...validSamples);
        const avg = Math.round(validSamples.reduce((a, b) => a + b, 0) / validSamples.length);
        if (this.minText) this.minText.textContent = `${min}ms`;
        if (this.maxText) this.maxText.textContent = `${max}ms`;
        if (this.avgText) this.avgText.textContent = `${avg}ms`;
      }

      const lossPct = this.packetSent > 0 ? (((this.packetSent - this.packetReceived) / this.packetSent) * 100).toFixed(1) : '0.0';
      if (this.lossText) {
        this.lossText.textContent = `${lossPct}%`;
        this.lossText.style.color = parseFloat(lossPct) > 0 ? 'var(--color-danger)' : 'var(--text-muted)';
      }

      if (this.spikesText) {
        this.spikesText.textContent = `${this.spikesDetected}`;
        this.spikesText.style.color = this.spikesDetected > 0 ? 'var(--color-warning)' : 'var(--text-muted)';
      }
    }

    drawChart() {
      if (!this.ctx || !this.canvas) return;
      const ctx = this.ctx;
      const w = this.canvas.getBoundingClientRect().width || 400;
      const h = this.canvas.getBoundingClientRect().height || 80;

      ctx.clearRect(0, 0, w, h);

      // Latency Threshold Grid Lines
      // Baseline 25ms, 50ms, 100ms
      const validValues = this.history.filter(v => v && v.timeMs !== null).map(v => v.timeMs);
      const maxVal = Math.max(80, ...(validValues.length > 0 ? validValues : [80])) * 1.25;

      // Draw Grid lines
      [25, 50, 100].forEach(ms => {
        if (ms < maxVal) {
          const y = h - (ms / maxVal) * (h - 12) - 6;
          ctx.strokeStyle = ms >= 100 ? 'rgba(239, 68, 68, 0.15)' : 'rgba(255, 255, 255, 0.06)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();

          ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
          ctx.font = '9px monospace';
          ctx.fillText(`${ms}ms`, 4, y - 2);
        }
      });

      if (this.history.length < 2) return;

      const stepX = w / (this.maxPoints - 1);
      const points = [];

      for (let i = 0; i < this.history.length; i++) {
        const item = this.history[i];
        const val = item ? item.timeMs : null;
        const x = i * stepX;
        const y = val === null ? h : h - (val / maxVal) * (h - 12) - 6;
        points.push({ x, y, isNull: val === null, isSpike: item ? item.status === 'SPIKE' : false, ms: val });
      }

      // Draw Gradient Area
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, 'rgba(16, 185, 129, 0.35)');
      grad.addColorStop(0.7, 'rgba(16, 185, 129, 0.05)');
      grad.addColorStop(1, 'rgba(16, 185, 129, 0.0)');

      ctx.beginPath();
      ctx.moveTo(points[0].x, h);
      for (const p of points) {
        ctx.lineTo(p.x, p.y);
      }
      ctx.lineTo(points[points.length - 1].x, h);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // Draw Smooth Connecting Line
      ctx.beginPath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#10b981';
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (i === 0) {
          ctx.moveTo(p.x, p.y);
        } else {
          ctx.lineTo(p.x, p.y);
        }
      }
      ctx.stroke();

      // Draw Spike and Loss Markers
      points.forEach(p => {
        if (p.isSpike) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = '#ef4444';
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        } else if (p.isNull) {
          ctx.beginPath();
          ctx.arc(p.x, h - 4, 3, 0, Math.PI * 2);
          ctx.fillStyle = '#ef4444';
          ctx.fill();
        }
      });

      // Highlight Current Point
      const last = points[points.length - 1];
      ctx.beginPath();
      ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = last.isSpike ? '#ef4444' : '#10b981';
      ctx.fill();
    }

    // --- EXPORT TO EXCEL (.CSV) FUNCTION ---
    exportToExcel() {
      if (this.fullPingLog.length === 0) {
        alert('No ping test data recorded yet. Please allow the test to run for a few seconds.');
        return;
      }

      const streamName = this.streamConfig.name || 'OBS_Stream';
      const targetHost = this.target;
      const exportTime = new Date().toLocaleString();
      const validMs = this.fullPingLog.filter(x => x.timeMs !== null).map(x => x.timeMs);
      const minMs = validMs.length > 0 ? Math.min(...validMs) : 0;
      const maxMs = validMs.length > 0 ? Math.max(...validMs) : 0;
      const avgMs = validMs.length > 0 ? Math.round(validMs.reduce((a, b) => a + b, 0) / validMs.length) : 0;
      const lossCount = this.packetSent - this.packetReceived;
      const lossPct = this.packetSent > 0 ? (((this.packetSent - this.packetReceived) / this.packetSent) * 100).toFixed(2) : '0.00';

      // Build CSV with Excel BOM (\uFEFF)
      let csv = '\uFEFF';
      csv += `"OBS BROADCAST PING & NETWORK DIAGNOSTIC REPORT"\n`;
      csv += `"Stream / PC Name","${escapeCsv(streamName)}"\n`;
      csv += `"Ping Target Host","${escapeCsv(targetHost)}"\n`;
      csv += `"Test Started","${escapeCsv(this.startTime.toLocaleString())}"\n`;
      csv += `"Test Exported","${escapeCsv(exportTime)}"\n`;
      csv += `"Total Packets Sent","${this.packetSent}"\n`;
      csv += `"Packets Received","${this.packetReceived}"\n`;
      csv += `"Packets Lost","${lossCount}"\n`;
      csv += `"Packet Loss Rate","${lossPct}%"\n`;
      csv += `"Minimum Latency","${minMs} ms"\n`;
      csv += `"Maximum Latency","${maxMs} ms"\n`;
      csv += `"Average Latency","${avgMs} ms"\n`;
      csv += `"Spikes Detected","${this.spikesDetected}"\n`;
      csv += `\n`;
      csv += `"Seq","Timestamp","Target Host","Latency (ms)","TTL","Ping Status","OBS Stream State","OBS Bitrate","Dropped Frames (Network)"\n`;

      this.fullPingLog.forEach(item => {
        csv += `${item.seq},"${item.timestamp}","${item.target}",${item.timeMs !== null ? item.timeMs : '"TIMEOUT"'},${item.ttl !== null ? item.ttl : '-'},"${item.status}","${item.streamState}","${item.streamBitrate}","${item.droppedFrames}"\n`;
      });

      // Trigger Browser Download
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const safeName = streamName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const dateTag = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      link.href = URL.createObjectURL(blob);
      link.setAttribute('download', `Ping_Report_${safeName}_${dateTag}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  }

  function escapeCsv(val) {
    if (!val) return '';
    return String(val).replace(/"/g, '""');
  }

  // --- DASHBOARD RENDERING ---
  function renderDashboard() {
    if (streams.length === 0) {
      emptyState.classList.remove('hidden');
      dashboardContainer.innerHTML = '';
      focusTabsBar.classList.add('hidden');
      updateMasterTally();
      return;
    }

    emptyState.classList.add('hidden');

    if (!activeFocusStreamId || !streams.some(s => s.id === activeFocusStreamId)) {
      activeFocusStreamId = streams[0].id;
    }

    if (viewMode === 'focus') {
      renderFocusTabs();
    }

    // Clean up unneeded clients & monitors
    const activeStreamIds = new Set(streams.map(s => s.id));
    for (const [id, client] of clients.entries()) {
      if (!activeStreamIds.has(id)) {
        client.disconnect();
        clients.delete(id);
      }
    }
    for (const [id, pm] of pingMonitors.entries()) {
      if (!activeStreamIds.has(id)) {
        pm.stop();
        pingMonitors.delete(id);
      }
    }

    dashboardContainer.innerHTML = '';

    const streamsToDisplay = viewMode === 'focus'
      ? streams.filter(s => s.id === activeFocusStreamId)
      : streams;

    streamsToDisplay.forEach(streamConfig => {
      const card = createStreamCard(streamConfig);
      dashboardContainer.appendChild(card);

      // Connect or retrieve OBS client
      let client = clients.get(streamConfig.id);
      if (!client) {
        client = new OBSClient(streamConfig);
        clients.set(streamConfig.id, client);

        client.on('onStateUpdate', () => {
          updateCardUI(streamConfig.id);
          updateMasterTally();
        });
        client.on('onConnect', () => {
          updateCardUI(streamConfig.id);
          updateMasterTally();
        });
        client.on('onDisconnect', () => {
          updateCardUI(streamConfig.id);
          updateMasterTally();
        });
        client.on('onError', (err) => {
          if (window.location.protocol === 'https:') {
            showSecurityBanner();
          }
          updateCardUI(streamConfig.id);
          updateMasterTally();
        });

        client.connect();
      }

      // Setup Ping Monitor
      if (!pingMonitors.has(streamConfig.id)) {
        const pm = new PingMonitor(streamConfig, card);
        pingMonitors.set(streamConfig.id, pm);
      } else {
        const pm = pingMonitors.get(streamConfig.id);
        pm.cardElement = card;
        pm.canvas = card.querySelector('.ping-canvas');
        pm.ctx = pm.canvas ? pm.canvas.getContext('2d') : null;
        pm.valText = card.querySelector('.ping-val-num');
        pm.badge = card.querySelector('.ping-quality-badge');
        pm.minText = card.querySelector('.ping-min');
        pm.maxText = card.querySelector('.ping-max');
        pm.avgText = card.querySelector('.ping-avg');
        pm.lossText = card.querySelector('.ping-loss');
        pm.spikesText = card.querySelector('.ping-spikes');
        pm.spikeBanner = card.querySelector('.spike-alert-banner');
        pm.spikeMsg = card.querySelector('.spike-alert-msg');
        pm.initCanvas();
      }

      updateCardUI(streamConfig.id);
    });

    applyFilterToDOM();
    updateMasterTally();
  }

  function renderFocusTabs() {
    focusTabsBar.innerHTML = '';
    streams.forEach(s => {
      const tab = document.createElement('div');
      const client = clients.get(s.id);
      const isLive = client && client.state.stream.outputActive;
      const isRec = client && client.state.record.outputActive;

      let extraClass = '';
      if (isLive) extraClass = 'live';
      else if (isRec) extraClass = 'recording-only';

      tab.className = `stream-tab ${s.id === activeFocusStreamId ? 'active' : ''} ${extraClass}`;
      tab.innerHTML = `
        <span class="tab-indicator"></span>
        <span>${escapeHtml(s.name)}</span>
      `;
      tab.addEventListener('click', () => {
        activeFocusStreamId = s.id;
        renderDashboard();
      });
      focusTabsBar.appendChild(tab);
    });
  }

  // --- STREAM CARD DOM CREATION ---
  function createStreamCard(s) {
    const card = document.createElement('div');
    card.className = 'stream-card status-standby';
    card.id = `card_${s.id}`;

    const isAdmin = currentRole === 'admin';
    const hostTagTitle = isAdmin ? 'Click to edit IP & Settings' : 'OBS Host IP';
    const hostTagIcon = isAdmin ? ' ✏️' : '';

    card.innerHTML = `
      <!-- Top Bar: Prominent Name, IP tag & Live Status -->
      <div class="card-top-bar">
        <div class="card-title-wrap">
          <div class="stream-name-badge">
            <span class="stream-name-text">${escapeHtml(s.name)}</span>
          </div>
          <span class="stream-host-tag" title="${hostTagTitle}" id="hostTag_${s.id}" style="${isAdmin ? 'cursor:pointer;' : 'cursor:default;'}">
            ${escapeHtml(s.host)}:${s.port}${hostTagIcon}
          </span>
        </div>

        <div class="card-live-tally offline" id="tally_${s.id}">
          <span class="tally-dot"></span>
          <span class="tally-label">OFFLINE</span>
          <span class="tally-time" style="display:none; font-family:var(--font-mono); font-size:0.75rem;"></span>
        </div>

        <div class="card-actions">
          <button class="btn btn-secondary btn-sm" id="reconnect_${s.id}" title="Reconnect WebSocket">
            ↺ Reconnect
          </button>
          <button class="btn btn-secondary btn-sm admin-only" id="edit_${s.id}" title="Edit Settings">
            ⚙
          </button>
          <button class="btn btn-danger btn-sm admin-only" id="delete_${s.id}" title="Remove Stream">
            ✕
          </button>
        </div>
      </div>

      <!-- Upstream Delay & Timecode Strip -->
      <div class="upstream-strip" data-filter-id="upstreamStrip">
        <div class="upstream-item">
          <span class="label">Upstream Uptime:</span>
          <span class="value" id="val_uptime_${s.id}">00:00:00</span>
        </div>
        <div class="upstream-item">
          <span class="label">Stream Delay Buffer:</span>
          <span class="value good" id="val_delay_${s.id}">0.0s (Direct)</span>
        </div>
        <div class="upstream-item">
          <span class="label">Network Congestion:</span>
          <span class="value" id="val_congestion_${s.id}">0%</span>
        </div>
        <div class="upstream-item">
          <span class="label">OBS Control Latency:</span>
          <span class="value" id="val_wslatency_${s.id}">0 ms</span>
        </div>
      </div>

      <!-- Network Ping Window & Live Chart -->
      <div class="network-ping-window" data-filter-id="pingWindow">
        <div class="ping-window-header">
          <div class="ping-title-group">
            <h4>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M5 12.55a11 11 0 0 1 14.08 0"></path>
                <path d="M1.42 9a16 16 0 0 1 21.16 0"></path>
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path>
                <line x1="12" y1="20" x2="12.01" y2="20"></line>
              </svg>
              Continuous Ping Monitor (ping -t)
            </h4>

            <!-- Direct IP Target Controls for Streaming PC Network -->
            <div class="ping-ip-control-wrap">
              <span class="ping-target-label">Ping IP:</span>
              <input type="text" class="ping-ip-input" id="pingTargetInput_${s.id}" value="${escapeHtml(s.pingTarget || s.host || '10.10.101.130')}" placeholder="IP to ping..." title="Enter IP address of streaming PC or network">
              <button class="btn btn-secondary btn-sm" id="btn_apply_ping_${s.id}" title="Apply this IP address">Apply IP</button>
              <button class="btn btn-text btn-sm" id="btn_ping_host_${s.id}" title="Test Streaming PC IP (${escapeHtml(s.host)})">Use PC IP</button>
              <select class="ping-target-select" id="pingTargetSelect_${s.id}" title="Quick Presets">
                <option value="">Presets ▼</option>
                <option value="${escapeHtml(s.host)}">Streaming PC (${escapeHtml(s.host)})</option>
                <option value="8.8.8.8">Google DNS (8.8.8.8)</option>
                <option value="1.1.1.1">Cloudflare (1.1.1.1)</option>
                <option value="127.0.0.1">Localhost (127.0.0.1)</option>
              </select>
            </div>
          </div>

          <div class="ping-header-actions">
            <!-- Sound Alert Toggle -->
            <button class="btn btn-secondary btn-sm" id="btn_sound_${s.id}" title="Toggle audio alert on ping spikes">
              🔔 Sound: ON
            </button>
            <!-- Excel Export Button -->
            <button class="btn btn-excel btn-sm" id="btn_export_${s.id}" title="Export all running ping data to Excel (.CSV) file">
              📥 Export to Excel (.CSV)
            </button>
          </div>
        </div>

        <!-- Spike Alert Banner -->
        <div class="spike-alert-banner hidden">
          <span class="spike-alert-msg">⚠️ PING SPIKE DETECTED</span>
        </div>

        <div class="ping-body">
          <div class="ping-main-metric">
            <span class="ping-value-text ping-val-num">-- ms</span>
            <span class="ping-quality-badge">Testing</span>
          </div>

          <div class="ping-chart-container">
            <canvas class="ping-canvas"></canvas>
            <div class="ping-sub-metrics">
              <span>Min: <strong class="ping-min">--</strong></span>
              <span>Max: <strong class="ping-max">--</strong></span>
              <span>Avg: <strong class="ping-avg">--</strong></span>
              <span>Loss: <strong class="ping-loss">0%</strong></span>
              <span>Spikes: <strong class="ping-spikes" style="color:var(--color-warning);">0</strong></span>
            </div>
          </div>
        </div>
      </div>

      <!-- OBS Stats Grid (Matches OBS Stats Window) -->
      <div class="obs-stats-grid">
        <!-- CPU Usage -->
        <div class="stat-card" data-filter-id="cpuUsage">
          <span class="stat-label">CPU Usage</span>
          <span class="stat-value" id="val_cpu_${s.id}">0.0%</span>
          <div class="progress-bar-wrap">
            <div class="progress-bar-fill" id="bar_cpu_${s.id}"></div>
          </div>
        </div>

        <!-- Memory Usage -->
        <div class="stat-card" data-filter-id="memoryUsage">
          <span class="stat-label">Memory Usage</span>
          <span class="stat-value" id="val_mem_${s.id}">0.0 MB</span>
          <span class="stat-subtext">OBS RAM Allocation</span>
        </div>

        <!-- Disk Space Available -->
        <div class="stat-card" data-filter-id="availableDiskSpace">
          <span class="stat-label">Disk Space Available</span>
          <span class="stat-value" id="val_disk_${s.id}">0.0 GB</span>
          <span class="stat-subtext">Recording Drive</span>
        </div>

        <!-- Disk Full In (approx) -->
        <div class="stat-card" data-filter-id="diskFullApprox">
          <span class="stat-label">Disk Full In (approx.)</span>
          <span class="stat-value" id="val_diskfull_${s.id}">N/A</span>
          <span class="stat-subtext">Estimated at current rate</span>
        </div>

        <!-- FPS -->
        <div class="stat-card" data-filter-id="fps">
          <span class="stat-label">FPS</span>
          <span class="stat-value" id="val_fps_${s.id}">0.00</span>
          <span class="stat-subtext">Target: 60.00 fps</span>
        </div>

        <!-- Average Frame Render Time -->
        <div class="stat-card" data-filter-id="renderTime">
          <span class="stat-label">Average Time to Render Frame</span>
          <span class="stat-value" id="val_rendertime_${s.id}">0.0 ms</span>
          <span class="stat-subtext">Budget: 16.6 ms</span>
        </div>

        <!-- Frames Missed (Rendering Lag) -->
        <div class="stat-card" data-filter-id="renderLag">
          <span class="stat-label">Frames Missed (Rendering Lag)</span>
          <span class="stat-value" id="val_renderlag_${s.id}">0 / 0 (0.0%)</span>
          <span class="stat-subtext">GPU / compositor drops</span>
        </div>

        <!-- Skipped Frames (Encoding Lag) -->
        <div class="stat-card" data-filter-id="encodingLag">
          <span class="stat-label">Skipped Frames (Encoding Lag)</span>
          <span class="stat-value" id="val_encodinglag_${s.id}">0 / 0 (0.0%)</span>
          <span class="stat-subtext">Encoder overload drops</span>
        </div>
      </div>

      <!-- Output Status Table (Replicates OBS Stats Output Table) -->
      <div class="output-table-section" data-filter-id="outputTable">
        <div class="output-table-wrapper">
          <table class="output-table">
            <thead>
              <tr>
                <th>Output</th>
                <th>Status</th>
                <th>Dropped Frames (Network)</th>
                <th>Total Data Output</th>
                <th>Bitrate</th>
              </tr>
            </thead>
            <tbody>
              <!-- Stream Row -->
              <tr>
                <td class="output-name-cell">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <circle cx="12" cy="12" r="6"/>
                  </svg>
                  Stream
                </td>
                <td>
                  <span class="status-badge inactive" id="tbl_stream_status_${s.id}">Inactive</span>
                </td>
                <td>
                  <span class="dropped-badge" id="tbl_stream_dropped_${s.id}">0 / 0 (0.0%)</span>
                </td>
                <td id="tbl_stream_data_${s.id}">0.0 MiB</td>
                <td>
                  <span class="bitrate-badge" id="tbl_stream_bitrate_${s.id}">0 kb/s</span>
                </td>
              </tr>

              <!-- Recording Row -->
              <tr>
                <td class="output-name-cell">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <rect x="5" y="5" width="14" height="14" rx="2"/>
                  </svg>
                  Recording
                </td>
                <td>
                  <span class="status-badge inactive" id="tbl_record_status_${s.id}">Inactive</span>
                </td>
                <td>-</td>
                <td id="tbl_record_data_${s.id}">0.0 MiB</td>
                <td>
                  <span class="bitrate-badge" id="tbl_record_bitrate_${s.id}">0 kb/s</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Card Footer Controls (Admin Only) -->
      <div class="card-footer admin-only">
        <div class="footer-left">
          <button class="btn btn-secondary btn-sm admin-only" id="btn_reset_${s.id}" title="Reset Stats Baseline Counters">
            Reset
          </button>
          <span style="font-size:0.75rem; color:var(--text-dim);" id="timecode_${s.id}">00:00:00.000</span>
        </div>

        <div class="footer-right admin-only">
          <button class="btn btn-secondary btn-sm admin-only" id="btn_stream_toggle_${s.id}">
            Start Streaming
          </button>
          <button class="btn btn-secondary btn-sm admin-only" id="btn_record_toggle_${s.id}">
            Start Recording
          </button>
        </div>
      </div>
    `;

    // Hook card action events
    const reconnectBtn = card.querySelector(`#reconnect_${s.id}`);
    reconnectBtn.addEventListener('click', () => {
      const client = clients.get(s.id);
      if (client) {
        client.disconnect();
        client.connect();
        flashElement(reconnectBtn);
      }
    });

    const editBtn = card.querySelector(`#edit_${s.id}`);
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        if (currentRole === 'admin') openStreamModal(s.id);
      });
    }

    const hostTag = card.querySelector(`#hostTag_${s.id}`);
    if (hostTag) {
      hostTag.addEventListener('click', () => {
        if (currentRole === 'admin') openStreamModal(s.id);
      });
    }

    const deleteBtn = card.querySelector(`#delete_${s.id}`);
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        if (currentRole === 'admin') removeStream(s.id);
      });
    }

    const resetBtn = card.querySelector(`#btn_reset_${s.id}`);
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (currentRole !== 'admin') return;
        const client = clients.get(s.id);
        if (client) {
          client.resetBaseline();
          flashElement(resetBtn);
        }
      });
    }

    // Sound toggle button
    const soundBtn = card.querySelector(`#btn_sound_${s.id}`);
    soundBtn.addEventListener('click', () => {
      soundAlertEnabled = !soundAlertEnabled;
      localStorage.setItem('obs_sound_alert', soundAlertEnabled.toString());
      soundBtn.textContent = soundAlertEnabled ? '🔔 Sound: ON' : '🔕 Sound: OFF';
      soundBtn.className = soundAlertEnabled ? 'btn btn-secondary btn-sm' : 'btn btn-text btn-sm';
      if (soundAlertEnabled) playAlertBeep(880, 0.1);
    });

    // Excel Export button
    const exportBtn = card.querySelector(`#btn_export_${s.id}`);
    exportBtn.addEventListener('click', () => {
      const pm = pingMonitors.get(s.id);
      if (pm) {
        pm.exportToExcel();
        flashElement(exportBtn);
      }
    });

    // Stream Toggle
    const streamToggleBtn = card.querySelector(`#btn_stream_toggle_${s.id}`);
    if (streamToggleBtn) {
      streamToggleBtn.addEventListener('click', async () => {
        if (currentRole !== 'admin') return;
        const client = clients.get(s.id);
        if (client) {
          if (client.state.stream.outputActive) {
            if (confirm(`Stop streaming on "${s.name}"?`)) {
              await client.stopStream();
            }
          } else {
            await client.startStream();
          }
        }
      });
    }

    // Record Toggle
    const recordToggleBtn = card.querySelector(`#btn_record_toggle_${s.id}`);
    if (recordToggleBtn) {
      recordToggleBtn.addEventListener('click', async () => {
        if (currentRole !== 'admin') return;
        const client = clients.get(s.id);
        if (client) {
          if (client.state.record.outputActive) {
            await client.stopRecord();
          } else {
            await client.startRecord();
          }
        }
      });
    }

    // Ping target input, apply button, and preset selector
    const pingInput = card.querySelector(`#pingTargetInput_${s.id}`);
    const applyPingBtn = card.querySelector(`#btn_apply_ping_${s.id}`);
    const pingHostBtn = card.querySelector(`#btn_ping_host_${s.id}`);
    const pingSelect = card.querySelector(`#pingTargetSelect_${s.id}`);

    const applyNewPingTarget = (newTarget) => {
      const trimmed = (newTarget || '').trim();
      if (!trimmed) return;
      s.pingTarget = trimmed;
      if (pingInput) pingInput.value = trimmed;
      const pm = pingMonitors.get(s.id);
      if (pm) {
        pm.setTarget(trimmed);
      }
      try {
        localStorage.setItem('obs_last_ping_target', trimmed);
      } catch (e) {}
      saveStreamsConfig();
      if (applyPingBtn) {
        const orig = applyPingBtn.textContent;
        applyPingBtn.textContent = '✓ Saved';
        applyPingBtn.style.color = 'var(--color-rec)';
        setTimeout(() => {
          applyPingBtn.textContent = orig;
          applyPingBtn.style.color = '';
        }, 1500);
      }
    };

    if (applyPingBtn) {
      applyPingBtn.addEventListener('click', () => {
        applyNewPingTarget(pingInput ? pingInput.value : '');
      });
    }

    if (pingInput) {
      pingInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          applyNewPingTarget(pingInput.value);
        }
      });
    }

    if (pingHostBtn) {
      pingHostBtn.addEventListener('click', () => {
        applyNewPingTarget(s.host);
      });
    }

    if (pingSelect) {
      pingSelect.addEventListener('change', () => {
        if (pingSelect.value) {
          applyNewPingTarget(pingSelect.value);
          pingSelect.value = '';
        }
      });
    }

    return card;
  }

  // --- CARD UI UPDATES & DYNAMIC BORDER COLORING ---
  function updateCardUI(streamId) {
    const card = document.getElementById(`card_${streamId}`);
    if (!card) return;

    const client = clients.get(streamId);
    if (!client) return;

    const tally = document.getElementById(`tally_${streamId}`);
    const tallyLabel = tally.querySelector('.tally-label');
    const tallyTime = tally.querySelector('.tally-time');

    const streamToggleBtn = card.querySelector(`#btn_stream_toggle_${streamId}`);
    const recordToggleBtn = card.querySelector(`#btn_record_toggle_${streamId}`);

    if (!client.connected) {
      tally.className = 'card-live-tally offline';
      tallyLabel.textContent = 'OFFLINE / DISCONNECTED';
      tallyTime.style.display = 'none';
      card.className = 'stream-card status-standby';
      if (streamToggleBtn) streamToggleBtn.disabled = true;
      if (recordToggleBtn) recordToggleBtn.disabled = true;
      return;
    }

    if (streamToggleBtn) streamToggleBtn.disabled = false;
    if (recordToggleBtn) recordToggleBtn.disabled = false;

    const stats = client.getDisplayStats();
    const isStreaming = stats.streamActive;
    const isRecording = stats.recordActive;

    // --- CRUCIAL REQUIREMENT: DYNAMIC BORDER COLORING ---
    // 1) When Recording: turn borders GREEN
    // 2) When Streaming: turn borders RED
    // 3) When Both: dual glowing border!
    if (isStreaming && isRecording) {
      card.className = 'stream-card status-both';
    } else if (isStreaming) {
      card.className = 'stream-card status-streaming';
    } else if (isRecording) {
      card.className = 'stream-card status-recording';
    } else {
      card.className = 'stream-card status-standby';
    }

    // Stream Tally (ON AIR or NOT)
    if (isStreaming) {
      tally.className = 'card-live-tally live';
      tallyLabel.textContent = '🔴 ON AIR';
      tallyTime.textContent = stats.streamTimecode;
      tallyTime.style.display = 'inline';
      if (streamToggleBtn) {
        streamToggleBtn.textContent = 'Stop Streaming';
        streamToggleBtn.className = 'btn btn-danger btn-sm';
      }
    } else if (stats.streamReconnecting) {
      tally.className = 'card-live-tally';
      tally.style.borderColor = 'var(--color-warning)';
      tallyLabel.textContent = '🟡 RECONNECTING';
      tallyTime.style.display = 'none';
      if (streamToggleBtn) {
        streamToggleBtn.textContent = 'Start Streaming';
        streamToggleBtn.className = 'btn btn-secondary btn-sm';
      }
    } else if (isRecording) {
      tally.className = 'card-live-tally recording-only';
      tallyLabel.textContent = '● RECORDING';
      tallyTime.textContent = stats.recordTimecode;
      tallyTime.style.display = 'inline';
      if (streamToggleBtn) {
        streamToggleBtn.textContent = 'Start Streaming';
        streamToggleBtn.className = 'btn btn-secondary btn-sm';
      }
    } else {
      tally.className = 'card-live-tally offline';
      tally.style.borderColor = '';
      tallyLabel.textContent = 'STANDBY';
      tallyTime.style.display = 'none';
      if (streamToggleBtn) {
        streamToggleBtn.textContent = 'Start Streaming';
        streamToggleBtn.className = 'btn btn-secondary btn-sm';
      }
    }

    if (recordToggleBtn) {
      if (isRecording) {
        recordToggleBtn.textContent = 'Stop Recording';
        recordToggleBtn.className = 'btn btn-danger btn-sm';
      } else {
        recordToggleBtn.textContent = 'Start Recording';
        recordToggleBtn.className = 'btn btn-secondary btn-sm';
      }
    }

    // Upstream Delay & Timecode Strip
    setText(`val_uptime_${streamId}`, stats.upstreamDuration);
    setText(`val_delay_${streamId}`, stats.upstreamDelayBuffer);
    setText(`val_congestion_${streamId}`, stats.upstreamCongestion);
    setText(`val_wslatency_${streamId}`, `${stats.wsLatencyMs} ms`);

    const delayEl = document.getElementById(`val_delay_${streamId}`);
    if (delayEl) {
      delayEl.className = stats.upstreamDelayBuffer.startsWith('0.0s') ? 'value good' : 'value warn';
    }

    // OBS Stats Values
    setText(`val_cpu_${streamId}`, stats.cpuUsage);
    setText(`val_mem_${streamId}`, stats.memoryUsage);
    setText(`val_disk_${streamId}`, stats.availableDiskSpace);
    setText(`val_diskfull_${streamId}`, stats.diskFullApprox);
    setText(`val_fps_${streamId}`, stats.fps);
    setText(`val_rendertime_${streamId}`, stats.renderTime);
    setText(`val_renderlag_${streamId}`, stats.renderLagStr);
    setText(`val_encodinglag_${streamId}`, stats.encodingLagStr);
    setText(`timecode_${streamId}`, isStreaming ? stats.streamTimecode : isRecording ? stats.recordTimecode : '00:00:00.000');

    // CPU Bar
    const cpuBar = document.getElementById(`bar_cpu_${streamId}`);
    if (cpuBar) {
      const cpuNum = parseFloat(stats.cpuUsage) || 0;
      cpuBar.style.width = Math.min(100, cpuNum) + '%';
      cpuBar.className = 'progress-bar-fill' + (cpuNum > 75 ? ' danger' : cpuNum > 35 ? ' warning' : '');
    }

    // Output Table
    const tblStreamStatus = document.getElementById(`tbl_stream_status_${streamId}`);
    if (tblStreamStatus) {
      tblStreamStatus.className = isStreaming ? 'status-badge active' : 'status-badge inactive';
      tblStreamStatus.textContent = isStreaming ? 'Active' : 'Inactive';
    }

    const tblStreamDropped = document.getElementById(`tbl_stream_dropped_${streamId}`);
    if (tblStreamDropped) {
      tblStreamDropped.textContent = stats.streamDroppedStr;
      const hasDrops = !stats.streamDroppedStr.startsWith('0 /') && !stats.streamDroppedStr.includes('(0.0%)');
      tblStreamDropped.className = 'dropped-badge' + (hasDrops ? ' has-drops' : '');
    }

    setText(`tbl_stream_data_${streamId}`, stats.streamDataOutput);
    setText(`tbl_stream_bitrate_${streamId}`, stats.streamBitrate);

    const tblRecordStatus = document.getElementById(`tbl_record_status_${streamId}`);
    if (tblRecordStatus) {
      tblRecordStatus.className = isRecording ? 'status-badge recording' : 'status-badge inactive';
      tblRecordStatus.textContent = isRecording ? 'Active' : 'Inactive';
    }
    setText(`tbl_record_data_${streamId}`, stats.recordDataOutput);
    setText(`tbl_record_bitrate_${streamId}`, stats.recordBitrate);
  }

  // --- MASTER ON AIR TALLY UPDATE ---
  function updateMasterTally() {
    let liveCount = 0;
    let recCount = 0;
    let liveStreamNames = [];
    let longestTimecode = '00:00:00';

    clients.forEach((client, id) => {
      if (client.state.stream.outputActive) {
        liveCount++;
        const s = streams.find(item => item.id === id);
        if (s) liveStreamNames.push(s.name);
        if (client.state.stream.outputTimecode) {
          longestTimecode = client.state.stream.outputTimecode.split('.')[0];
        }
      }
      if (client.state.record.outputActive) {
        recCount++;
      }
    });

    if (liveCount > 0) {
      masterTally.className = 'master-tally live';
      masterStatusText.textContent = `🔴 ON AIR (${liveCount}/${streams.length} LIVE)`;
      masterDetailText.textContent = `${liveStreamNames.join(' & ')} • ${longestTimecode}`;
      document.title = `🔴 [ON AIR] OBS Controller (${liveCount} Live)`;
    } else if (recCount > 0) {
      masterTally.className = 'master-tally recording-only';
      masterStatusText.textContent = `● RECORDING (${recCount} Active)`;
      masterDetailText.textContent = `${recCount} streams recording`;
      document.title = `● [RECORDING] OBS Controller`;
    } else {
      masterTally.className = 'master-tally offline';
      masterStatusText.textContent = 'STANDBY';
      masterDetailText.textContent = streams.length > 0 ? `${streams.length} Streams Connected & Ready` : 'No Streams Configured';
      document.title = 'OBS Broadcast Web Controller & Stats Monitor';
    }
  }

  // --- UTILS ---
  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function flashElement(el) {
    el.style.transform = 'scale(0.92)';
    setTimeout(() => { el.style.transform = ''; }, 150);
  }

  // Start the application
  window.addEventListener('DOMContentLoaded', init);
})();
