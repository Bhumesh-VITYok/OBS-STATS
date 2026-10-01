# OBS Web Controller & Broadcast Stats Monitor

A broadcast-grade web dashboard and remote controller for **OBS Studio (v28+)**. Monitor live stream health, hardware stats, network ping latency, packet loss, and upstream delay across multiple streaming PCs (e.g., *Hindi Stream*, *English Stream*) in real time.

---

## 🌟 Key Features

1. **Prominent Master "ON AIR" Tally**:
   - High-visibility broadcast tally banner on top of the site.
   - 🔴 **ON AIR** (pulsing red beacon, duration timecode, active stream names).
   - ● **RECORDING** (emerald green indicator).
   - ⚪ **STANDBY** (clean slate when idle).

2. **Dynamic Glowing Card Borders**:
   - 🔴 **RED Border & Glow**: Active when **STREAMING LIVE**.
   - 🟢 **GREEN Border & Glow**: Active when **RECORDING**.
   - 🟡 **DUAL Pulsing Border**: Active when **BOTH Streaming AND Recording** simultaneously!
   - ⚪ **Dark Border**: Standby / Offline.

3. **Complete OBS Stats (Matching OBS Stats Window)**:
   - **CPU Usage** (%) with colorized progress bar.
   - **Memory Usage** (MB).
   - **Disk Space Available** (TB / GB).
   - **Disk Full In (approx.)** based on real-time recording bitrate.
   - **FPS** (Frames per second) with 60fps target indicator.
   - **Average Time to Render Frame** (ms) with 16.6ms frame budget.
   - **Frames Missed due to Rendering Lag** (count & %).
   - **Skipped Frames due to Encoding Lag** (count & %).
   - **Outputs Table**: Stream, Recording & DeckLink outputs with Status, Dropped Frames (Network), Total Data Output (MiB/GiB), and Bitrate (kb/s).
   - **"Reset Stats" Button**: Emulates the OBS Stats window's Reset button to zero out baseline counters.

4. **Upstream Delay & Uptime Strip**:
   - **Upstream Uptime**: Live duration timer.
   - **Stream Delay Buffer**: Real-time delay buffer estimate based on network congestion.
   - **Network Congestion**: Percentage of network buffer saturation.
   - **OBS Control Latency**: Real-time WebSocket round-trip control latency.

5. **Continuous Ping Monitor (`ping -t`) with Spike Alerts & Excel Export**:
   - Runs a continuous real-time ping test in background (1 second interval).
   - Target selector: Google DNS (`8.8.8.8`), Cloudflare (`1.1.1.1`), OBS Host IP, YouTube RTMP, Twitch Ingest, or Custom IP.
   - Real-time rolling Canvas sparkline chart with latency thresholds (25ms, 50ms, 100ms).
   - **Ping Spike Alert System**:
     - Automatically detects latency spikes (> 70ms or +80% above average) and packet loss.
     - Animated warning banner: `⚠️ PING SPIKE: 135 ms`.
     - **Web Audio Alert Beep**: Plays a subtle broadcast warning tone on spikes (toggleable with `🔔 Sound: ON/OFF`).
   - **📥 Export to Excel (.CSV)**:
     - Downloads an Excel-compatible `.csv` file with complete test statistics: Total Packets, Packets Lost, Loss %, Min/Max/Avg, and every single ping row with timestamp, target, latency, stream status, bitrate, and dropped frames!

6. **Customizable Dropdown Stats Filter**:
   - Click **"Filter Stats"** in the top bar to show/hide any metric card.
   - Quick presets: *Show All*, *Stream Focus*, *Hardware*, *Minimal*.
   - Preferences automatically saved in `localStorage`.

7. **Multi-Stream & Multi-PC Support**:
   - Add multiple streaming PCs (*Hindi Stream*, *English Stream*, *Stage Feed*).
   - View mode switcher: **Grid View** (all streams side-by-side) or **Focus View** (large focused view with quick tabs).

---

## 🚀 How to Run Independently (No Antigravity Needed!)

### Option A: 1-Click Desktop Shortcut (Easiest)
1. A shortcut named **`OBS Broadcast Monitor`** has been created on your Windows Desktop.
2. Double-click the shortcut anytime to launch the server and open the dashboard!

### Option B: Double-Click `START_OBS_MONITOR.bat`
1. Navigate to `c:\BHUMESH\OBS WEB\`
2. Double-click `START_OBS_MONITOR.bat`
3. The server starts in the background and opens `http://localhost:3000` in your browser.
4. Production crew on other computers, phones, or tablets on the same Wi-Fi/LAN can open the displayed network address (e.g. `http://10.10.101.200:3000`).

### Option C: Host for FREE on GitHub Pages (Access From Anywhere)
Because the dashboard can connect directly to OBS via WebSocket from any browser:
1. Run `DEPLOY_TO_GITHUB.bat` (or push this directory to a GitHub repository).
2. Go to your GitHub repo **Settings** > **Pages** > select branch `main` and root `/`.
3. Your site is live for free at `https://<your-username>.github.io/<repo-name>/`!
4. Open the link on any device anywhere, enter your Streaming PC's IP and password, and monitor live!

### Option D: Direct Browser Run
Double-click `index.html` or `public/index.html` in File Explorer to run directly in Google Chrome or Microsoft Edge.

---

## ⚙️ OBS Studio WebSocket Setup
OBS Studio 28 and newer includes the WebSocket server built-in:
1. In OBS Studio, go to **Tools** > **WebSocket Server Settings**.
2. Check **Enable WebSocket server**.
3. Default Server Port: `4455`.
4. Server Password: Set your password (default configured: `12345678`).
5. Click **Apply** > **OK**.
