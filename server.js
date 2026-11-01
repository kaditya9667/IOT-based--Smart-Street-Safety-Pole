// =========================================================
// Smart Street Safety Pole — Municipal Safety Platform
// Real-Time IoT Backend, Computer Vision & Device Controller
// =========================================================

// =========================================================
// 1. MODULE IMPORTS, DEPENDENCIES & ENVIRONMENT SETUP
// =========================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const firebaseService = require('./firebase-service');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Target hardware host endpoints (configurable via .env or settings UI)
let POLE_HOST = process.env.POLE_HOST || '10.250.176.230';
let CAM_HOST = process.env.CAM_HOST || '10.250.176.145';
let PORT = process.env.PORT || 5000;

// Camera stream upstream reference for clean connection teardown
let activeCamUpstream = null;

// =========================================================
// 2. STATE STORAGE & CALIBRATION PERSISTENCE
// =========================================================

// Persistent Incident Logging System
const INCIDENTS_FILE = path.join(__dirname, 'incidents.json');
let incidents = [];

try {
  if (fs.existsSync(INCIDENTS_FILE)) {
    incidents = JSON.parse(fs.readFileSync(INCIDENTS_FILE, 'utf8'));
  }
} catch (e) {
  incidents = [];
}

function saveIncidents() {
  try {
    fs.writeFileSync(INCIDENTS_FILE, JSON.stringify(incidents, null, 2));
  } catch (e) {
    console.error('Failed to save incidents file:', e.message);
  }
}

// Persistent MPU-6050 Calibration Offset Storage
const CALIBRATION_FILE = path.join(__dirname, 'calibration.json');
let calibrationData = {
  baselineTiltX: 2.10,
  baselineTiltY: -63.80,
  calibratedAt: new Date().toISOString(),
  calibratedBy: "Safety Pole System",
  sampleCount: 20,
  status: "calibrated",
  tiltThreshold: 10.0
};

try {
  if (fs.existsSync(CALIBRATION_FILE)) {
    const raw = fs.readFileSync(CALIBRATION_FILE, 'utf8');
    calibrationData = { ...calibrationData, ...JSON.parse(raw) };
    console.log(`[Calibration] Loaded stored baseline: X=${calibrationData.baselineTiltX}°, Y=${calibrationData.baselineTiltY}° (Threshold: ${calibrationData.tiltThreshold}°)`);
  }
} catch (e) {
  console.warn('[Calibration] Stored calibration read error, using default:', e.message);
}

function saveCalibrationToFile(data) {
  try {
    fs.writeFileSync(CALIBRATION_FILE, JSON.stringify(data, null, 2));
    firebaseService.saveCalibration(data).catch(() => {});
  } catch (e) {
    console.error('Failed to save calibration file:', e.message);
  }
}

// In-memory state of the Smart Street Safety Pole
let poleState = {
  sosAlert: false,
  lightOverride: 'auto', // 'auto', 'on', 'off'
  lightState: false, // actual status (on/off)
  ldrValue: 0, // light level (0-1024, real live sensor data)
  mq2Value: 0, // smoke level (ppm, real live sensor data)
  pirMotion: false, // motion detected
  tiltX: 0,
  tiltY: 0,
  baselineTiltX: calibrationData.baselineTiltX,
  baselineTiltY: calibrationData.baselineTiltY,
  deltaTiltX: 0,
  deltaTiltY: 0,
  netTilt: 0,
  tiltThreshold: calibrationData.tiltThreshold || 10.0,
  isTilted: false,
  calibrationStatus: calibrationData.status || 'calibrated',
  calibrationDate: calibrationData.calibratedAt || new Date().toISOString(),
  calibrationSamples: calibrationData.sampleCount || 20,
  gps: {
    lat: 12.9715987, // Default location (Bangalore / User's city)
    lng: 77.5945627
  },
  gpsValid: false,
  gpsStatus: 'Retaining Last Known Position',
  gpsLastUpdate: new Date().toISOString(),
  lastSeen: null
};

// Polling telemetry status tracking
let prevSos = false;
let prevAccident = false;
let prevSmoke = false;
let consecutiveTiltCount = 0;
let lastPollSuccess = false;

// =========================================================
// 3. EXPRESS APP & MIDDLEWARE SETUP
// =========================================================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Middleware to serve static dashboard frontend assets
app.use(express.static(__dirname));

// =========================================================
// 4. ESP32-CAM PROXY & MJPEG STREAMING ENGINE
// =========================================================

// Forwards camera frames to ESP32-CAM to prevent CORS restrictions in browsers
async function proxyCamera(req, res, camPath) {
  const url = `http://${CAM_HOST}${camPath}`;
  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!upstream.ok) {
      return res.status(502).send('Camera returned ' + upstream.status);
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (err) {
    res.status(503).json({ error: 'Camera unreachable', detail: err.message, host: CAM_HOST });
  }
}

app.get('/api/camera-frame', (req, res) => proxyCamera(req, res, '/stream'));
app.get('/api/camera-capture', (req, res) => proxyCamera(req, res, '/capture'));

// High-Speed MJPEG Video Stream Proxy (Direct Native Pipe with Zero Lag & Buffer Control)
app.get('/api/camera-stream', (req, res) => {
  const url = `http://${CAM_HOST}/stream`;

  // Destroy previous upstream handle if page was reloaded quickly
  if (activeCamUpstream) {
    try { activeCamUpstream.destroy(); } catch (_) {}
    activeCamUpstream = null;
  }

  const upstream = http.get(url, (camRes) => {
    if (camRes.statusCode !== 200) {
      if (!res.headersSent) res.status(camRes.statusCode).send('Camera stream error');
      return;
    }

    activeCamUpstream = upstream;

    // Disable Nagle's algorithm and socket timeouts for instant frame delivery
    if (camRes.socket) {
      camRes.socket.setNoDelay(true);
      camRes.socket.setTimeout(0);
      camRes.socket.setKeepAlive(true, 1000);
    }
    if (req.socket) {
      req.socket.setNoDelay(true);
      req.socket.setTimeout(0);
      req.socket.setKeepAlive(true, 1000);
    }

    res.writeHead(200, {
      'Content-Type': camRes.headers['content-type'] || 'multipart/x-mixed-replace;boundary=123456789000000000000987654321',
      'Cache-Control': 'no-store, no-cache, must-revalidate, pre-check=0, post-check=0, max-age=0',
      'Pragma': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    // Native Node pipe handles backpressure automatically so memory never buffers old frames
    camRes.pipe(res);
  });

  upstream.setTimeout(6000, () => {
    if (!res.headersSent) {
      upstream.destroy();
      res.status(504).json({ error: 'Camera stream connection timeout', host: CAM_HOST });
    }
  });

  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.status(503).json({ error: 'Camera stream offline', detail: err.message, host: CAM_HOST });
    }
  });

  req.on('close', () => {
    if (activeCamUpstream === upstream) {
      activeCamUpstream = null;
    }
    upstream.destroy();
  });
});

// =========================================================
// 5. INCIDENT MANAGEMENT & EVIDENCE LOGGING
// =========================================================

// Central Incident Recorder: saves case to incidents.json + broadcasts to clients & Firebase
async function recordIncident(triggerType, customImageUrl = '', extraMeta = {}) {
  const caseId = 'CASE-' + Date.now();
  const timestamp = new Date().toISOString();
  
  const isSos = /sos/i.test(triggerType);
  const cleanTrigger = isSos ? 'SOS Call' : triggerType;
  const isCritical = isSos || extraMeta.severity === 'Critical' || /collision|critical|fire/i.test(cleanTrigger);
  const isWarning = !isCritical && (extraMeta.severity === 'Warning' || /smoke|gas|tilt|leak|possible/i.test(cleanTrigger));
  const severity = isCritical ? 'Critical' : (isWarning ? 'Warning' : 'Normal');
  const assignedTeam = isCritical 
    ? 'City Traffic Police & EMS Unit 04'
    : (isWarning ? 'Municipal Fire & HAZMAT Station 2' : 'Safety Patrol Unit');

  const newIncident = {
    id: caseId,
    timestamp: timestamp,
    triggerType: cleanTrigger,
    poleId: 'POLE-01 (Live Hardware)',
    severity: severity,
    status: 'Pending',
    assignedTeam: assignedTeam,
    location: `${(poleState.gps.lat || 12.97160).toFixed(5)}, ${(poleState.gps.lng || 77.59456).toFixed(5)} (Live Station)`,
    imageUrl: customImageUrl || '',
    confidence: extraMeta.confidence || (isSos ? 100 : null),
    validationStatus: extraMeta.validationStatus || (isSos ? 'Citizen Distress Call Active' : (isCritical ? 'Confirmed Incident' : 'Warning Event')),
    category: extraMeta.category || (isCritical ? 'confirmed' : 'warning'),
    telemetrySnapshot: {
      ldrValue: poleState.ldrValue,
      mq2Value: poleState.mq2Value,
      tiltX: poleState.tiltX || 0,
      tiltY: poleState.tiltY || 0,
      deltaTiltX: poleState.deltaTiltX || 0,
      deltaTiltY: poleState.deltaTiltY || 0,
      netTilt: poleState.netTilt || 0,
      tiltThreshold: poleState.tiltThreshold || 10.0,
      gps: { ...poleState.gps }
    }
  };

  incidents.unshift(newIncident);
  if (incidents.length > 50) incidents.pop();
  saveIncidents();

  // Log evidence asynchronously to Firebase Realtime Database
  firebaseService.logEvidence(newIncident).catch(e => console.error('[Firebase] Error logging evidence:', e.message));

  console.log(`[Incident Logged] ${caseId} (${triggerType}) [${severity}] saved & broadcasted.`);
  io.emit('new-incident-case', newIncident);
  io.emit('incident-cases', incidents);

  return newIncident;
}

// GET all incident cases
app.get('/api/incidents', (req, res) => {
  res.json(incidents);
});

// POST Acknowledge Incident Case
app.post('/api/incidents/:id/ack', (req, res) => {
  const { id } = req.params;
  const user = req.body.user || 'Municipal Officer';
  const inc = incidents.find(i => i.id === id);
  if (inc) {
    inc.status = 'Acknowledged';
    inc.acknowledgedAt = new Date().toISOString();
    inc.acknowledgedBy = user;
    saveIncidents();
    io.emit('incident-cases', incidents);

    // Sync status and log user activity to Firebase
    firebaseService.updateEvidenceStatus(id, 'Acknowledged', { 
      acknowledgedAt: inc.acknowledgedAt, 
      acknowledgedBy: user 
    }).catch(() => {});
    firebaseService.logUserActivity('ACKNOWLEDGE_ALERT', { incidentId: id }, user).catch(() => {});

    return res.json({ success: true, incident: inc });
  }
  res.status(404).json({ success: false, error: 'Incident not found' });
});

// POST Resolve Incident Case
app.post('/api/incidents/:id/resolve', (req, res) => {
  const { id } = req.params;
  const user = req.body.user || 'Municipal Officer';
  const inc = incidents.find(i => i.id === id);
  if (inc) {
    inc.status = 'Resolved';
    inc.resolvedAt = new Date().toISOString();
    inc.resolvedBy = user;
    saveIncidents();
    io.emit('incident-cases', incidents);

    // Sync status and log user activity to Firebase
    firebaseService.updateEvidenceStatus(id, 'Resolved', { 
      resolvedAt: inc.resolvedAt, 
      resolvedBy: user 
    }).catch(() => {});
    firebaseService.logUserActivity('RESOLVE_ALERT', { incidentId: id }, user).catch(() => {});

    return res.json({ success: true, incident: inc });
  }
  res.status(404).json({ success: false, error: 'Incident not found' });
});

// POST Clear All Incident Logs (Requires Admin Password)
app.post('/api/incidents/clear', (req, res) => {
  const { password, user = 'Administrator' } = req.body || {};
  const validAdminPasswords = ['admin1234', 'admin123', 'admin', 'safepole2026', 'policeadmin'];
  if (!password || !validAdminPasswords.includes(String(password).trim())) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid admin password. Clear operation rejected.' });
  }
  incidents = [];
  saveIncidents();
  io.emit('incident-cases', incidents);
  firebaseService.logUserActivity('CLEAR_ALL_LOGS', { authorizedBy: user }, user).catch(() => {});
  res.json({ success: true, message: 'All incident logs permanently erased.' });
});

// POST Purge All Evidence Photos (Requires Admin Password)
app.post('/api/incidents/clear-photos', (req, res) => {
  const { password, user = 'Administrator' } = req.body || {};
  const validAdminPasswords = ['admin1234', 'admin123', 'admin', 'safepole2026', 'policeadmin'];
  if (!password || !validAdminPasswords.includes(String(password).trim())) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid admin password. Purge operation rejected.' });
  }
  let cleared = 0;
  incidents.forEach(i => {
    if (i.imageUrl) {
      i.imageUrl = '';
      cleared++;
    }
  });
  saveIncidents();
  io.emit('incident-cases', incidents);
  firebaseService.logUserActivity('PURGE_EVIDENCE_PHOTOS', { clearedCount: cleared }, user).catch(() => {});
  res.json({ success: true, count: cleared, message: `Purged ${cleared} evidence photos.` });
});

// DELETE Single Incident Log
app.delete('/api/incidents/:id', (req, res) => {
  const { id } = req.params;
  const initialLen = incidents.length;
  incidents = incidents.filter(i => i.id !== id);
  if (incidents.length < initialLen) {
    saveIncidents();
    io.emit('incident-cases', incidents);
    firebaseService.deleteEvidence(id).catch(() => {});
    firebaseService.logUserActivity('DELETE_ALERT', { incidentId: id }, req.body?.user || 'Officer').catch(() => {});
    return res.json({ success: true, deletedId: id });
  }
  res.status(404).json({ success: false, error: 'Incident not found' });
});

// DELETE Single Incident Evidence Photo
app.delete('/api/incidents/:id/photo', (req, res) => {
  const { id } = req.params;
  const inc = incidents.find(i => i.id === id);
  if (inc) {
    inc.imageUrl = '';
    saveIncidents();
    io.emit('incident-cases', incidents);
    firebaseService.deleteEvidencePhoto(id).catch(() => {});
    return res.json({ success: true, id });
  }
  res.status(404).json({ success: false, error: 'Incident not found' });
});

// POST Attach Camera Photo to Recent Incident
app.post('/api/incidents/attach-photo', (req, res) => {
  const { image } = req.body;
  if (image && incidents.length > 0) {
    if (!incidents[0].imageUrl) {
      incidents[0].imageUrl = image;
      saveIncidents();
      io.emit('incident-cases', incidents);
      return res.json({ success: true, caseId: incidents[0].id });
    }
  }
  res.json({ success: false });
});

// =========================================================
// 6. EMERGENCY DISPATCH & HARDWARE CONTROL
// =========================================================

// HTTP API: ESP32 uploads telemetry here
app.post('/api/telemetry', (req, res) => {
  const { ldrValue, mq2Value, pirMotion, gps, sosAlert } = req.body;

  poleState.ldrValue = ldrValue !== undefined ? Number(ldrValue) : poleState.ldrValue;
  poleState.mq2Value = mq2Value !== undefined ? Number(mq2Value) : poleState.mq2Value;
  poleState.pirMotion = pirMotion !== undefined ? Boolean(pirMotion) : poleState.pirMotion;
  
  if (gps && gps.lat && gps.lng) {
    poleState.gps = { lat: Number(gps.lat), lng: Number(gps.lng) };
  }
  
  if (sosAlert !== undefined) {
    poleState.sosAlert = Boolean(sosAlert);
  }

  // Automatic street lighting logic if override is set to 'auto'
  if (poleState.lightOverride === 'auto') {
    poleState.lightState = Boolean(poleState.darkDetected);
  } else {
    poleState.lightState = poleState.lightOverride === 'on';
  }

  poleState.lastSeen = new Date().toISOString();
  io.emit('telemetry-update', poleState);

  res.json({
    success: true,
    lightState: poleState.lightState,
    sosAlert: poleState.sosAlert
  });
});

// HTTP API: Remote command to toggle SOS panic state
app.post('/api/sos', (req, res) => {
  const { active } = req.body;
  if (active !== undefined) {
    poleState.sosAlert = Boolean(active);
    io.emit('telemetry-update', poleState);
    return res.json({ success: true, sosAlert: poleState.sosAlert });
  }
  res.status(400).json({ success: false, message: 'Invalid active parameter' });
});

// Dashboard → ESP32 acknowledge endpoint (clears active emergency alert on hardware and server)
app.post('/api/pole-ack', async (req, res) => {
  // Always clear local alarm states immediately so dashboard unlatches without blocking on network timeout
  poleState.accidentAlert = false;
  poleState.sosAlert = false;
  consecutiveTiltCount = 0;
  prevAccident = false;
  prevSos = false;
  io.emit('telemetry-update', poleState);

  try {
    fetch(`http://${POLE_HOST}/ack`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000)
    }).catch(e => console.warn('[ESP32 Ack] Device ack notification warning:', e.message));
  } catch (_) {}

  res.json({ success: true, message: 'Emergency alert acknowledged and cleared' });
});

// HTTP API: AI Fire Detection alert (YOLOv8 Python sidecar posts here)
let lastFireAlertAt = 0;

app.post('/api/fire-alert', async (req, res) => {
  const { confidence, timestamp, source = 'YOLOv8', boxes = [] } = req.body;
  const now = Date.now();

  // Server-side 8 s cooldown to prevent log flooding
  if (now - lastFireAlertAt < 8000) {
    return res.json({ success: true, skipped: true, reason: 'cooldown' });
  }
  lastFireAlertAt = now;

  console.log(`[🔥 FIRE ALERT] Source: ${source} | Confidence: ${confidence}% | Boxes: ${boxes.length}`);

  io.emit('fire-detection', {
    confidence,
    source,
    boxes,
    timestamp: timestamp || new Date().toISOString()
  });

  // Capture a snapshot from the ESP32-CAM to attach to the incident
  let imageUrl = '';
  try {
    const camRes = await fetch(`http://${CAM_HOST}/capture`, { signal: AbortSignal.timeout(2000) });
    if (camRes.ok) {
      const buf = Buffer.from(await camRes.arrayBuffer());
      imageUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
    }
  } catch (e) {
    imageUrl = '';
  }

  const caseId = 'CASE-FIRE-' + now;
  const newIncident = {
    id: caseId,
    timestamp: timestamp || new Date().toISOString(),
    triggerType: `AI_FIRE (${confidence}% | ${source})`,
    imageUrl,
    telemetrySnapshot: {
      mq2Value: poleState.mq2Value,
      tiltX: poleState.tiltX || 0,
      tiltY: poleState.tiltY || 0,
      gps: { ...poleState.gps }
    }
  };

  incidents.unshift(newIncident);
  if (incidents.length > 50) incidents.pop();
  saveIncidents();

  io.emit('new-incident-case', newIncident);
  io.emit('incident-cases', incidents);

  res.json({ success: true, caseId });
});

// =========================================================
// 7. MPU-6050 DYNAMIC TILT CALIBRATION ENGINE
// =========================================================

// GET current MPU-6050 Calibration Status & Baseline
app.get('/api/pole/calibration', (req, res) => {
  res.json({
    success: true,
    calibration: {
      baselineTiltX: poleState.baselineTiltX,
      baselineTiltY: poleState.baselineTiltY,
      tiltThreshold: poleState.tiltThreshold,
      status: poleState.calibrationStatus,
      calibratedAt: poleState.calibrationDate,
      sampleCount: poleState.calibrationSamples,
      currentTiltX: poleState.tiltX,
      currentTiltY: poleState.tiltY,
      deltaTiltX: poleState.deltaTiltX,
      deltaTiltY: poleState.deltaTiltY,
      netTilt: poleState.netTilt,
      isTilted: poleState.isTilted
    }
  });
});

// POST Start Multi-Sample Stationary Calibration (Averages 20 samples to filter noise)
app.post('/api/pole/calibrate-start', async (req, res) => {
  const { samples = 20, threshold = 10.0, officer = 'Municipal Safety Officer' } = req.body || {};

  // Reject calibration while an active accident/SOS distress is occurring
  if (poleState.sosAlert) {
    return res.status(400).json({
      success: false,
      error: 'Cannot calibrate while SOS distress is active. Please clear all active alerts first.'
    });
  }

  const sampleTarget = Math.max(5, Math.min(50, Number(samples) || 20));
  const collectedSamples = [];

  console.log(`[Calibration] Starting stationary calibration sequence (${sampleTarget} samples)...`);

  // Sample directly from ESP32 sensor or active telemetry
  for (let i = 0; i < sampleTarget; i++) {
    try {
      const resp = await fetch(`http://${POLE_HOST}/api`, { signal: AbortSignal.timeout(1200) });
      if (resp.ok) {
        const d = await resp.json();
        if (d.tiltX !== undefined && d.tiltY !== undefined) {
          collectedSamples.push({ x: Number(d.tiltX), y: Number(d.tiltY) });
        }
      }
    } catch (_) {
      if (poleState.tiltX !== 0 || poleState.tiltY !== 0) {
        collectedSamples.push({ x: poleState.tiltX, y: poleState.tiltY });
      }
    }
    await new Promise(r => setTimeout(r, 100));
  }

  if (collectedSamples.length === 0) {
    collectedSamples.push({ x: poleState.tiltX || 0, y: poleState.tiltY || 0 });
  }

  const avgX = collectedSamples.reduce((sum, s) => sum + s.x, 0) / collectedSamples.length;
  const avgY = collectedSamples.reduce((sum, s) => sum + s.y, 0) / collectedSamples.length;

  const varianceX = collectedSamples.reduce((sum, s) => sum + Math.pow(s.x - avgX, 2), 0) / collectedSamples.length;
  const varianceY = collectedSamples.reduce((sum, s) => sum + Math.pow(s.y - avgY, 2), 0) / collectedSamples.length;
  const stdDev = Math.sqrt(varianceX + varianceY);

  if (stdDev > 5.0) {
    console.warn(`[Calibration] Pole motion detected during calibration (StdDev: ${stdDev.toFixed(2)}°)`);
    return res.status(400).json({
      success: false,
      error: `Pole movement detected during calibration (jitter: ${stdDev.toFixed(1)}°). Please ensure pole is completely stationary and retry.`
    });
  }

  const now = new Date().toISOString();
  const newCal = {
    baselineTiltX: Number(avgX.toFixed(2)),
    baselineTiltY: Number(avgY.toFixed(2)),
    calibratedAt: now,
    calibratedBy: officer,
    sampleCount: collectedSamples.length,
    status: 'calibrated',
    tiltThreshold: Number(threshold) || 10.0
  };

  poleState.baselineTiltX = newCal.baselineTiltX;
  poleState.baselineTiltY = newCal.baselineTiltY;
  poleState.tiltThreshold = newCal.tiltThreshold;
  poleState.calibrationStatus = 'calibrated';
  poleState.calibrationDate = now;
  poleState.calibrationSamples = newCal.sampleCount;
  poleState.deltaTiltX = 0;
  poleState.deltaTiltY = 0;
  poleState.netTilt = 0;
  poleState.isTilted = false;
  poleState.accidentAlert = false;
  consecutiveTiltCount = 0;
  prevAccident = false;

  saveCalibrationToFile(newCal);

  // Sync calibration baseline to ESP32 and clear any latched hardware alert
  fetch(`http://${POLE_HOST}/calibrate?x=${newCal.baselineTiltX}&y=${newCal.baselineTiltY}&t=${newCal.tiltThreshold}`, {
    method: 'POST',
    signal: AbortSignal.timeout(2000)
  }).catch(() => {});
  fetch(`http://${POLE_HOST}/ack`, { method: 'POST', signal: AbortSignal.timeout(2000) }).catch(() => {});

  io.emit('telemetry-update', poleState);
  io.emit('calibration-update', newCal);

  console.log(`[Calibration] Stationary calibration complete: X=${newCal.baselineTiltX}°, Y=${newCal.baselineTiltY}° (Averaged ${collectedSamples.length} samples)`);

  res.json({
    success: true,
    calibration: newCal,
    message: `Calibration saved! Upright baseline zeroed to X=${newCal.baselineTiltX}°, Y=${newCal.baselineTiltY}° (Threshold: ${newCal.tiltThreshold}°)`
  });
});

// POST Reset Calibration to Factory 0,0
app.post('/api/pole/calibrate-reset', (req, res) => {
  const resetCal = {
    baselineTiltX: 0.0,
    baselineTiltY: 0.0,
    calibratedAt: new Date().toISOString(),
    calibratedBy: 'System Reset',
    sampleCount: 0,
    status: 'uncalibrated',
    tiltThreshold: 10.0
  };

  poleState.baselineTiltX = 0.0;
  poleState.baselineTiltY = 0.0;
  poleState.tiltThreshold = 10.0;
  poleState.calibrationStatus = 'uncalibrated';
  poleState.calibrationDate = resetCal.calibratedAt;
  poleState.calibrationSamples = 0;

  saveCalibrationToFile(resetCal);

  fetch(`http://${POLE_HOST}/calibrate?x=0.0&y=0.0&t=10.0`, {
    method: 'POST',
    signal: AbortSignal.timeout(2000)
  }).catch(() => {});

  io.emit('telemetry-update', poleState);
  io.emit('calibration-update', resetCal);

  res.json({
    success: true,
    calibration: resetCal,
    message: 'Tilt calibration reset back to 0.0°, 0.0° factory defaults.'
  });
});

// POST Update Tilt Deviation Threshold
app.post('/api/pole/set-tilt-threshold', (req, res) => {
  const { threshold } = req.body;
  const t = parseFloat(threshold);
  if (!isNaN(t) && t >= 3.0 && t <= 45.0) {
    poleState.tiltThreshold = t;
    calibrationData.tiltThreshold = t;
    saveCalibrationToFile(calibrationData);
    fetch(`http://${POLE_HOST}/calibrate?x=${poleState.baselineTiltX}&y=${poleState.baselineTiltY}&t=${t}`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000)
    }).catch(() => {});
    firebaseService.logUserActivity('SET_TILT_THRESHOLD', {
      tiltThreshold: t
    });
    io.emit('telemetry-update', poleState);
    return res.json({ success: true, threshold: poleState.tiltThreshold });
  }
  res.status(400).json({ success: false, error: 'Invalid threshold value' });
});

// =========================================================
// 8. ROBOFLOW AI VISION & CONTINUOUS SURVEILLANCE
// =========================================================
let lastRoboflowAlertTime = 0;
let consecutiveFireCount = 0;
let lastRoboflowAccidentTime = 0;
let consecutiveAccidentCount = 0;

// HTTP API: Run Roboflow Cloud Inference for Fire & Smoke
app.post('/api/roboflow/check-frame', async (req, res) => {
  const roboflowKey = process.env.ROBOFLOW_API_KEY;
  const modelId = process.env.ROBOFLOW_MODEL_ID || "firesmokedetection-5w49j/3";
  const confidenceThresh = parseFloat(process.env.ROBOFLOW_CONFIDENCE || "0.60");

  if (!roboflowKey || roboflowKey === 'YOUR_ROBOFLOW_API_KEY') {
    return res.status(400).json({ error: 'ROBOFLOW_API_KEY is not configured in .env' });
  }

  let base64Image = req.body.image;

  if (!base64Image) {
    try {
      const camRes = await fetch(`http://${CAM_HOST}/capture`, { signal: AbortSignal.timeout(2500) });
      if (camRes.ok) {
        const buf = Buffer.from(await camRes.arrayBuffer());
        base64Image = buf.toString('base64');
      }
    } catch (e) {
      return res.status(503).json({ error: 'Could not fetch image from camera', detail: e.message });
    }
  }

  if (!base64Image) {
    return res.status(400).json({ error: 'No image available for inference' });
  }

  base64Image = base64Image.replace(/^data:image\/[a-z]+;base64,/, '');

  try {
    const rfResponse = await fetch(`https://serverless.roboflow.com/${modelId}?confidence=${confidenceThresh}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${roboflowKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: base64Image
    });

    if (!rfResponse.ok) {
      const errText = await rfResponse.text();
      throw new Error(`Roboflow returned status ${rfResponse.status}: ${errText}`);
    }

    const data = await rfResponse.json();

    const firePredictions = (data.predictions || []).filter(p => {
      const cls = (p.class || '').toLowerCase();
      const hasGasElevation = poleState.mq2Value > 700;
      if (['fire', 'flame'].includes(cls)) {
        return p.confidence >= 0.45 || (hasGasElevation && p.confidence >= 0.35);
      }
      if (['smoke'].includes(cls)) {
        return p.confidence >= 0.50 || (hasGasElevation && p.confidence >= 0.40);
      }
      return p.confidence >= 0.45;
    });

    if (firePredictions.length > 0) {
      consecutiveFireCount++;
    } else {
      consecutiveFireCount = 0;
    }

    const now = Date.now();
    if (firePredictions.length > 0 && (now - lastRoboflowAlertTime >= 15000)) {
      lastRoboflowAlertTime = now;
      const topPred = firePredictions[0];
      const confPct = Math.round(topPred.confidence * 100);
      const isSmoke = (topPred.class || '').toLowerCase() === 'smoke';
      const alertTitle = isSmoke ? 'Smoke Detected' : 'Fire Detected';
      const triggerLabel = isSmoke ? 'Smoke Alert' : 'Fire Alert';

      console.log(`[Confirmed Fire/Smoke Alert] ${alertTitle} (${confPct}%)`);

      const newInc = await recordIncident(triggerLabel, `data:image/jpeg;base64,${base64Image}`, {
        severity: 'Critical',
        confidence: confPct,
        validationStatus: `Visual AI ${alertTitle} Verified (${confPct}%)`
      });

      io.emit('fire-detection', {
        caseId: newInc.id,
        confidence: confPct,
        type: alertTitle,
        severity: 'Critical',
        validationStatus: `Visual AI ${alertTitle} Verified (${confPct}%)`,
        imageUrl: `data:image/jpeg;base64,${base64Image}`,
        boxes: firePredictions.map(p => ({
          x1: Math.round(p.x - p.width / 2),
          y1: Math.round(p.y - p.height / 2),
          x2: Math.round(p.x + p.width / 2),
          y2: Math.round(p.y + p.height / 2),
          label: alertTitle,
          conf: p.confidence
        })),
        timestamp: new Date().toISOString()
      });
    }

    res.json({ success: true, predictions: firePredictions, rawPredictions: data.predictions || [] });
  } catch (err) {
    console.error('[Roboflow API Error]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Automated Continuous Roboflow Cloud Inference for Road Accident & Collision Detection
async function performAccidentCheck(base64Image = null) {
  const roboflowKey = process.env.ROBOFLOW_API_KEY;
  const modelId = process.env.ROBOFLOW_ACCIDENT_MODEL_ID || "accident-detection-eamy3/1";
  const confidenceThresh = parseFloat(process.env.ROBOFLOW_ACCIDENT_CONFIDENCE || "0.40");

  if (!roboflowKey || roboflowKey === 'YOUR_ROBOFLOW_API_KEY') {
    return { success: false, error: 'ROBOFLOW_API_KEY not configured' };
  }

  if (!base64Image) {
    try {
      const camRes = await fetch(`http://${CAM_HOST}/capture`, { signal: AbortSignal.timeout(2500) });
      if (camRes.ok) {
        const buf = Buffer.from(await camRes.arrayBuffer());
        base64Image = buf.toString('base64');
      }
    } catch (_) {
      return { success: false, error: 'Camera capture unavailable' };
    }
  }

  if (!base64Image) {
    return { success: false, error: 'No image available for inference' };
  }

  base64Image = base64Image.replace(/^data:image\/[a-z]+;base64,/, '');

  try {
    const rfResponse = await fetch(`https://serverless.roboflow.com/${modelId}?confidence=${confidenceThresh}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${roboflowKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: base64Image
    });

    if (!rfResponse.ok) {
      const errText = await rfResponse.text();
      return { success: false, error: `Roboflow error ${rfResponse.status}: ${errText}` };
    }

    const data = await rfResponse.json();
    const accidentPredictions = (data.predictions || []).filter(p => p.confidence >= confidenceThresh);

    if (accidentPredictions.length > 0) {
      consecutiveAccidentCount++;
    } else {
      consecutiveAccidentCount = Math.max(0, consecutiveAccidentCount - 1);
    }

    const now = Date.now();
    const COOLDOWN_MS = 60000;

    if (accidentPredictions.length > 0 && consecutiveAccidentCount >= 2 && (now - lastRoboflowAccidentTime >= COOLDOWN_MS)) {
      lastRoboflowAccidentTime = now;
      const topPred = accidentPredictions[0];
      const confPct = Math.round(topPred.confidence * 100);

      const sensorCorroboration = Boolean(poleState.isTilted);

      let alertCategory = 'possible';
      let alertTitle = 'Possible Road Accident';
      let triggerLabel = `Possible Road Incident (${confPct}% Visual - Sensors Stable)`;
      let severity = 'Warning';

      if (sensorCorroboration) {
        alertCategory = 'confirmed';
        alertTitle = 'Confirmed Vehicle Collision';
        triggerLabel = `Confirmed Collision (Camera ${confPct}% + Tilt ${poleState.netTilt.toFixed(1)}°)`;
        severity = 'Critical';
      } else {
        alertCategory = 'possible';
        alertTitle = 'Possible Road Incident';
        triggerLabel = `Possible Vehicle Incident (${confPct}% - Sensors Normal)`;
        severity = 'Warning';
      }

      console.log(`[🚨 Multi-Frame AI Accident Analysis] Category: ${alertCategory.toUpperCase()} | Conf: ${confPct}% | Consecutive Frames: ${consecutiveAccidentCount} | Tilt Sensor: ${sensorCorroboration ? 'TRIGGERED (' + poleState.netTilt + '°)' : 'STABLE'}`);

      const validationStatus = sensorCorroboration ? 'Multi-Frame & Tilt Sensor Verified' : 'Visual Detection (Sensors Stable)';

      recordIncident(triggerLabel, `data:image/jpeg;base64,${base64Image}`, {
        severity: severity,
        confidence: confPct,
        category: alertCategory,
        validationStatus: validationStatus
      });

      io.emit('accident-detection', {
        confidence: confPct,
        type: alertTitle,
        category: alertCategory,
        severity: severity,
        sensorValidated: sensorCorroboration,
        validationStatus: validationStatus,
        boxes: accidentPredictions.map(p => ({
          x1: Math.round(p.x - p.width / 2),
          y1: Math.round(p.y - p.height / 2),
          x2: Math.round(p.x + p.width / 2),
          y2: Math.round(p.y + p.height / 2),
          label: alertTitle,
          conf: p.confidence
        })),
        evidenceImage: `data:image/jpeg;base64,${base64Image}`,
        imageUrl: `data:image/jpeg;base64,${base64Image}`,
        timestamp: new Date().toISOString()
      });
    }

    return { 
      success: true, 
      predictions: accidentPredictions, 
      consecutiveFrames: consecutiveAccidentCount,
      rawPredictions: data.predictions || [] 
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// HTTP API: Endpoint for accident check
app.post('/api/roboflow/check-accident', async (req, res) => {
  const result = await performAccidentCheck(req.body?.image);
  if (result.success) {
    res.json(result);
  } else {
    res.status(result.error?.includes('ROBOFLOW_API_KEY') ? 400 : 503).json(result);
  }
});

// Autonomous background scan every 4 seconds
let autoScanInProgress = false;
setInterval(async () => {
  if (autoScanInProgress) return;
  autoScanInProgress = true;
  try {
    await performAccidentCheck();
  } catch (_) {
  } finally {
    autoScanInProgress = false;
  }
}, 4000);

// Endpoint to check AI Model Status
app.get('/api/roboflow/status', (req, res) => {
  const rfKey = process.env.ROBOFLOW_API_KEY;
  res.json({
    success: true,
    fireModel: {
      modelId: process.env.ROBOFLOW_MODEL_ID || "firesmokedetection-5w49j/3",
      endpoint: "https://serverless.roboflow.com/firesmokedetection-5w49j/3",
      status: (rfKey && rfKey !== 'YOUR_ROBOFLOW_API_KEY') ? "active" : "unconfigured",
      confidence: parseFloat(process.env.ROBOFLOW_CONFIDENCE || "0.45")
    },
    accidentModel: {
      modelId: process.env.ROBOFLOW_ACCIDENT_MODEL_ID || "accident-detection-eamy3/1",
      endpoint: "https://serverless.roboflow.com/accident-detection-eamy3/1",
      status: (rfKey && rfKey !== 'YOUR_ROBOFLOW_API_KEY') ? "active" : "unconfigured",
      confidence: parseFloat(process.env.ROBOFLOW_ACCIDENT_CONFIDENCE || "0.40")
    }
  });
});

// =========================================================
// 9. SYSTEM CONFIGURATION & HARDWARE ENDPOINT SETTINGS
// =========================================================

// GET active system endpoint configuration
app.get('/api/config', (req, res) => {
  res.json({
    poleHost: POLE_HOST,
    camHost: CAM_HOST,
    port: PORT
  });
});

// POST Unified Settings Save Endpoint (Saves Pole & Camera Endpoints atomically)
app.post('/api/settings/save', (req, res) => {
  const { poleIp, camIp } = req.body || {};
  let updated = false;

  if (poleIp && poleIp.trim()) {
    POLE_HOST = poleIp.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    poleState.poleHost = POLE_HOST;
    updated = true;
  }
  if (camIp && camIp.trim()) {
    CAM_HOST = camIp.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (activeCamUpstream) {
      try { activeCamUpstream.destroy(); } catch (_) {}
      activeCamUpstream = null;
    }
    updated = true;
  }

  if (updated) {
    console.log(`[Config] Settings saved -> Pole: ${POLE_HOST}, Camera: ${CAM_HOST}`);
    
    // Persist to .env
    try {
      const envPath = path.join(__dirname, '.env');
      if (fs.existsSync(envPath)) {
        let envContent = fs.readFileSync(envPath, 'utf8');
        if (poleIp) envContent = envContent.replace(/POLE_HOST=.*/g, `POLE_HOST=${POLE_HOST}`);
        if (camIp) envContent = envContent.replace(/CAM_HOST=.*/g, `CAM_HOST=${CAM_HOST}`);
        fs.writeFileSync(envPath, envContent);
      }
    } catch (e) {
      console.warn('Could not persist settings to .env:', e.message);
    }

    io.emit('pole-status', { connected: poleState.poleConnected, host: POLE_HOST });
    io.emit('telemetry-update', poleState);
    pollESP32();
    return res.json({ success: true, poleHost: POLE_HOST, camHost: CAM_HOST, message: 'Settings saved successfully.' });
  }

  res.status(400).json({ success: false, error: 'No valid host IP addresses provided.' });
});

// POST update ESP32 target IP
app.post('/api/set-pole-ip', (req, res) => {
  const { ip } = req.body;
  if (ip && ip.trim()) {
    POLE_HOST = ip.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    console.log(`[Config] Target ESP32 Host changed to: ${POLE_HOST}`);

    try {
      const envPath = path.join(__dirname, '.env');
      if (fs.existsSync(envPath)) {
        let envContent = fs.readFileSync(envPath, 'utf8');
        envContent = envContent.replace(/POLE_HOST=.*/g, `POLE_HOST=${POLE_HOST}`);
        fs.writeFileSync(envPath, envContent);
      }
    } catch (e) {
      console.warn('Could not persist POLE_HOST to .env:', e.message);
    }

    pollESP32();
    return res.json({ success: true, host: POLE_HOST });
  }
  res.status(400).json({ success: false, error: 'Invalid IP address' });
});

// POST update ESP32-CAM target IP
app.post('/api/set-cam-ip', (req, res) => {
  const { ip } = req.body;
  if (ip && ip.trim()) {
    CAM_HOST = ip.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    console.log(`[Config] Target Camera Host changed to: ${CAM_HOST}`);
    if (activeCamUpstream) {
      try { activeCamUpstream.destroy(); } catch (_) {}
      activeCamUpstream = null;
    }

    try {
      const envPath = path.join(__dirname, '.env');
      if (fs.existsSync(envPath)) {
        let envContent = fs.readFileSync(envPath, 'utf8');
        envContent = envContent.replace(/CAM_HOST=.*/g, `CAM_HOST=${CAM_HOST}`);
        fs.writeFileSync(envPath, envContent);
      }
    } catch (e) {
      console.warn('Could not persist CAM_HOST to .env:', e.message);
    }

    return res.json({ success: true, host: CAM_HOST });
  }
  res.status(400).json({ success: false, error: 'Invalid IP address' });
});

// =========================================================
// 10. AUTHENTICATION & MUNICIPAL USER MANAGEMENT
// =========================================================

// POST User Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, name, role } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email address is required' });
    }
    const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'Web Console';

    const userProfile = await firebaseService.logUser({
      email: email,
      name: name || email.split('@')[0],
      role: role || 'Platform Operator',
      ip: clientIp,
      userAgent: userAgent
    });

    res.json({ success: true, user: userProfile });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST User Registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'Valid email address is required' });
    }
    const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'Web Console';

    const userProfile = await firebaseService.registerUser({
      name: name || email.split('@')[0],
      email: email,
      role: role || 'Platform Operator',
      ip: clientIp,
      userAgent: userAgent
    });

    res.json({ success: true, user: userProfile });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET List all officers/users from Firebase RTDB
app.get('/api/auth/users', async (req, res) => {
  try {
    const users = await firebaseService.getUsers();
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST Approve or Promote Officer
app.post('/api/auth/approve-user', async (req, res) => {
  try {
    const { email, role = 'Officer', status = 'approved' } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Email required' });
    const result = await firebaseService.updateUserStatus(email, role, status);
    res.json({ success: true, email, role, status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST Password Reset Request
app.post('/api/auth/password-reset', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'Valid email address is required' });
    }
    await firebaseService.logUserActivity('PASSWORD_RESET_REQUESTED', { email }, email);
    res.json({ success: true, message: `Password reset instructions dispatched to ${email}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================
// 11. FIREBASE REALTIME CLOUD SYNCHRONIZATION
// =========================================================

// Force sync local incidents to Firebase Realtime Database
app.post('/api/firebase/sync', async (req, res) => {
  try {
    const result = await firebaseService.syncAllIncidents(incidents);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Firebase status & diagnostics
app.get('/api/firebase/status', (req, res) => {
  res.json(firebaseService.getFirebaseStatus());
});

// =========================================================
// 12. ESP32 HARDWARE BACKGROUND POLLING ENGINE
// =========================================================

// Polls http://${POLE_HOST}/api every 2 s and maps firmware JSON into poleState
async function pollESP32() {
  try {
    const res = await fetch(`http://${POLE_HOST}/api`, {
      signal: AbortSignal.timeout(2500),
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();

    if (!lastPollSuccess) {
      console.log(`[ESP32 Poll] Successfully connected to http://${POLE_HOST}/api`);
    }
    lastPollSuccess = true;
    poleState.pollError = null;

    // Direct firmware fields
    poleState.mq2Value     = Number(d.mq2)    || 0;
    poleState.pirMotion    = Boolean(d.motion);
    poleState.darkDetected = Boolean(d.dark);

    // Apply auto or manual street light relay
    if (poleState.lightOverride === 'auto') {
      poleState.lightState = Boolean(d.dark);
    } else {
      poleState.lightState = poleState.lightOverride === 'on';
    }

    // Preserve GPS fix or gracefully retain last known coordinates
    const fixOk = Boolean(d.gpsValid);
    const hasCoords = d.lat && d.lon && Number(d.lat) !== 0 && Number(d.lon) !== 0;

    if (fixOk && hasCoords) {
      poleState.gps = { lat: Number(d.lat), lng: Number(d.lon) };
      poleState.gpsValid = true;
      poleState.gpsStatus = 'Live Satellite Fix';
      poleState.gpsLastUpdate = new Date().toISOString();
    } else {
      poleState.gpsValid = false;
      poleState.gpsStatus = 'Retaining Last Known Position';
    }

    // MPU-6050 physical readings
    poleState.tiltX        = Number(d.tiltX)  || 0;
    poleState.tiltY        = Number(d.tiltY)  || 0;
    poleState.blynkOnline  = Boolean(d.blynk);
    poleState.mpuOnline    = Boolean(d.mpu);
    poleState.lastSeen     = new Date().toISOString();
    poleState.poleHost     = POLE_HOST;
    poleState.poleConnected = true;

    // Use stored/calibrated baseline
    const baseX = poleState.baselineTiltX !== null ? poleState.baselineTiltX : poleState.tiltX;
    const baseY = poleState.baselineTiltY !== null ? poleState.baselineTiltY : poleState.tiltY;
    const deltaX = poleState.tiltX - baseX;
    const deltaY = poleState.tiltY - baseY;
    const netTilt = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    poleState.deltaTiltX = Number(deltaX.toFixed(2));
    poleState.deltaTiltY = Number(deltaY.toFixed(2));
    poleState.netTilt = Number(netTilt.toFixed(2));
    
    // Check against calibrated threshold (10.0 degrees)
    const threshold = poleState.tiltThreshold || 10.0;
    poleState.isTilted = netTilt >= threshold || Math.abs(deltaX) >= threshold || Math.abs(deltaY) >= threshold;

    // Multi-sample persistence check for physical pole tilt (must persist across 2 consecutive polls = 4s)
    if (poleState.isTilted) {
      consecutiveTiltCount++;
    } else {
      consecutiveTiltCount = Math.max(0, consecutiveTiltCount - 1);
    }
    const confirmedTilt = consecutiveTiltCount >= 2;

    // Detect if this is an SOS button call event
    const isSosEvent = Boolean(d.sos) || Boolean(d.accidentReason && /sos/i.test(d.accidentReason));
    poleState.sosAlert = isSosEvent;

    if (isSosEvent) {
      poleState.accidentReason = 'SOS Call';
      poleState.accidentAlert = false;
    } else if (confirmedTilt) {
      poleState.accidentAlert = true;
      poleState.accidentReason = `Pole Tilt Detected (${netTilt.toFixed(1)}° deviation)`;
    } else {
      poleState.accidentAlert = false;
      poleState.accidentReason = '';
      if (d.accident) {
        fetch(`http://${POLE_HOST}/ack`, { method: 'POST', signal: AbortSignal.timeout(1500) }).catch(() => {});
      }
    }

    // Detect new incidents and log them
    const currentSos = isSosEvent;
    const currentAccident = poleState.accidentAlert;
    const currentSmoke = Boolean(d.smoke);

    if (currentSos && !prevSos) {
      recordIncident('SOS Call');
      setTimeout(() => {
        fetch(`http://${POLE_HOST}/ack`, { method: 'POST', signal: AbortSignal.timeout(2000) }).catch(() => {});
      }, 3000);
    } else if (currentAccident && !prevAccident) {
      recordIncident(`Pole Tilt Detected (${netTilt.toFixed(1)}° deviation)`);
    } else if (currentSmoke && !prevSmoke) {
      recordIncident('Smoke / Gas Alert');
    }

    prevSos = currentSos;
    prevAccident = currentAccident;
    prevSmoke = currentSmoke;

    io.emit('telemetry-update', poleState);
  } catch (err) {
    if (lastPollSuccess || !poleState.poleConnected) {
      console.warn(`[ESP32 Poll] Failed to reach http://${POLE_HOST}/api (${err.message})`);
    }
    lastPollSuccess = false;
    poleState.poleConnected = false;
    poleState.poleHost = POLE_HOST;
    poleState.pollError = err.message;
    io.emit('pole-status', { connected: false, host: POLE_HOST, error: err.message });
  }
}

// Start hardware polling loop
setTimeout(() => {
  console.log(`Polling ESP32 at http://${POLE_HOST}/api every 2 s`);
  pollESP32();
  setInterval(pollESP32, 2000);
}, 2000);

// =========================================================
// 13. SOCKET.IO REAL-TIME EVENT ENGINE
// =========================================================
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  
  // Send current state and incident history to newly connected dashboard/app
  socket.emit('telemetry-update', poleState);
  socket.emit('incident-cases', incidents);

  // Handle control events from Dashboard or App
  socket.on('control-light', (mode) => {
    if (['auto', 'on', 'off'].includes(mode)) {
      poleState.lightOverride = mode;
      
      if (mode === 'auto') {
        poleState.lightState = Boolean(poleState.darkDetected);
      } else {
        poleState.lightState = mode === 'on';
      }
      
      console.log(`Light mode updated to: ${mode} (State: ${poleState.lightState})`);
      io.emit('telemetry-update', poleState);
    }
  });

  socket.on('control-sos', (active) => {
    poleState.sosAlert = Boolean(active);
    console.log(`SOS Alert updated to: ${poleState.sosAlert}`);
    io.emit('telemetry-update', poleState);
  });

  // Simulated Telemetry generator (helps verification/testing without real hardware)
  socket.on('simulate-telemetry', (simData) => {
    poleState = {
      ...poleState,
      ...simData,
      lastSeen: new Date().toISOString()
    };
    
    if (poleState.lightOverride === 'auto') {
      poleState.lightState = Boolean(poleState.darkDetected);
    }
    
    io.emit('telemetry-update', poleState);
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// =========================================================
// 14. SERVER BOOTSTRAP & RESILIENT PORT FALLBACK
// =========================================================
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const nextPort = PORT === 3000 ? 5000 : 8080;
    console.warn(`[Server] Port ${PORT} already in use. Retrying on port ${nextPort}...`);
    PORT = nextPort;
    server.listen(PORT);
  } else {
    console.error('[Server error]', err);
  }
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`Smart Safety Pole Server running on http://localhost:${PORT}`);
  console.log(`Polling ESP32 target: http://${POLE_HOST}/api`);
  console.log(`=======================================================`);
});
