/* === dashboard.js — Yield-Vision OpenCV PCB Panel ===
   Socket.IO client · Canvas charts · Real-time updates  */

const socket = io();

// ─── STATE ────────────────────────────────────────────────
let fpsHistory = new Array(40).fill(0);
let defectCounts = {};
let scanActive = false;
let uptimeStart = Date.now();
let boardsInspected = 0;
let passCount = 0;
let failCount = 0;

// ─── CLOCK ────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2,'0');
  const mm = String(now.getMinutes()).padStart(2,'0');
  const ss = String(now.getSeconds()).padStart(2,'0');
  document.getElementById('clock').textContent = `${hh}:${mm}:${ss}`;
  const dd = `${String(now.getDate()).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}/${now.getFullYear()}`;
  document.getElementById('clock-date').textContent = dd;

  const elapsed = Math.floor((Date.now() - uptimeStart) / 1000);
  const uh = String(Math.floor(elapsed / 3600)).padStart(2,'0');
  const um = String(Math.floor((elapsed % 3600) / 60)).padStart(2,'0');
  const us = String(elapsed % 60).padStart(2,'0');
  document.getElementById('uptime').textContent = `${uh}:${um}:${us}`;
}
setInterval(updateClock, 1000);
updateClock();

// ─── AUDIO ────────────────────────────────────────────────
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playFaultBeep() {
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(800, audioCtx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(400, audioCtx.currentTime + 0.3);
  gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(); osc.stop(audioCtx.currentTime + 0.3);
}

// ─── SOCKET EVENTS ────────────────────────────────────────
socket.on('connect', () => {
  document.getElementById('st-socket').textContent = 'CONNECTED';
  document.getElementById('st-socket').className = 'st-val st-green';
  addConsole('WebSocket connected', 'info');
});
socket.on('disconnect', () => {
  document.getElementById('st-socket').textContent = 'LOST';
  document.getElementById('st-socket').className = 'st-val st-red';
  addConsole('WebSocket disconnected', 'error');
});

socket.on('telemetry', (d) => {
  updateTelemetry(d);
});

socket.on('fault_alert', (d) => {
  if (!scanActive) playFaultBeep();
  document.getElementById('fault-banner').classList.remove('hidden');
  document.getElementById('fault-overlay').classList.remove('hidden');
  document.getElementById('fault-banner-text').textContent = d.message;
  addConsole(`[CRITICAL] ${d.message}`, 'error');
});

socket.on('alert_cleared', () => {
  document.getElementById('fault-banner').classList.add('hidden');
  document.getElementById('fault-overlay').classList.add('hidden');
});

socket.on('reference_registered', (d) => {
  addConsole(`Golden circuit reference registered! (${d.kp} key-points)`, 'info');
  const flash = document.createElement('div');
  flash.style.position = 'absolute';
  flash.style.inset = '0';
  flash.style.backgroundColor = 'rgba(0, 255, 136, 0.4)';
  flash.style.zIndex = '9999';
  flash.style.transition = 'opacity 0.5s';
  document.getElementById('video-wrap').appendChild(flash);
  setTimeout(() => { flash.style.opacity = '0'; }, 50);
  setTimeout(() => { flash.remove(); }, 550);
});

socket.on('defect_alert', (det) => {
  addDefectToLog(det);
  defectCounts[det.class] = (defectCounts[det.class] || 0) + 1;
  drawDefectDonut();
  addConsole(`⚠ ${det.class.replace(/_/g,' ').toUpperCase()} detected — ${det.confidence}% conf`, 'warn');
});

socket.on('scan_started', (d) => {
  scanActive = true;
  document.getElementById('scan-overlay').classList.remove('hidden');
  document.getElementById('btn-scan').disabled = true;
  document.getElementById('vid-scan-status').textContent = '◉ SCANNING';
  addConsole('Multi-angle scan initiated...', 'info');
  const badge = document.getElementById('system-status-badge');
  badge.className = 'status-badge status-scanning';
  document.getElementById('system-status-label').textContent = 'SCANNING';
  badge.querySelector('.pulse-dot').style.background = '#FF8C00';
  badge.querySelector('.pulse-dot').style.boxShadow = '0 0 8px #FF8C00';
});

socket.on('scan_progress', (d) => {
  document.getElementById('scan-angle-display').textContent = `Angle: ${d.angle > 0 ? '+' : ''}${d.angle}°`;
  document.getElementById('scan-step-info').textContent = `Step ${d.step} / ${d.total}`;
  const pct = (d.step / d.total) * 100;
  document.getElementById('scan-progress-bar').style.width = pct + '%';

  // Highlight angle chip
  document.querySelectorAll('.angle-chip').forEach(ch => {
    ch.classList.toggle('active', parseInt(ch.dataset.angle) === d.angle);
  });
  document.getElementById('tilt-center').textContent = `${d.angle}°`;
  document.getElementById('tilt-slider').value = d.angle;
  drawTiltGauge(d.angle);
  document.getElementById('st-tilt').textContent = `${d.angle > 0 ? '+' : ''}${d.angle}.0°`;
});

socket.on('scan_complete', (d) => {
  scanActive = false;
  boardsInspected = d.boards_inspected;
  document.getElementById('scan-overlay').classList.add('hidden');
  document.getElementById('btn-scan').disabled = false;
  document.getElementById('vid-scan-status').textContent = 'MONITORING';

  const badge = document.getElementById('system-status-badge');
  badge.className = 'status-badge status-online';
  document.getElementById('system-status-label').textContent = 'SYSTEM ONLINE';
  badge.querySelector('.pulse-dot').style.background = '';
  badge.querySelector('.pulse-dot').style.boxShadow = '';

  const res = d.result;
  addConsole(`Scan complete — Board #${d.boards_inspected}: ${res} (${d.defects_found} defects)`, res === 'FAIL' ? 'error' : 'info');
});

// ─── TELEMETRY UPDATE ─────────────────────────────────────
function updateTelemetry(d) {
  // FPS
  fpsHistory.push(d.fps);
  fpsHistory.shift();
  document.getElementById('fps-display').textContent = d.fps.toFixed(1);
  document.getElementById('hdr-fps').textContent = d.fps.toFixed(1);
  drawFpsSparkline();

  // Defects / boards
  document.getElementById('hdr-defects').textContent = d.total_defects;
  document.getElementById('hdr-boards').textContent = d.boards_inspected;
  document.getElementById('stat-defects').textContent = d.total_defects;
  document.getElementById('stat-boards').textContent = d.boards_inspected;
  document.getElementById('stat-pass').textContent = d.pass_count;
  document.getElementById('stat-fail').textContent = d.fail_count;
  boardsInspected = d.boards_inspected;
  passCount = d.pass_count;
  failCount = d.fail_count;

  // IMU
  if (d.imu) {
    const { roll, pitch, yaw, accel_x, accel_y, accel_z } = d.imu;
    document.getElementById('imu-roll').textContent  = `${roll.toFixed(2)}°`;
    document.getElementById('imu-pitch').textContent = `${pitch.toFixed(2)}°`;
    document.getElementById('imu-yaw').textContent   = `${yaw.toFixed(2)}°`;
    document.getElementById('imu-ax').textContent = accel_x.toFixed(3);
    document.getElementById('imu-ay').textContent = accel_y.toFixed(3);
    document.getElementById('imu-az').textContent = accel_z.toFixed(3);
    // Bars (±30° range)
    document.getElementById('imu-roll-bar').style.width  = `${Math.min(100, Math.max(0, ((roll + 30) / 60) * 100))}%`;
    document.getElementById('imu-pitch-bar').style.width = `${Math.min(100, Math.max(0, ((pitch + 30) / 60) * 100))}%`;
    document.getElementById('imu-yaw-bar').style.width   = `${Math.min(100, Math.max(0, ((yaw + 30) / 60) * 100))}%`;
  }

  // Circuit Badge
  const badge = document.getElementById('circuit-badge');
  const icon = document.getElementById('circuit-icon');
  const lbl = document.getElementById('circuit-label');
  badge.className = 'circuit-badge'; // reset
  if (d.circuit_status === 'FAULTY') {
    badge.classList.add('circuit-faulty');
    icon.textContent = '⚠';
    lbl.textContent = 'CIRCUIT: FAULTY';
  } else if (d.circuit_status === 'CLEAN' || d.circuit_status === 'CORRECT') {
    badge.classList.add('circuit-clean');
    icon.textContent = '✓';
    lbl.textContent = d.circuit_status === 'CORRECT' ? 'CIRCUIT: CORRECT' : 'CIRCUIT: CLEAN';
  } else if (d.circuit_status === 'SCANNING') {
    badge.classList.add('circuit-scanning');
    icon.textContent = '◉';
    lbl.textContent = 'CIRCUIT: SCANNING';
  } else if (d.circuit_status === 'NOT DETECTED') {
    badge.classList.add('circuit-unknown');
    icon.textContent = '∅';
    lbl.textContent = 'CIRCUIT NOT DETECTED';
  } else {
    badge.classList.add('circuit-unknown');
    icon.textContent = '◈';
    lbl.textContent = 'CIRCUIT: UNKNOWN';
  }

  // Tilt
  if (!scanActive) {
    document.getElementById('st-tilt').textContent = `${d.tilt >= 0 ? '+' : ''}${d.tilt.toFixed(1)}°`;
    drawTiltGauge(d.tilt);
  }

  // Yield
  drawYieldArc();
}

// ─── TILT GAUGE (Canvas) ──────────────────────────────────
function drawTiltGauge(angle) {
  const canvas = document.getElementById('tilt-canvas');
  const ctx = canvas.getContext('2d');
  const cx = 70, cy = 70, r = 58;
  ctx.clearRect(0, 0, 140, 140);

  // BG circle
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,255,136,0.1)';
  ctx.lineWidth = 8;
  ctx.stroke();

  // Arc fill (angle / 45 = normalized)
  const norm = angle / 45;
  const startAngle = -Math.PI / 2;
  const endAngle = startAngle + norm * Math.PI * 0.75;
  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, endAngle, norm < 0);
  const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
  grad.addColorStop(0, '#00FF88');
  grad.addColorStop(1, '#00D4FF');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.lineCap = 'butt';

  // Tick marks
  for (let a = -45; a <= 45; a += 15) {
    const rad = (-Math.PI / 2) + (a / 45) * (Math.PI * 0.75);
    const x1 = cx + (r - 12) * Math.cos(rad);
    const y1 = cy + (r - 12) * Math.sin(rad);
    const x2 = cx + r * Math.cos(rad);
    const y2 = cy + r * Math.sin(rad);
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.strokeStyle = a === 0 ? '#00FF88' : 'rgba(0,200,120,0.3)';
    ctx.lineWidth = a === 0 ? 2 : 1;
    ctx.stroke();
  }

  // Needle
  const needleRad = (-Math.PI / 2) + (angle / 45) * (Math.PI * 0.75);
  const nx = cx + (r - 18) * Math.cos(needleRad);
  const ny = cy + (r - 18) * Math.sin(needleRad);
  ctx.beginPath();
  ctx.moveTo(cx, cy); ctx.lineTo(nx, ny);
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Center dot
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#00FF88';
  ctx.fill();
  ctx.shadowColor = '#00FF88';
  ctx.shadowBlur = 8;
  ctx.fill();
  ctx.shadowBlur = 0;

  // Sync text
  document.getElementById('tilt-center').textContent = `${angle >= 0 ? '+' : ''}${angle.toFixed(0)}°`;
}
drawTiltGauge(0);

// ─── FPS SPARKLINE ────────────────────────────────────────
function drawFpsSparkline() {
  const canvas = document.getElementById('fps-sparkline');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const max = Math.max(...fpsHistory, 30);
  const step = W / (fpsHistory.length - 1);

  ctx.beginPath();
  fpsHistory.forEach((v, i) => {
    const x = i * step;
    const y = H - (v / max) * (H - 2) - 1;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#00FF88';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Fill
  ctx.lineTo(W, H); ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,255,136,0.08)';
  ctx.fill();
}
drawFpsSparkline();

// ─── DEFECT DONUT (Canvas) ────────────────────────────────
const DEFECT_COLORS = {
  missing_component: '#FF4444',
  dry_solder_joint:  '#FF8C00',
  trace_anomaly:     '#00FFFF',
  tombstoning:       '#FF00FF',
  solder_bridge:     '#FFD700',
  component_shift:   '#00FF80',
};

function drawDefectDonut() {
  const canvas = document.getElementById('defect-donut');
  const ctx = canvas.getContext('2d');
  const cx = 80, cy = 80, outerR = 65, innerR = 42;
  ctx.clearRect(0, 0, 160, 160);

  const entries = Object.entries(defectCounts).filter(([,v]) => v > 0);
  const total = entries.reduce((s, [,v]) => s + v, 0);

  if (total === 0) {
    // Empty ring
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,255,136,0.15)';
    ctx.lineWidth = outerR - innerR;
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,255,136,0.6)';
    ctx.font = 'bold 14px Orbitron, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CLEAN', cx, cy - 6);
    ctx.font = '10px Share Tech Mono';
    ctx.fillStyle = 'rgba(0,200,100,0.5)';
    ctx.fillText('NO DEFECTS', cx, cy + 10);
    return;
  }

  let startAngle = -Math.PI / 2;
  entries.forEach(([cls, count]) => {
    const slice = (count / total) * Math.PI * 2;
    const col = DEFECT_COLORS[cls] || '#FFFFFF';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, outerR, startAngle, startAngle + slice);
    ctx.closePath();
    ctx.fillStyle = col + '33';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, (outerR + innerR) / 2, startAngle, startAngle + slice);
    ctx.strokeStyle = col;
    ctx.lineWidth = outerR - innerR;
    ctx.stroke();
    startAngle += slice;
  });

  // Center hole
  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(6,11,15,0.95)';
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 18px Orbitron, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(total, cx, cy - 6);
  ctx.font = '9px Share Tech Mono';
  ctx.fillStyle = 'rgba(200,200,200,0.6)';
  ctx.fillText('DEFECTS', cx, cy + 10);

  // Legend
  const legend = document.getElementById('defect-legend');
  legend.innerHTML = entries.map(([cls, count]) => {
    const col = DEFECT_COLORS[cls] || '#FFF';
    const label = cls.replace(/_/g, ' ');
    return `<div class="legend-item">
      <div class="legend-dot" style="background:${col}"></div>
      <span>${label}</span>
      <span class="legend-count">${count}</span>
    </div>`;
  }).join('');
}
drawDefectDonut();

// ─── YIELD ARC ────────────────────────────────────────────
function drawYieldArc() {
  const canvas = document.getElementById('yield-arc');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H - 4, r = H - 12;
  ctx.clearRect(0, 0, W, H);

  const total = passCount + failCount;
  const yieldPct = total === 0 ? 1 : passCount / total;
  const yieldDisplay = total === 0 ? '100%' : `${Math.round(yieldPct * 100)}%`;
  document.getElementById('yield-val').textContent = yieldDisplay;

  // BG
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, 0);
  ctx.strokeStyle = 'rgba(0,255,136,0.1)';
  ctx.lineWidth = 10;
  ctx.stroke();

  // Fill
  const endAngle = Math.PI + yieldPct * Math.PI;
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, endAngle);
  const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
  const col = yieldPct > 0.9 ? ['#00FF88', '#00D4FF'] : yieldPct > 0.7 ? ['#FFD700', '#FF8C00'] : ['#FF4444', '#FF0055'];
  grad.addColorStop(0, col[0]); grad.addColorStop(1, col[1]);
  ctx.strokeStyle = grad;
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.stroke();
}
drawYieldArc();

// ─── DEFECT LOG ───────────────────────────────────────────
function addDefectToLog(det) {
  const log = document.getElementById('defect-log');
  const col = DEFECT_COLORS[det.class] || '#FFF';
  const old = log.querySelector('.log-empty');
  if (old) old.remove();

  const el = document.createElement('div');
  el.className = 'log-item';
  el.style.borderLeftColor = col;
  el.innerHTML = `
    <div class="log-item-top">
      <span class="log-class" style="color:${col}">${det.class.replace(/_/g,' ').toUpperCase()}</span>
      <span class="log-conf">${det.confidence}%</span>
    </div>
    <div class="log-bottom">
      <span class="log-time">${det.timestamp}</span>
      <span class="log-sev" style="background:${col}22;color:${col};border:1px solid ${col}44">${det.severity}</span>
    </div>`;
  log.insertBefore(el, log.firstChild);

  // Keep max 30
  while (log.children.length > 30) log.lastChild.remove();

  const count = log.children.length;
  document.getElementById('log-count').textContent = `${count} entr${count === 1 ? 'y' : 'ies'}`;
}

// ─── CONSOLE ──────────────────────────────────────────────
function addConsole(msg, type = '') {
  const log = document.getElementById('console-log');
  const el = document.createElement('div');
  el.className = `console-line ${type}`;
  const ts = new Date().toTimeString().slice(0, 8);
  el.textContent = `[${ts}] ${msg}`;
  log.insertBefore(el, log.firstChild);
  while (log.children.length > 20) log.lastChild.remove();
}

// ─── CONTROLS ─────────────────────────────────────────────
function startScan() {
  if (scanActive) return;
  socket.emit('request_scan');
}

function registerReference() {
  socket.emit('register_reference');
  addConsole('Capturing golden reference frame...', 'info');
}

function clearDefects() {
  fetch('/api/clear_defects', { method: 'POST' })
    .then(() => {
      document.getElementById('defect-log').innerHTML = '<div class="log-empty">No defects detected. System monitoring...</div>';
      document.getElementById('log-count').textContent = '0 entries';
      document.getElementById('hdr-defects').textContent = '0';
      document.getElementById('stat-defects').textContent = '0';
      Object.keys(defectCounts).forEach(k => { defectCounts[k] = 0; });
      drawDefectDonut();
      addConsole('Defect log cleared', 'info');
    });
}

function exportLog() {
  fetch('/api/status').then(r => r.json()).then(d => {
    if (!d.defect_log || d.defect_log.length === 0) {
      addConsole('No defects to export', 'warn'); return;
    }
    const header = 'ID,Timestamp,Class,Confidence,Severity,Tilt\n';
    const rows = d.defect_log.map(e =>
      `${e.id},${e.timestamp},${e.class},${e.confidence}%,${e.severity},${e.tilt}°`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `yield_vision_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    addConsole(`Exported ${d.defect_log.length} records to CSV`, 'info');
  });
}

function dismissAlert() {
  document.getElementById('fault-banner').classList.add('hidden');
  document.getElementById('fault-overlay').classList.add('hidden');
  fetch('/api/dismiss_alert', { method: 'POST' });
}

// ─── TILT SLIDER ──────────────────────────────────────────
const tiltSlider = document.getElementById('tilt-slider');
tiltSlider.addEventListener('input', () => {
  const angle = parseInt(tiltSlider.value);
  drawTiltGauge(angle);
  document.getElementById('st-tilt').textContent = `${angle >= 0 ? '+' : ''}${angle}.0°`;
  socket.emit('set_tilt', { angle });
  document.querySelectorAll('.angle-chip').forEach(ch => {
    ch.classList.toggle('active', parseInt(ch.dataset.angle) === angle);
  });
});

// Angle chips
document.querySelectorAll('.angle-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const angle = parseInt(chip.dataset.angle);
    tiltSlider.value = angle;
    drawTiltGauge(angle);
    document.getElementById('st-tilt').textContent = `${angle >= 0 ? '+' : ''}${angle}.0°`;
    socket.emit('set_tilt', { angle });
    document.querySelectorAll('.angle-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
  });
});

// ─── INIT ─────────────────────────────────────────────────
addConsole('Yield-Vision OpenCV Panel loaded', 'info');
addConsole('Socket.IO connecting...', 'info');

// ─── CLIENT WEBCAM PIPELINE ────────────────────────────────
const videoElement = document.getElementById('local-webcam');
const captureCanvas = document.getElementById('capture-canvas');
const captureCtx = captureCanvas ? captureCanvas.getContext('2d') : null;
const streamImg = document.getElementById('video-stream');
let streamInterval = null;

if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
  navigator.mediaDevices.getUserMedia({ video: true })
    .then(stream => {
      videoElement.srcObject = stream;
      addConsole('Local camera access granted', 'info');
      document.getElementById('st-camera').textContent = 'CLIENT CAM';
      
      videoElement.onloadedmetadata = () => {
        videoElement.play().catch(e => console.error('Play error:', e));
        
        if (streamInterval) clearInterval(streamInterval);
        streamInterval = setInterval(() => {
          if (videoElement.readyState >= 2) {
            if (captureCanvas.width !== videoElement.videoWidth && videoElement.videoWidth > 0) {
              captureCanvas.width = videoElement.videoWidth;
              captureCanvas.height = videoElement.videoHeight;
            }
            if (captureCanvas.width > 0) {
              captureCtx.drawImage(videoElement, 0, 0, captureCanvas.width, captureCanvas.height);
              const frameData = captureCanvas.toDataURL('image/jpeg', 0.6);
              socket.emit('client_frame', { image: frameData });
            }
          }
        }, 50);
      };
    })
    .catch(err => {
      addConsole('Camera access denied or unavailable: ' + err.message, 'error');
      document.getElementById('st-camera').textContent = 'CAM ERROR';
      streamImg.src = '/static/img/offline.png';
    });
} else {
  addConsole('Browser does not support getUserMedia API', 'error');
}

// Receive processed frame back from server pipeline
socket.on('processed_frame', (data) => {
  if (streamImg && data.image) {
    streamImg.src = data.image;
  }
});
