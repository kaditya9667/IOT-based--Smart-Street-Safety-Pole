/**
  * Smart Street Safety Pole — Municipal Safety Platform
 * Client-Side Application Core
 */

(function () {
  'use strict';

  // ========================================================
  // 1. DATA STATE & CONFIGURATION
  // ========================================================
  const state = {
    currentRoute: 'landing',
    activeTab: 'tab-overview',
    sidebarCollapsed: false,
    selectedIncident: null,

    // Live hardware telemetry from ESP32
    hardware: {
      online: false,
      poleHost: '10.250.176.230',
      camHost: '10.250.176.145',
      mq2: 562,
      ldr: 0,
      lightState: false,
      darkDetected: false,
      tiltX: 2.22,
      tiltY: -63.89,
      baselineTiltX: 2.22,
      baselineTiltY: -63.89,
      deltaTiltX: 0.0,
      deltaTiltY: 0.0,
      netTilt: 0.0,
      tiltThreshold: 8.0,
      isTilted: false,
      motion: false,
      sos: false,
      accident: false,
      gps: { lat: 12.971599, lng: 77.594563 },
      lastSeen: null
    },

    // Incidents collection
    incidents: [],
    filterSeverity: 'all',
    searchQuery: '',
    sortField: 'date', // 'date' | 'id'
    sortOrder: 'desc', // 'desc' | 'asc'

    // Maps
    overviewMap: null,
    fullMap: null,
    poleMarkers: {}
  };

  /**
   * Helper to retrieve authenticated user identity
   */
  function getCurrentUser() {
    try {
      const stored = localStorage.getItem('smartpole_user') || sessionStorage.getItem('smartpole_user');
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed.name || parsed.email || 'Safety Operator';
      }
    } catch (_) {}
    return 'Safety Operator';
  }

  let activeEmergencyCaseId = null;
  let lastAccidentState = false;
  let lastSosState = false;

  /**
   * Lightweight in-app toast notification (Zero native browser alerts)
   */
  function showToast(message, type = 'info') {
    let toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'toast-container';
      toastContainer.className = 'fixed bottom-5 right-5 z-50 flex flex-col gap-2 pointer-events-none';
      document.body.appendChild(toastContainer);
    }
    const toast = document.createElement('div');
    const bg = type === 'success'
      ? 'bg-emerald-600 text-white'
      : (type === 'error' ? 'bg-red-600 text-white' : 'bg-slate-900 border border-slate-700 text-slate-100');
    toast.className = `${bg} text-xs font-semibold px-4 py-2.5 rounded-xl shadow-xl pointer-events-auto transition-all duration-300 transform translate-y-2 opacity-0 flex items-center gap-2`;
    toast.innerHTML = `<span>${message}</span>`;
    toastContainer.appendChild(toast);
    requestAnimationFrame(() => {
      toast.classList.remove('translate-y-2', 'opacity-0');
    });
    setTimeout(() => {
      toast.classList.add('translate-y-2', 'opacity-0');
      setTimeout(() => toast.remove(), 350);
    }, 3500);
  }

  /**
   * Old-Type Active Emergency Alert Modal (for Accidents, SOS & Fire)
   */
  function showEmergencyPanel(caseId, type, poleId, lat, lng, timeStr, customImg = '', extra = {}) {
    const panel = document.getElementById('active-emergency-panel');
    if (!panel) return;

    activeEmergencyCaseId = caseId;

    // Clean label without raw AI tags
    let cleanType = type || 'ROAD ACCIDENT DETECTED';
    cleanType = cleanType.replace(/ROBOFLOW|CLOUD|AI_/gi, '').replace(/[()]/g, '').trim();
    if (/sos/i.test(cleanType)) {
      cleanType = 'SOS Call';
    }
    if (!cleanType) cleanType = 'ROAD ACCIDENT DETECTED';

    const t = cleanType.toUpperCase();
    const priority = (extra && extra.severity)
      ? extra.severity.toUpperCase()
      : ((t.includes('SOS') || t.includes('FIRE') || t.includes('CRITICAL')) ? 'CRITICAL' : (t.includes('ACCIDENT') || t.includes('COLLISION') || t.includes('TILT') ? 'HIGH' : 'MEDIUM'));

    const elTitle = document.getElementById('emergency-title');
    const elPriority = document.getElementById('emergency-priority');
    const elType = document.getElementById('emergency-type');
    const elValidation = document.getElementById('emergency-validation');
    const elConfidence = document.getElementById('emergency-confidence');
    const elPole = document.getElementById('emergency-pole');
    const elGps = document.getElementById('emergency-gps');
    const elTime = document.getElementById('emergency-time');
    const elMq2 = document.getElementById('emergency-mq2');
    const elTilt = document.getElementById('emergency-tilt');
    const elLight = document.getElementById('emergency-light');
    const elImg = document.getElementById('emergency-img');
    const elNoImg = document.getElementById('emergency-no-img');

    if (elTitle) elTitle.innerText = priority + ' ALERT';
    if (elPriority) {
      elPriority.innerText = 'Priority: ' + priority;
      elPriority.className = priority === 'CRITICAL'
        ? 'px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-red-600 text-white'
        : 'px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-red-500/20 text-red-400 border border-red-500/40';
    }
    if (elType) elType.innerText = cleanType.toUpperCase();

    // AI Confidence & Multi-frame corroboration badge
    if (elConfidence) {
      const conf = (extra && extra.confidence) ? extra.confidence : (t.includes('SOS') ? 100 : 85);
      elConfidence.innerText = t.includes('SOS') ? 'Emergency: Urgent' : `Confidence: ${conf}%`;
    }
    if (elValidation) {
      const isSos = t.includes('SOS');
      const valStatus = (extra && extra.validationStatus)
        ? extra.validationStatus
        : (isSos ? 'Citizen Distress SOS Triggered' : (t.includes('TILT') ? 'Sensor Tilt Verified' : 'Multi-Frame Corroborated'));
      const dotColor = isSos ? 'bg-red-400' : 'bg-emerald-400';
      elValidation.innerHTML = `<span class="w-1.5 h-1.5 rounded-full ${dotColor}"></span><span>${valStatus}</span>`;
    }

    if (elPole) elPole.innerText = poleId || '01';
    if (elGps) elGps.innerText = `${lat ? Number(lat).toFixed(5) : '12.97160'}, ${lng ? Number(lng).toFixed(5) : '77.59456'}`;
    if (elTime) elTime.innerText = timeStr || new Date().toLocaleTimeString();

    if (elMq2) elMq2.innerText = (state.hardware.mq2 || 562) + ' ppm';

    // Show calibrated deviation Δ instead of raw resting angle
    const netDelta = (state.hardware.netTilt !== undefined ? state.hardware.netTilt : 0).toFixed(1);
    const thresh = state.hardware.tiltThreshold || 10.0;
    const isLevel = Number(netDelta) < thresh;
    if (elTilt) elTilt.innerText = `Δ${netDelta}° (${isLevel ? 'Level' : 'Tilted'})`;
    if (elLight) elLight.innerText = state.hardware.lightState ? 'Dark (Night)' : 'Daylight';

    // Image Evidence
    let imgSrc = customImg;
    if (!imgSrc) {
      const liveCam = document.getElementById('live-cam-img');
      if (liveCam && liveCam.complete && liveCam.naturalWidth > 0) {
        try {
          const cvs = document.createElement('canvas');
          cvs.width = liveCam.naturalWidth;
          cvs.height = liveCam.naturalHeight;
          const ctx = cvs.getContext('2d');
          ctx.drawImage(liveCam, 0, 0);
          imgSrc = cvs.toDataURL('image/jpeg', 0.85);
        } catch (_) {}
      }
    }

    if (imgSrc && imgSrc.length > 50) {
      if (elImg) {
        elImg.src = imgSrc;
        elImg.classList.remove('hidden');
      }
      if (elNoImg) elNoImg.classList.add('hidden');
    } else {
      if (elImg) elImg.classList.add('hidden');
      if (elNoImg) {
        elNoImg.classList.remove('hidden');
        elNoImg.innerHTML = `<i data-lucide="camera-off" class="w-8 h-8 mb-1 text-slate-600"></i><span>Evidence frame unavailable</span>`;
      }
    }

    // Download Evidence Button in Emergency Modal
    const btnEmergencyDl = document.getElementById('btn-emergency-download');
    if (btnEmergencyDl) {
      if (imgSrc && imgSrc.length > 50) {
        btnEmergencyDl.href = imgSrc;
        btnEmergencyDl.download = `smartpole-emergency-evidence-${caseId || Date.now()}.jpg`;
        btnEmergencyDl.classList.remove('hidden');
      } else {
        btnEmergencyDl.classList.add('hidden');
      }
    }

    panel.classList.remove('hidden');
    if (window.lucide) window.lucide.createIcons();

    // Automatically trigger CCTV video recording on incident detection
    if (typeof startRecording === 'function' && !isRecording) {
      startRecording(cleanType);
    }
  }

  function dismissEmergencyPanel() {
    const panel = document.getElementById('active-emergency-panel');
    if (panel) panel.classList.add('hidden');
    lastSosState = false;
    lastAccidentState = false;
    if (typeof stopRecording === 'function' && isRecording) {
      stopRecording();
    }
    // Acknowledge ESP32 hardware and server state
    fetch('/api/pole-ack', { method: 'POST' }).catch(() => {});

    if (activeEmergencyCaseId) {
      fetch(`/api/incidents/${activeEmergencyCaseId}/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: getCurrentUser() })
      }).catch(() => {});
      activeEmergencyCaseId = null;
      fetchIncidents();
    }
  }

  // ========================================================
  // 1.5 IN-BROWSER CCTV VIDEO RECORDING ENGINE
  // ========================================================
  let mediaRecorder = null;
  let recordedChunks = [];
  let isRecording = false;
  let recordStartTime = 0;
  let recordTimerInterval = null;
  let recordRenderInterval = null;
  let emergencyAutoRecordTimeout = null;
  const recordCanvas = document.createElement('canvas');
  const recordCtx = recordCanvas.getContext('2d');

  function startRecording(triggerReason = '') {
    if (isRecording) return;
    const camImg = document.getElementById('live-cam-img');
    if (!camImg || !camImg.complete || !camImg.naturalWidth) {
      showToast('Camera feed unavailable — cannot record video.', 'error');
      return;
    }

    recordCanvas.width = 480;
    recordCanvas.height = 320;
    recordedChunks = [];

    let stream;
    try {
      stream = recordCanvas.captureStream(30);
    } catch (e) {
      showToast('Canvas video recording not supported by browser.', 'error');
      return;
    }

    try {
      const options = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? { mimeType: 'video/webm;codecs=vp9' }
        : (MediaRecorder.isTypeSupported('video/webm') ? { mimeType: 'video/webm' } : {});
      mediaRecorder = new MediaRecorder(stream, options);
    } catch (e) {
      showToast('MediaRecorder error: ' + e.message, 'error');
      return;
    }

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      if (recordedChunks.length === 0) return;
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      const videoUrl = URL.createObjectURL(blob);
      const videoRow = document.getElementById('cam-video-row');
      const videoPlayer = document.getElementById('cam-video-player');
      const videoDl = document.getElementById('cam-video-dl');

      if (videoPlayer) videoPlayer.src = videoUrl;
      if (videoDl) {
        videoDl.href = videoUrl;
        const prefix = triggerReason ? triggerReason.toLowerCase().replace(/[^a-z0-9]/g, '-') : 'cctv';
        videoDl.download = `smartpole-${prefix}-${Date.now()}.webm`;
      }
      if (videoRow) videoRow.classList.remove('hidden');

      showToast('Video recording ready for review & download!', 'success');
    };

    mediaRecorder.start(500);
    isRecording = true;
    recordStartTime = Date.now();

    // 30 FPS Render Loop with Timestamp & Watermark Overlay
    recordRenderInterval = setInterval(() => {
      if (camImg && camImg.complete && camImg.naturalWidth > 0) {
        recordCtx.drawImage(camImg, 0, 0, recordCanvas.width, recordCanvas.height);

        // Surveillance Watermark Bar
        recordCtx.fillStyle = triggerReason ? 'rgba(220, 38, 38, 0.85)' : 'rgba(0, 0, 0, 0.65)';
        recordCtx.fillRect(10, recordCanvas.height - 30, 320, 22);
        recordCtx.font = 'bold 11px Inter, sans-serif';
        recordCtx.fillStyle = '#ffffff';
        const label = triggerReason ? `[${triggerReason.toUpperCase()}]` : 'SMARTPOLE CCTV';
        recordCtx.fillText(`${label} • ${new Date().toLocaleTimeString()} • Pole #01`, 16, recordCanvas.height - 15);
      }
    }, 33);

    // Update UI elements
    const recBtn = document.getElementById('btn-record-video');
    const recText = document.getElementById('rec-btn-text');
    const recIndicator = document.getElementById('live-rec-indicator');
    const recTimer = document.getElementById('live-rec-timer');

    if (recBtn) recBtn.classList.add('recording-active-btn');
    if (recText) recText.textContent = 'Stop Record';
    if (recIndicator) recIndicator.classList.remove('hidden');

    recordTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordStartTime) / 1000);
      const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const s = String(elapsed % 60).padStart(2, '0');
      if (recTimer) recTimer.textContent = `REC ${m}:${s}`;
      if (recText) recText.textContent = `Stop (${m}:${s})`;
    }, 1000);

    // Auto-stop after 30 seconds for emergency triggers
    if (triggerReason) {
      if (emergencyAutoRecordTimeout) clearTimeout(emergencyAutoRecordTimeout);
      emergencyAutoRecordTimeout = setTimeout(() => {
        if (isRecording) stopRecording();
      }, 30000);
    }

    showToast(triggerReason ? `Emergency CCTV recording active (${triggerReason})` : 'CCTV video recording started.', 'info');
  }

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;

    if (emergencyAutoRecordTimeout) {
      clearTimeout(emergencyAutoRecordTimeout);
      emergencyAutoRecordTimeout = null;
    }
    clearInterval(recordRenderInterval);
    clearInterval(recordTimerInterval);

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }

    const recBtn = document.getElementById('btn-record-video');
    const recText = document.getElementById('rec-btn-text');
    const recIndicator = document.getElementById('live-rec-indicator');
    const recTimer = document.getElementById('live-rec-timer');

    if (recBtn) recBtn.classList.remove('recording-active-btn');
    if (recText) recText.textContent = 'Start Record';
    if (recIndicator) recIndicator.classList.add('hidden');
    if (recTimer) recTimer.textContent = 'REC 00:00';
  }

  window.startCameraRecording = startRecording;
  window.stopCameraRecording = stopRecording;
  window.isCameraRecording = () => isRecording;

  // ========================================================
  // 2. ROUTING & NAVIGATION (PROTECTED DASHBOARD ACCESS)
  // ========================================================
  function handleNavigation() {
    const hash = window.location.hash.replace(/^#/, '') || 'landing';

    // Check if route is a landing section anchor
    if (['features', 'how-it-works', 'about', 'portal'].includes(hash)) {
      showView('landing');
      setTimeout(() => {
        const el = document.getElementById(hash);
        if (el) el.scrollIntoView({ behavior: 'smooth' });
      }, 50);
      return;
    }

    if (hash === 'dashboard') {
      const authSession = localStorage.getItem('smartpole_auth_session') || sessionStorage.getItem('smartpole_auth_session') || localStorage.getItem('smartpole_user') || sessionStorage.getItem('smartpole_user');
      if (!authSession) {
        showToast('Please sign in to access the Municipal Dashboard.', 'info');
        window.location.hash = '#portal';
        showView('landing');
        return;
      }

      try {
        const u = JSON.parse(authSession);
        if (u.status === 'pending_approval') {
          showToast('Account pending municipal administrator authorization.', 'error');
          window.location.hash = '#portal';
          showView('landing');
          return;
        }
      } catch (_) {}

      showView('dashboard');
    } else {
      showView('landing');
    }
  }

  function showView(viewName) {
    state.currentRoute = viewName;
    const landingEl = document.getElementById('view-landing');
    const dashboardEl = document.getElementById('view-dashboard');
    const publicNavbar = document.getElementById('public-navbar');

    if (viewName === 'dashboard') {
      landingEl.classList.add('hidden');
      dashboardEl.classList.remove('hidden');
      publicNavbar.classList.add('hidden');
      document.body.classList.add('overflow-hidden');

      // Refresh map after container renders
      setTimeout(() => {
        if (state.overviewMap) state.overviewMap.invalidateSize();
      }, 200);
    } else {
      dashboardEl.classList.add('hidden');
      landingEl.classList.remove('hidden');
      publicNavbar.classList.remove('hidden');
      document.body.classList.remove('overflow-hidden');
    }

    if (window.lucide) window.lucide.createIcons();
  }

  // Programmatic Tab Switcher inside Dashboard
  function activateTab(targetTab) {
    const tabButtons = document.querySelectorAll('.sidebar-tab-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');
    const titleEl = document.getElementById('current-view-title');

    const TITLES = {
      'tab-overview': 'Dashboard Overview',
      'tab-live': 'Live Monitoring & Telemetry',
      'tab-alerts': 'Emergency Alerts & Critical Incidents',
      'tab-camera': 'Camera Detection & Visual Evidence',
      'tab-gas': 'MQ-2 Gas & Smoke Telemetry',
      'tab-calibration': 'MPU-6050 Accelerometer & Tilt Calibration',
      'tab-sos': 'Physical SOS Panic Button Logs',
      'tab-locations': 'Municipal Safety Pole Network Map',
      'tab-profile': 'Officer Profile & System User Approvals',
      'tab-settings': 'System Settings & Hardware Network'
    };

    tabButtons.forEach(b => {
      const match = b.getAttribute('data-tab') === targetTab;
      b.classList.toggle('active', match);
      b.classList.toggle('bg-slate-100', match);
      b.classList.toggle('text-navy-900', match);
      b.classList.toggle('text-slate-600', !match);
    });

    tabPanes.forEach(p => p.classList.add('hidden'));
    const activePane = document.getElementById(targetTab);
    if (activePane) activePane.classList.remove('hidden');

    state.activeTab = targetTab;
    if (titleEl && TITLES[targetTab]) titleEl.innerText = TITLES[targetTab];

    // Resize and center maps if tab has one
    if (targetTab === 'tab-overview' && state.overviewMap) {
      setTimeout(() => {
        state.overviewMap.invalidateSize();
        if (state.hardware.gps?.lat) {
          state.overviewMap.setView([state.hardware.gps.lat, state.hardware.gps.lng], 15);
        }
      }, 150);
    }
    if (targetTab === 'tab-locations' && state.fullMap) {
      setTimeout(() => {
        state.fullMap.invalidateSize();
        if (state.hardware.gps?.lat) {
          state.fullMap.setView([state.hardware.gps.lat, state.hardware.gps.lng], 16);
        }
      }, 150);
    }

    // Trigger tab-specific refresh
    if (targetTab === 'tab-calibration' && typeof fetchCalibrationData === 'function') {
      fetchCalibrationData();
    }
    if (targetTab === 'tab-profile' && typeof loadProfileAndUsers === 'function') {
      loadProfileAndUsers();
    }

    if (window.lucide) window.lucide.createIcons();
  }

  // Sidebar Sub-Tabs inside Dashboard
  function setupTabs() {
    const tabButtons = document.querySelectorAll('.sidebar-tab-btn');
    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-tab');
        if (targetTab) activateTab(targetTab);
      });
    });
  }

  function setupSidebarToggle() {
    const btn = document.getElementById('btn-toggle-sidebar');
    const sidebar = document.getElementById('sidebar');
    if (!btn || !sidebar) return;

    btn.addEventListener('click', () => {
      state.sidebarCollapsed = !state.sidebarCollapsed;
      const texts = sidebar.querySelectorAll('.sidebar-text');

      if (state.sidebarCollapsed) {
        sidebar.classList.remove('w-64');
        sidebar.classList.add('w-16');
        texts.forEach(t => t.classList.add('hidden'));
      } else {
        sidebar.classList.remove('w-16');
        sidebar.classList.add('w-64');
        texts.forEach(t => t.classList.remove('hidden'));
      }

      if (window.lucide) window.lucide.createIcons();
    });
  }

  // ========================================================
  // 3. HARDWARE TELEMETRY & SOCKET.IO
  // ========================================================
  function initSocketIO() {
    if (typeof io === 'undefined') {
      console.warn('[Socket.IO] Library not found.');
      return;
    }

    const socket = io();

    socket.on('connect', () => {
      console.log('[Socket.IO] Connected to backend server.');
      updateStatusBadge('status-firebase-badge', 'Online', 'emerald');
    });

    socket.on('disconnect', () => {
      console.warn('[Socket.IO] Disconnected from backend server.');
      updateStatusBadge('status-firebase-badge', 'Offline', 'red');
    });

    // Real-time telemetry updates polled from ESP32
    socket.on('telemetry-update', (data) => {
      handleTelemetryUpdate(data);
    });

    // Incidents updates from server
    socket.on('incident-cases', (cases) => {
      mergeIncidents(cases);
    });

    socket.on('new-incident-case', (newCase) => {
      mergeIncidents([newCase]);
      const trigger = (newCase.triggerType || '').toLowerCase();
      if (trigger.includes('accident') || trigger.includes('collision') || trigger.includes('sos') || trigger.includes('fire')) {
        showEmergencyPanel(
          newCase.id,
          newCase.triggerType,
          '01',
          newCase.telemetrySnapshot?.gps?.lat || state.hardware.gps.lat,
          newCase.telemetrySnapshot?.gps?.lng || state.hardware.gps.lng,
          new Date(newCase.timestamp).toLocaleTimeString(),
          newCase.imageUrl || '',
          {
            severity: newCase.severity,
            confidence: newCase.confidence,
            validationStatus: newCase.validationStatus
          }
        );
      }
    });

    // AI Roboflow Vision alerts — Pops up old-type emergency modal with zero browser alerts
    socket.on('accident-detection', (ev) => {
      console.log('[AI Accident Alert]:', ev);
      showEmergencyPanel(
        ev.caseId || ('accident-' + Date.now()),
        ev.type || 'Road Accident Detected',
        '01',
        state.hardware.gps.lat,
        state.hardware.gps.lng,
        new Date().toLocaleTimeString(),
        ev.imageUrl || '',
        ev
      );
      fetchIncidents();
    });

    socket.on('fire-detection', (ev) => {
      console.log('[AI Fire Alert]:', ev);
      showEmergencyPanel(
        ev.caseId || ('fire-' + Date.now()),
        ev.type || 'Fire / Smoke Alert',
        '01',
        state.hardware.gps.lat,
        state.hardware.gps.lng,
        new Date().toLocaleTimeString(),
        ev.imageUrl || ''
      );
      fetchIncidents();
    });
  }

  function handleTelemetryUpdate(data) {
    if (!data) return;

    state.hardware.online = true;
    state.hardware.mq2 = Number(data.mq2Value !== undefined ? data.mq2Value : 562);
    state.hardware.ldr = Number(data.ldrValue || 0);
    state.hardware.lightState = Boolean(data.lightState);
    state.hardware.darkDetected = Boolean(data.darkDetected);
    state.hardware.tiltX = Number(data.tiltX || 0);
    state.hardware.tiltY = Number(data.tiltY || 0);
    state.hardware.baselineTiltX = data.baselineTiltX !== undefined ? Number(data.baselineTiltX) : null;
    state.hardware.baselineTiltY = data.baselineTiltY !== undefined ? Number(data.baselineTiltY) : null;
    state.hardware.deltaTiltX = Number(data.deltaTiltX || 0);
    state.hardware.deltaTiltY = Number(data.deltaTiltY || 0);
    state.hardware.netTilt = Number(data.netTilt || 0);
    state.hardware.tiltThreshold = Number(data.tiltThreshold || 10.0);
    state.hardware.isTilted = Boolean(data.isTilted);
    state.hardware.motion = Boolean(data.pirMotion);
    state.hardware.sos = Boolean(data.sosAlert);
    state.hardware.lastSeen = new Date();

    if (data.gps && data.gps.lat && data.gps.lng) {
      state.hardware.gps = { lat: Number(data.gps.lat), lng: Number(data.gps.lng) };
    }

    // Check if this is an SOS call event (button press or firmware trigger)
    const rawReason = (data.accidentReason || '').trim();
    const isSosEvent = Boolean(data.sosAlert || data.sos || /sos/i.test(rawReason));

    state.hardware.sos = isSosEvent;
    state.hardware.accidentReason = isSosEvent ? 'SOS Call' : rawReason;
    state.hardware.accident = isSosEvent ? false : Boolean(data.accidentAlert || data.accident);

    // 1. Citizen Emergency SOS Call (Highest priority evaluation)
    if (isSosEvent && !lastSosState) {
      lastSosState = true;
      showEmergencyPanel(
        'sos-' + Date.now(),
        'SOS Call',
        '01',
        data.gps?.lat || state.hardware.gps.lat,
        data.gps?.lng || state.hardware.gps.lng,
        new Date().toLocaleTimeString(),
        '',
        { severity: 'Critical', validationStatus: 'Citizen Distress Call Active' }
      );
    } else if (!isSosEvent) {
      lastSosState = false;
    }

    // 2. Hardware impact / tilt / accident (Strictly NON-SOS, verified against calibrated baseline)
    const currentAccident = Boolean(data.accidentAlert) && !isSosEvent;

    if (currentAccident && !lastAccidentState) {
      lastAccidentState = true;
      const accidentType = data.accidentReason || (data.isTilted ? `Pole Tilt Alert (${state.hardware.netTilt.toFixed(1)}°)` : 'Pole Disturbance Alert');
      showEmergencyPanel(
        'accident-' + Date.now(),
        accidentType,
        '01',
        data.gps?.lat || state.hardware.gps.lat,
        data.gps?.lng || state.hardware.gps.lng,
        new Date().toLocaleTimeString()
      );
    } else if (!currentAccident) {
      lastAccidentState = false;
    }

    // Update UI elements
    updateTelemetryUI();
  }

  function updateTelemetryUI() {
    const hw = state.hardware;

    // 1. Gas Readings
    const liveGasVal = document.getElementById('live-gas-val');
    const liveGasBar = document.getElementById('live-gas-bar');
    const liveGasBadge = document.getElementById('live-gas-badge');
    const gasTabVal = document.getElementById('gas-tab-val');
    const heroGasStatus = document.getElementById('hero-gas-status');
    const statusMq2Sub = document.getElementById('status-mq2-subtext');

    if (liveGasVal) liveGasVal.innerText = hw.mq2;
    if (gasTabVal) gasTabVal.innerText = hw.mq2;
    if (statusMq2Sub) statusMq2Sub.innerText = `MQ-2: ${hw.mq2} ppm`;

    const gasPct = Math.min(100, Math.round((hw.mq2 / 2000) * 100));
    if (liveGasBar) liveGasBar.style.width = gasPct + '%';

    if (hw.mq2 >= 1800) {
      if (liveGasBadge) {
        liveGasBadge.innerText = 'Critical Leak';
        liveGasBadge.className = 'px-2 py-0.5 rounded text-xs font-semibold bg-red-50 text-red-700 border border-red-200';
      }
      if (liveGasBar) liveGasBar.className = 'bg-red-500 h-2 rounded-full transition-all duration-300';
      updateStatusBadge('status-gas-badge', 'Critical', 'red');
      if (heroGasStatus) {
        heroGasStatus.innerText = `${hw.mq2} ppm (Hazard)`;
        heroGasStatus.className = 'font-semibold text-red-600';
      }
    } else if (hw.mq2 >= 1000) {
      if (liveGasBadge) {
        liveGasBadge.innerText = 'Elevated';
        liveGasBadge.className = 'px-2 py-0.5 rounded text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200';
      }
      if (liveGasBar) liveGasBar.className = 'bg-amber-500 h-2 rounded-full transition-all duration-300';
      updateStatusBadge('status-gas-badge', 'Warning', 'amber');
      if (heroGasStatus) {
        heroGasStatus.innerText = `${hw.mq2} ppm (Elevated)`;
        heroGasStatus.className = 'font-semibold text-amber-600';
      }
    } else {
      if (liveGasBadge) {
        liveGasBadge.innerText = 'Clean Air';
        liveGasBadge.className = 'px-2 py-0.5 rounded text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200';
      }
      if (liveGasBar) liveGasBar.className = 'bg-emerald-500 h-2 rounded-full transition-all duration-300';
      updateStatusBadge('status-gas-badge', 'Normal', 'emerald');
      if (heroGasStatus) {
        heroGasStatus.innerText = `${hw.mq2} ppm (Clean)`;
        heroGasStatus.className = 'font-semibold text-emerald-600';
      }
    }

    // 2. Light & LDR Relay Status
    const liveLdrBadge = document.getElementById('live-ldr-badge');
    const liveLdrText = document.getElementById('live-ldr-text');
    const liveLdrIcon = document.getElementById('live-ldr-icon');
    const heroLightStatus = document.getElementById('hero-light-status');

    if (hw.darkDetected || hw.lightState) {
      if (liveLdrBadge) {
        liveLdrBadge.innerText = 'Night (Dark)';
        liveLdrBadge.className = 'px-2 py-0.5 rounded text-xs font-semibold bg-slate-100 text-slate-800 border border-slate-300';
      }
      if (liveLdrText) liveLdrText.innerText = 'Night Mode';
      if (liveLdrIcon) liveLdrIcon.setAttribute('data-lucide', 'moon');
      if (heroLightStatus) heroLightStatus.innerText = 'Streetlight ON (Night)';
    } else {
      if (liveLdrBadge) {
        liveLdrBadge.innerText = 'Daylight';
        liveLdrBadge.className = 'px-2 py-0.5 rounded text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200';
      }
      if (liveLdrText) liveLdrText.innerText = 'Daylight Mode';
      if (liveLdrIcon) liveLdrIcon.setAttribute('data-lucide', 'sun');
      if (heroLightStatus) heroLightStatus.innerText = 'Streetlight OFF (Daylight)';
    }

    // 3. MPU-6050 Tilt Tracking (Calibrated Baseline & 10.0° Threshold)
    const liveTiltX = document.getElementById('live-tilt-x');
    const liveTiltY = document.getElementById('live-tilt-y');
    const liveTiltStatus = document.getElementById('live-tilt-status');
    const liveTiltThreshold = document.getElementById('live-tilt-threshold');

    const threshold = hw.tiltThreshold || 10.0;
    const deltaX = hw.deltaTiltX !== undefined ? hw.deltaTiltX : 0;
    const deltaY = hw.deltaTiltY !== undefined ? hw.deltaTiltY : 0;
    const netTilt = hw.netTilt !== undefined ? hw.netTilt : Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    const isTilted = hw.isTilted !== undefined ? hw.isTilted : (netTilt >= threshold || Math.abs(deltaX) >= threshold || Math.abs(deltaY) >= threshold);

    if (liveTiltX) {
      liveTiltX.innerText = `${hw.tiltX.toFixed(2)}° (Δ${deltaX >= 0 ? '+' : ''}${deltaX.toFixed(2)}°)`;
    }
    if (liveTiltY) {
      liveTiltY.innerText = `${hw.tiltY.toFixed(2)}° (Δ${deltaY >= 0 ? '+' : ''}${deltaY.toFixed(2)}°)`;
    }
    if (liveTiltThreshold) {
      liveTiltThreshold.innerText = `Threshold: ±${threshold.toFixed(1)}° (Calibrated)`;
    }

    if (liveTiltStatus) {
      if (isTilted) {
        liveTiltStatus.innerText = `Tilt Alert (Net Δ${netTilt.toFixed(1)}° ≥ ${threshold.toFixed(1)}°)`;
        liveTiltStatus.className = 'text-red-600 font-semibold';
      } else {
        liveTiltStatus.innerText = `Stable (Level Δ${netTilt.toFixed(1)}°)`;
        liveTiltStatus.className = 'text-emerald-600 font-semibold';
      }
    }

    // Update Tilt Calibration Tab Live Indicators
    const calDeltaX = document.getElementById('cal-live-delta-x');
    const calRawX = document.getElementById('cal-raw-x');
    const calDeltaY = document.getElementById('cal-live-delta-y');
    const calRawY = document.getElementById('cal-raw-y');
    const calNetTilt = document.getElementById('cal-live-net-tilt');
    const calAlarmStatus = document.getElementById('cal-tilt-alarm-status');
    const calThresholdEl = document.getElementById('cal-current-threshold');

    if (calDeltaX) calDeltaX.innerText = `${deltaX >= 0 ? '+' : ''}${deltaX.toFixed(2)}°`;
    if (calRawX) calRawX.innerText = `${hw.tiltX.toFixed(2)}°`;
    if (calDeltaY) calDeltaY.innerText = `${deltaY >= 0 ? '+' : ''}${deltaY.toFixed(2)}°`;
    if (calRawY) calRawY.innerText = `${hw.tiltY.toFixed(2)}°`;
    if (calNetTilt) {
      calNetTilt.innerText = `${netTilt.toFixed(2)}°`;
      calNetTilt.className = isTilted ? 'text-2xl font-bold font-mono text-red-600' : 'text-2xl font-bold font-mono text-emerald-600';
    }
    if (calAlarmStatus) {
      if (isTilted) {
        calAlarmStatus.innerText = 'Tilt Exceeded';
        calAlarmStatus.className = 'text-xs font-semibold px-2 py-0.5 rounded bg-red-100 text-red-800';
      } else {
        calAlarmStatus.innerText = 'Stable';
        calAlarmStatus.className = 'text-xs font-semibold px-2 py-0.5 rounded bg-emerald-100 text-emerald-800';
      }
    }
    if (calThresholdEl) calThresholdEl.innerText = `±${threshold.toFixed(1)}°`;

    // 4. GPS
    const liveGpsCoords = document.getElementById('live-gps-coords');
    const liveGpsLink = document.getElementById('live-gps-link');
    if (liveGpsCoords) {
      liveGpsCoords.innerText = `${hw.gps.lat.toFixed(6)}, ${hw.gps.lng.toFixed(6)}`;
    }
    if (liveGpsLink) {
      liveGpsLink.href = `https://maps.google.com/?q=${hw.gps.lat.toFixed(6)},${hw.gps.lng.toFixed(6)}`;
    }

    // 5. Update Live Hardware Marker on Map
    updateHardwareMarker();

    if (window.lucide) window.lucide.createIcons();
  }

  function updateStatusBadge(id, text, color) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerText = text;
    if (color === 'emerald') el.className = 'px-2 py-0.5 rounded text-xs font-semibold bg-emerald-100 text-emerald-800';
    if (color === 'amber') el.className = 'px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-800';
    if (color === 'red') el.className = 'px-2 py-0.5 rounded text-xs font-semibold bg-red-100 text-red-800';
  }

  // ========================================================
  // 4. INCIDENTS MANAGEMENT & DATA TABLES
  // ========================================================
  async function fetchIncidents() {
    try {
      const res = await fetch('/api/incidents', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        mergeIncidents(data);
      } else {
        mergeIncidents([]);
      }
    } catch (e) {
      mergeIncidents([]);
    }
  }

  function mergeIncidents(serverCases) {
    const map = new Map();

    // Add server cases first (hardware pole incidents)
    (serverCases || []).forEach(c => {
      if (!c.id) return;
      map.set(c.id, {
        id: c.id,
        timestamp: c.timestamp || new Date().toISOString(),
        triggerType: c.triggerType || 'Incident Alert',
        poleId: c.poleId || 'POLE-01 [LIVE HARDWARE]',
        location: c.location || 'Sector 14 North (30.68236, 76.60628)',
        severity: c.severity || (/sos|accident|fire/i.test(c.triggerType || '') ? 'Critical' : 'Warning'),
        status: c.status || 'Pending',
        assignedTeam: c.assignedTeam || 'City Traffic Police & EMS Unit 04',
        imageUrl: c.imageUrl || '',
        telemetrySnapshot: c.telemetrySnapshot || { ...state.hardware }
      });
    });

    state.incidents = Array.from(map.values()).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    renderAlertsTable();
    renderCriticalAlertsTable();
    renderCameraGallery();
    renderGasTable();
    renderSosTable();
    updateKPICounters();
  }

  function updateKPICounters() {
    const criticalCount = state.incidents.filter(i => i.severity === 'Critical' && i.status !== 'Resolved').length;
    const gasCount = state.incidents.filter(i => /gas|smoke/i.test(i.triggerType) && i.status !== 'Resolved').length;
    const resolvedCount = state.incidents.filter(i => i.status === 'Resolved').length;

    const elPoles = document.getElementById('kpi-total-poles');
    const elCrit = document.getElementById('kpi-active-emergencies');
    const elGas = document.getElementById('kpi-gas-warnings');
    const elRes = document.getElementById('kpi-resolved-incidents');
    const elSideBadge = document.getElementById('sidebar-alert-badge');

    if (elPoles) elPoles.innerText = '1';
    if (elCrit) elCrit.innerText = criticalCount;
    if (elGas) elGas.innerText = gasCount;
    if (elRes) elRes.innerText = resolvedCount;
    if (elSideBadge) elSideBadge.innerText = criticalCount;

    // Dynamic Landing Page Hero Stats
    const elHeroPoles = document.getElementById('hero-stat-poles');
    const elHeroIncidents = document.getElementById('hero-stat-incidents');
    const elHeroResolved = document.getElementById('hero-stat-resolved');
    const elFeatureGas = document.getElementById('feature-gas-reading');

    if (elHeroPoles) elHeroPoles.innerText = '1';
    if (elHeroIncidents) elHeroIncidents.innerText = state.incidents.length;
    if (elHeroResolved) elHeroResolved.innerText = resolvedCount;
    if (elFeatureGas) elFeatureGas.innerText = state.hardware.mq2 || 562;

    renderNotificationsDropdown();
  }

  function renderNotificationsDropdown() {
    const badge = document.getElementById('notification-badge');
    const countEl = document.getElementById('notif-unread-count');
    const listEl = document.getElementById('notification-list');
    const bellBtn = document.getElementById('btn-notification-bell');
    if (!listEl) return;

    const criticals = state.incidents.filter(i => i.severity === 'Critical' && i.status !== 'Resolved');
    if (badge) {
      if (criticals.length > 0) badge.classList.remove('hidden');
      else badge.classList.add('hidden');
    }
    if (bellBtn) {
      if (criticals.length > 0) bellBtn.classList.add('bell-jiggle');
      else bellBtn.classList.remove('bell-jiggle');
    }
    if (countEl) countEl.innerText = `${criticals.length} Active`;

    const recent = state.incidents.slice(0, 6);
    if (recent.length === 0) {
      listEl.innerHTML = `<div class="p-4 text-center text-slate-400">Zero active notifications.</div>`;
      return;
    }

    listEl.innerHTML = recent.map(inc => {
      const isCrit = inc.severity === 'Critical';
      const timeStr = new Date(inc.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `
        <div onclick="window.viewIncidentDetails('${inc.id}')" class="p-3 hover:bg-slate-50 cursor-pointer transition flex items-start gap-2.5">
          <span class="w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${isCrit ? 'bg-red-500 animate-pulse' : 'bg-amber-500'}"></span>
          <div class="flex-1 min-w-0">
            <p class="font-semibold text-slate-900 truncate">${inc.triggerType}</p>
            <p class="text-[11px] text-slate-500 truncate">${inc.location}</p>
          </div>
          <span class="text-[10px] text-slate-400 whitespace-nowrap">${timeStr}</span>
        </div>
      `;
    }).join('');
  }

  function sortIncidents(items) {
    if (!Array.isArray(items)) return [];
    return [...items].sort((a, b) => {
      if (state.sortField === 'id') {
        const idA = String(a.id || '').toUpperCase();
        const idB = String(b.id || '').toUpperCase();
        return state.sortOrder === 'asc' ? idA.localeCompare(idB) : idB.localeCompare(idA);
      }
      // Default: date/time sort
      const timeA = new Date(a.timestamp || 0).getTime();
      const timeB = new Date(b.timestamp || 0).getTime();
      return state.sortOrder === 'asc' ? timeA - timeB : timeB - timeA;
    });
  }

  function renderAlertsTable() {
    const tbody = document.getElementById('recent-alerts-tbody');
    if (!tbody) return;

    let items = state.incidents;

    // Search query filter
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      items = items.filter(i =>
        (i.id && i.id.toLowerCase().includes(q)) ||
        (i.triggerType && i.triggerType.toLowerCase().includes(q)) ||
        (i.location && i.location.toLowerCase().includes(q))
      );
    }

    if (state.filterSeverity !== 'all') {
      if (state.filterSeverity === 'Resolved') {
        items = items.filter(i => i.status === 'Resolved');
      } else {
        items = items.filter(i => i.severity === state.filterSeverity);
      }
    }

    // Apply sorting
    items = sortIncidents(items);

    if (items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="px-5 py-8 text-center text-slate-400">No incident logs matching current query or filter.</td></tr>`;
      return;
    }

    tbody.innerHTML = items.map(item => {
      const timeStr = new Date(item.timestamp).toLocaleString();
      const isSos = /sos/i.test(item.triggerType);
      const displayType = isSos
        ? `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700 border border-red-200"><span class="w-1.5 h-1.5 rounded-full bg-red-600 animate-pulse"></span>SOS Call</span>`
        : `<span class="font-semibold text-slate-900">${item.triggerType}</span>`;

      const severityBadge = (item.severity === 'Critical' || isSos)
        ? `<span class="px-2 py-0.5 rounded text-[11px] font-bold bg-red-100 text-red-700">Critical</span>`
        : (item.severity === 'Warning'
          ? `<span class="px-2 py-0.5 rounded text-[11px] font-bold bg-amber-100 text-amber-700">Warning</span>`
          : `<span class="px-2 py-0.5 rounded text-[11px] font-bold bg-slate-100 text-slate-700">Normal</span>`);

      const statusBadge = item.status === 'Resolved'
        ? `<span class="px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-100 text-emerald-800">Resolved</span>`
        : (item.status === 'Acknowledged'
          ? `<span class="px-2 py-0.5 rounded text-[11px] font-semibold bg-blue-100 text-blue-800">Acknowledged</span>`
          : `<span class="px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-100 text-amber-800">Pending</span>`);

      return `
        <tr class="hover:bg-slate-50 transition border-b border-slate-100">
          <td class="px-5 py-3 font-mono font-medium text-slate-800">${item.id}</td>
          <td class="px-5 py-3">${displayType}</td>
          <td class="px-5 py-3 text-slate-600">${item.location}</td>
          <td class="px-5 py-3 text-slate-500">${timeStr}</td>
          <td class="px-5 py-3">${severityBadge}</td>
          <td class="px-5 py-3">${statusBadge}</td>
          <td class="px-5 py-3 text-right">
            <div class="flex items-center justify-end gap-1.5">
              ${item.imageUrl && item.imageUrl.length > 50 ? `
              <a href="${item.imageUrl}" download="smartpole-evidence-${item.id}.jpg" onclick="event.stopPropagation()" class="p-1.5 rounded-lg border border-slate-200 hover:bg-blue-50 text-slate-500 hover:text-blue-600 transition" title="Download Evidence Photo">
                <i data-lucide="download" class="w-3.5 h-3.5"></i>
              </a>
              ` : ''}
              ${item.status !== 'Resolved' ? `
              <button onclick="event.stopPropagation(); window.resolveIncidentDirect('${item.id}')" class="px-2 py-1 rounded-lg border border-emerald-200 hover:bg-emerald-50 text-emerald-700 font-semibold text-[11px] transition" title="Mark Resolved">
                Resolve
              </button>
              ` : ''}
              <button onclick="window.viewIncidentDetails('${item.id}')" class="px-2.5 py-1 rounded-lg border border-slate-200 hover:bg-slate-100 text-slate-700 font-semibold text-[11px] transition">
                View
              </button>
              <button onclick="event.stopPropagation(); window.deleteIncident('${item.id}')" class="p-1.5 rounded-lg border border-slate-200 hover:bg-red-50 text-slate-400 hover:text-red-600 transition" title="Delete Log">
                <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
    if (window.lucide) window.lucide.createIcons();
  }

  function renderCriticalAlertsTable() {
    const tbody = document.getElementById('critical-alerts-tbody');
    if (!tbody) return;

    // Both Critical severity incidents and citizen SOS distress calls appear in Emergency Reports
    let items = state.incidents.filter(i => i.severity === 'Critical' || /sos/i.test(i.triggerType));
    items = sortIncidents(items);

    if (items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-8 text-center text-slate-400">Zero active critical alerts.</td></tr>`;
      return;
    }

    tbody.innerHTML = items.map(item => {
      const timeStr = new Date(item.timestamp).toLocaleString();
      const isSos = /sos/i.test(item.triggerType);
      const displayType = isSos
        ? `<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700 border border-red-200 truncate"><span class="w-1.5 h-1.5 rounded-full bg-red-600 animate-pulse flex-shrink-0"></span>SOS Call</span>`
        : `<span class="font-semibold text-slate-900 truncate block" title="${item.triggerType}">${item.triggerType}</span>`;

      const statusBadge = item.status === 'Resolved'
        ? `<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800">Resolved</span>`
        : (item.status === 'Acknowledged'
          ? `<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-100 text-blue-800">Ack</span>`
          : `<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-800">Pending</span>`);

      return `
        <tr class="hover:bg-slate-50 transition border-b border-slate-100">
          <td class="px-3 py-3 font-mono font-medium text-slate-800 truncate" title="${item.id}">${item.id}</td>
          <td class="px-3 py-3 overflow-hidden">${displayType}</td>
          <td class="px-3 py-3 text-slate-600 truncate" title="${item.location}">${item.location}</td>
          <td class="px-3 py-3 text-slate-500 truncate" title="${timeStr}">${timeStr}</td>
          <td class="px-3 py-3 text-slate-600 font-medium truncate" title="${item.assignedTeam}">${item.assignedTeam}</td>
          <td class="px-3 py-3">${statusBadge}</td>
          <td class="px-3 py-3 text-right">
            <div class="flex items-center justify-end gap-1">
              ${item.imageUrl && item.imageUrl.length > 50 ? `
              <a href="${item.imageUrl}" download="smartpole-evidence-${item.id}.jpg" onclick="event.stopPropagation()" class="p-1.5 rounded-lg border border-slate-200 hover:bg-blue-50 text-slate-500 hover:text-blue-600 transition flex-shrink-0" title="Download Evidence Photo">
                <i data-lucide="download" class="w-3.5 h-3.5"></i>
              </a>
              ` : ''}
              <button onclick="window.viewIncidentDetails('${item.id}')" class="px-2.5 py-1 rounded-lg bg-navy-900 hover:bg-slate-800 text-white font-semibold text-[11px] flex-shrink-0">
                Review
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
    if (window.lucide) window.lucide.createIcons();
  }

  function renderCameraGallery() {
    const grid = document.getElementById('camera-evidence-grid');
    if (!grid) return;

    let itemsWithImages = state.incidents.filter(i => i.imageUrl && i.imageUrl.length > 50);
    itemsWithImages = sortIncidents(itemsWithImages);

    if (itemsWithImages.length === 0) {
      grid.innerHTML = `
        <div class="col-span-full py-12 text-center text-slate-400 text-xs">
          <i data-lucide="image" class="w-8 h-8 mx-auto mb-2 text-slate-300"></i>
          <span>No incident snapshot captures logged yet. Trigger an alert or click 'Capture Snapshot'.</span>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    grid.innerHTML = itemsWithImages.slice(0, 9).map(item => {
      const isSos = /sos/i.test(item.triggerType);
      const label = isSos ? 'SOS Call' : item.triggerType;
      return `
      <div class="bg-slate-50 border border-slate-200 rounded-xl overflow-hidden hover:shadow-md transition relative group">
        <div onclick="window.viewIncidentDetails('${item.id}')" class="aspect-video bg-slate-900 flex items-center justify-center overflow-hidden cursor-pointer">
          <img src="${item.imageUrl}" alt="Evidence" class="w-full h-full object-cover">
        </div>
        <div class="p-3 flex items-center justify-between">
          <div onclick="window.viewIncidentDetails('${item.id}')" class="cursor-pointer">
            <div class="flex items-center gap-2 text-[11px]">
              <span class="font-bold text-navy-900">${label}</span>
              <span class="font-mono text-slate-400">${item.id.slice(-6)}</span>
            </div>
            <p class="text-[11px] text-slate-500 mt-1">${new Date(item.timestamp).toLocaleTimeString()} • ${item.location.split('(')[0]}</p>
          </div>
          <div class="flex items-center gap-1">
            <a href="${item.imageUrl}" download="smartpole-evidence-${item.id}.jpg" onclick="event.stopPropagation()" class="p-1.5 rounded-lg border border-slate-200 hover:bg-blue-50 text-slate-500 hover:text-blue-600 transition" title="Download Evidence Photo">
              <i data-lucide="download" class="w-3.5 h-3.5"></i>
            </a>
            <button onclick="event.stopPropagation(); window.deleteIncidentPhoto('${item.id}')" class="p-1.5 rounded-lg border border-slate-200 hover:bg-red-50 text-slate-400 hover:text-red-600 transition" title="Delete Photo">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </div>
      </div>
    `;
    }).join('');
    if (window.lucide) window.lucide.createIcons();
  }

  function renderGasTable() {
    const tbody = document.getElementById('gas-table-tbody');
    if (!tbody) return;

    let items = state.incidents.filter(i => /gas|smoke/i.test(i.triggerType));
    items = sortIncidents(items);

    if (items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="px-4 py-6 text-center text-slate-400">No gas anomalies detected. Air quality nominal.</td></tr>`;
      return;
    }

    tbody.innerHTML = items.map(item => `
      <tr class="hover:bg-slate-50 border-b border-slate-100">
        <td class="px-4 py-2.5 font-mono">${item.id}</td>
        <td class="px-4 py-2.5">${item.location}</td>
        <td class="px-4 py-2.5 font-bold text-amber-600">${item.telemetrySnapshot?.mq2Value || 562} ppm</td>
        <td class="px-4 py-2.5 text-slate-500">${new Date(item.timestamp).toLocaleString()}</td>
        <td class="px-4 py-2.5"><span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800">${item.status}</span></td>
      </tr>
    `).join('');
  }

  function renderSosTable() {
    const tbody = document.getElementById('sos-table-tbody');
    if (!tbody) return;

    let items = state.incidents.filter(i => /sos/i.test(i.triggerType));
    items = sortIncidents(items);

    if (items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-6 text-center text-slate-400">No citizen panic calls logged.</td></tr>`;
      return;
    }

    tbody.innerHTML = items.map(item => `
      <tr class="hover:bg-slate-50 border-b border-slate-100">
        <td class="px-4 py-2.5 font-mono font-medium">${item.id}</td>
        <td class="px-4 py-2.5"><span class="px-2.5 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700 border border-red-200">SOS Call</span></td>
        <td class="px-4 py-2.5 text-slate-700">${item.location}</td>
        <td class="px-4 py-2.5 text-slate-500">${new Date(item.timestamp).toLocaleString()}</td>
        <td class="px-4 py-2.5 text-slate-700 font-medium">${item.assignedTeam}</td>
        <td class="px-4 py-2.5"><span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-800">${item.status}</span></td>
        <td class="px-4 py-2.5 text-right">
          <button onclick="window.viewIncidentDetails('${item.id}')" class="px-2.5 py-1 rounded-lg border border-slate-200 hover:bg-slate-100 text-[11px] font-semibold">View</button>
        </td>
      </tr>
    `).join('');
  }

  // ========================================================
  // 5. INCIDENT DETAILS MODAL
  // ========================================================
  window.viewIncidentDetails = function (caseId) {
    const item = state.incidents.find(i => i.id === caseId);
    if (!item) return;

    state.selectedIncident = item;

    const modal = document.getElementById('modal-incident-details');
    const elType = document.getElementById('modal-incident-type');
    const elCase = document.getElementById('modal-case-id');
    const elBadge = document.getElementById('modal-severity-badge');
    const elImg = document.getElementById('modal-image');
    const elNoImg = document.getElementById('modal-no-image');
    const elMq2 = document.getElementById('modal-mq2');
    const elTiltX = document.getElementById('modal-tilt-x');
    const elTiltY = document.getElementById('modal-tilt-y');
    const elLight = document.getElementById('modal-light');
    const elLoc = document.getElementById('modal-location');
    const elTime = document.getElementById('modal-timestamp');
    const elStatus = document.getElementById('modal-status-badge');
    const elTeam = document.getElementById('modal-response-team');

    if (elType) elType.innerText = /sos/i.test(item.triggerType) ? 'SOS Call' : item.triggerType;
    if (elCase) elCase.innerText = item.id;
    if (elLoc) elLoc.innerText = `${item.poleId} — ${item.location}`;
    if (elTime) elTime.innerText = new Date(item.timestamp).toLocaleString();
    if (elTeam) elTeam.innerText = item.assignedTeam;

    if (elBadge) {
      elBadge.innerText = item.severity.toUpperCase();
      elBadge.className = item.severity === 'Critical'
        ? 'px-2.5 py-0.5 rounded text-xs font-bold bg-red-100 text-red-700'
        : 'px-2.5 py-0.5 rounded text-xs font-bold bg-amber-100 text-amber-700';
    }

    if (elStatus) {
      elStatus.innerText = item.status;
      elStatus.className = item.status === 'Resolved'
        ? 'inline-block px-2 py-0.5 rounded text-xs font-bold bg-emerald-100 text-emerald-800'
        : 'inline-block px-2 py-0.5 rounded text-xs font-bold bg-amber-100 text-amber-800';
    }

    // Telemetry snapshot
    const snap = item.telemetrySnapshot || {};
    if (elMq2) elMq2.innerText = (snap.mq2Value || 562) + ' ppm';
    if (elTiltX) elTiltX.innerText = (snap.tiltX || 0).toFixed(2) + '°';
    if (elTiltY) elTiltY.innerText = (snap.tiltY || 0).toFixed(2) + '°';
    if (elLight) elLight.innerText = snap.ldrValue === 1 ? 'Dark (Streetlight ON)' : 'Daylight (Streetlight OFF)';

    // Image Evidence & Download Link
    const btnModalDl = document.getElementById('btn-modal-download-evidence');
    if (item.imageUrl && item.imageUrl.length > 50) {
      if (elImg) {
        elImg.src = item.imageUrl;
        elImg.classList.remove('hidden');
      }
      if (elNoImg) elNoImg.classList.add('hidden');
      if (btnModalDl) {
        btnModalDl.href = item.imageUrl;
        btnModalDl.download = `smartpole-evidence-${item.id}.jpg`;
        btnModalDl.classList.remove('hidden');
      }
    } else {
      if (elImg) elImg.classList.add('hidden');
      if (elNoImg) elNoImg.classList.remove('hidden');
      if (btnModalDl) btnModalDl.classList.add('hidden');
    }

    if (modal) modal.classList.remove('hidden');
    if (window.lucide) window.lucide.createIcons();
  };

  window.deleteIncident = async function (caseId) {
    if (!confirm(`Delete incident log "${caseId}" permanently?`)) return;
    try {
      const res = await fetch(`/api/incidents/${caseId}`, { method: 'DELETE' });
      if (res.ok) {
        state.incidents = state.incidents.filter(i => i.id !== caseId);
        const modal = document.getElementById('modal-incident-details');
        if (modal) modal.classList.add('hidden');
        renderAlertsTable();
        renderCriticalAlertsTable();
        renderCameraGallery();
        renderGasTable();
        renderSosTable();
        updateKPICounters();
      }
    } catch (e) {
      showToast('Delete failed: ' + e.message, 'error');
    }
  };

  window.deleteIncidentPhoto = async function (caseId) {
    if (!confirm(`Delete evidence photo for incident "${caseId}"?`)) return;
    try {
      const res = await fetch(`/api/incidents/${caseId}/photo`, { method: 'DELETE' });
      if (res.ok) {
        const item = state.incidents.find(i => i.id === caseId);
        if (item) item.imageUrl = '';
        if (state.selectedIncident && state.selectedIncident.id === caseId) {
          state.selectedIncident.imageUrl = '';
          window.viewIncidentDetails(caseId);
        }
        renderCameraGallery();
      }
    } catch (e) {
      showToast('Delete photo failed: ' + e.message, 'error');
    }
  };

  function setupModalHandlers() {
    const modal = document.getElementById('modal-incident-details');
    const btnClose = document.getElementById('btn-close-modal');
    const btnAck = document.getElementById('btn-modal-ack');
    const btnResolve = document.getElementById('btn-modal-resolve');
    const btnDelLog = document.getElementById('btn-modal-delete-log');
    const btnDelPhoto = document.getElementById('btn-modal-delete-photo');

    // Emergency Alert Panel (Old Type) handlers
    const btnDismissEmerg = document.getElementById('dismiss-emergency-btn');
    const btnCloseEmerg = document.getElementById('btn-close-emergency-panel');
    if (btnDismissEmerg) btnDismissEmerg.addEventListener('click', dismissEmergencyPanel);
    if (btnCloseEmerg) btnCloseEmerg.addEventListener('click', () => {
      const panel = document.getElementById('active-emergency-panel');
      if (panel) panel.classList.add('hidden');
    });

    if (btnClose && modal) {
      btnClose.addEventListener('click', () => modal.classList.add('hidden'));
    }

    if (btnDelLog) {
      btnDelLog.addEventListener('click', () => {
        if (!state.selectedIncident) return;
        window.deleteIncident(state.selectedIncident.id);
      });
    }

    if (btnDelPhoto) {
      btnDelPhoto.addEventListener('click', () => {
        if (!state.selectedIncident) return;
        window.deleteIncidentPhoto(state.selectedIncident.id);
      });
    }

    if (btnAck) {
      btnAck.addEventListener('click', async () => {
        if (!state.selectedIncident) return;
        const user = getCurrentUser();
        try {
          await fetch(`/api/incidents/${state.selectedIncident.id}/ack`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user })
          });
        } catch (_) { }
        state.selectedIncident.status = 'Acknowledged';
        state.selectedIncident.acknowledgedBy = user;
        mergeIncidents([state.selectedIncident]);
        window.viewIncidentDetails(state.selectedIncident.id);
      });
    }

    if (btnResolve) {
      btnResolve.addEventListener('click', async () => {
        if (!state.selectedIncident) return;
        const user = getCurrentUser();
        try {
          await fetch(`/api/incidents/${state.selectedIncident.id}/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user })
          });
        } catch (_) { }
        state.selectedIncident.status = 'Resolved';
        state.selectedIncident.resolvedBy = user;
        mergeIncidents([state.selectedIncident]);
        window.viewIncidentDetails(state.selectedIncident.id);
      });
    }
  }

  // ========================================================
  // 6. LEAFLET MAPS INTEGRATION (PULSING BLIP & DYNAMIC GPS)
  // ========================================================
  function initMaps() {
    if (typeof L === 'undefined') {
      console.warn('[Leaflet] Library not found.');
      return;
    }

    const curLat = state.hardware.gps?.lat || 12.971599;
    const curLng = state.hardware.gps?.lng || 77.594563;

    const POLES = [
      { id: 'POLE-01', name: 'Smart Pole #01 (Live IoT Node)', lat: curLat, lng: curLng, status: 'Normal' }
    ];

    // 1. Overview Tab Map
    const overviewContainer = document.getElementById('overview-map');
    if (overviewContainer && !state.overviewMap) {
      state.overviewMap = L.map('overview-map').setView([curLat, curLng], 15);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors'
      }).addTo(state.overviewMap);

      POLES.forEach(pole => addPoleMarker(state.overviewMap, pole));
    }

    // 2. Full Locations Tab Map
    const fullContainer = document.getElementById('full-locations-map');
    if (fullContainer && !state.fullMap) {
      state.fullMap = L.map('full-locations-map').setView([curLat, curLng], 16);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors'
      }).addTo(state.fullMap);

      POLES.forEach(pole => addPoleMarker(state.fullMap, pole));
    }
  }

  function addPoleMarker(mapInstance, pole) {
    const isCritical = pole.status === 'Critical' || state.hardware.isTilted || state.hardware.accident || state.hardware.sos;
    const isWarning = pole.status === 'Warning';
    const ringColor = isCritical ? 'bg-red-500' : (isWarning ? 'bg-amber-500' : 'bg-blue-500');
    const dotColor = isCritical ? 'bg-red-600' : (isWarning ? 'bg-amber-600' : 'bg-blue-600');

    const customIcon = L.divIcon({
      className: 'custom-gps-blip',
      html: `
        <div class="relative flex items-center justify-center w-8 h-8">
          <span class="absolute w-8 h-8 rounded-full ${ringColor} opacity-40 animate-ping"></span>
          <span class="relative w-4 h-4 rounded-full ${dotColor} border-2 border-white shadow-md flex items-center justify-center">
            <span class="w-1.5 h-1.5 rounded-full bg-white"></span>
          </span>
        </div>
      `,
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });

    const marker = L.marker([pole.lat, pole.lng], { icon: customIcon }).addTo(mapInstance);
    marker.bindPopup(`
      <div style="font-family: Inter, sans-serif; font-size: 12px; padding: 4px; min-width: 170px;">
        <p style="font-weight: 700; margin: 0 0 4px 0; color: #0f172a;">${pole.name}</p>
        <p style="margin: 0; color: #64748b;">Status: <strong style="color: ${isCritical ? '#dc2626' : '#16a34a'}">${isCritical ? 'CRITICAL ALERT' : 'Normal / Operational'}</strong></p>
        <p style="margin: 4px 0 0 0; color: #0284c7; font-family: monospace; font-size: 11px;">
          GPS: ${pole.lat.toFixed(6)}, ${pole.lng.toFixed(6)}
        </p>
        <a href="https://maps.google.com/?q=${pole.lat.toFixed(6)},${pole.lng.toFixed(6)}" target="_blank" rel="noopener noreferrer" style="display:inline-block; margin-top:6px; color:#2563eb; font-size:11px; font-weight:600; text-decoration:underline;">Open in Google Maps ↗</a>
      </div>
    `);

    if (!state.poleMarkers[pole.id]) state.poleMarkers[pole.id] = [];
    state.poleMarkers[pole.id].push(marker);
  }

  function updateHardwareMarker() {
    const hw = state.hardware;
    if (!state.poleMarkers['POLE-01']) return;

    state.poleMarkers['POLE-01'].forEach(marker => {
      marker.setLatLng([hw.gps.lat, hw.gps.lng]);
    });

    // Update GPS Location Tab info cards & Google Maps link
    const elStatus = document.getElementById('gps-tab-status');
    const elLat = document.getElementById('gps-tab-lat');
    const elLng = document.getElementById('gps-tab-lng');
    const elTime = document.getElementById('gps-tab-time');
    const elLink = document.getElementById('btn-open-google-maps');

    if (elStatus) elStatus.innerText = 'Live 3D Fix (Active)';
    if (elLat) elLat.innerText = `${hw.gps.lat.toFixed(6)}° N`;
    if (elLng) elLng.innerText = `${hw.gps.lng.toFixed(6)}° E`;
    if (elTime) elTime.innerText = new Date().toLocaleTimeString();
    if (elLink) elLink.href = `https://maps.google.com/?q=${hw.gps.lat.toFixed(6)},${hw.gps.lng.toFixed(6)}`;
  }

  // ========================================================
  // 7. CONTROLS, CAMERA & IP SETTINGS
  // ========================================================
  function setupControls() {
    // Refresh Camera Stream button
    const btnRefCam = document.getElementById('btn-refresh-stream');
    const camImg = document.getElementById('live-cam-img');
    if (btnRefCam && camImg) {
      btnRefCam.addEventListener('click', () => {
        camImg.src = '/api/camera-stream?t=' + Date.now();
      });
    }

    // Capture Snapshot button
    const btnCapture = document.getElementById('btn-capture-snapshot');
    const btnManualScan = document.getElementById('btn-manual-camera-scan');
    const handleSnap = async () => {
      try {
        const res = await fetch('/api/camera-capture');
        if (res.ok) {
          showToast('Snapshot captured and logged to camera evidence.', 'success');
          fetchIncidents();
        } else {
          showToast('Camera capture failed. Ensure ESP32-CAM is online.', 'error');
        }
      } catch (e) {
        showToast('Capture error: ' + e.message, 'error');
      }
    };
    if (btnCapture) btnCapture.addEventListener('click', handleSnap);

    // Manual On-Demand AI Multi-Model Scan (Fire, Smoke & Collision)
    if (btnManualScan) {
      btnManualScan.addEventListener('click', async () => {
        const origContent = btnManualScan.innerHTML;
        btnManualScan.disabled = true;
        btnManualScan.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span>Scanning Fire & Collision...</span>';
        if (window.lucide) window.lucide.createIcons();

        try {
          if (!camImg || !camImg.complete || !camImg.naturalWidth) {
            showToast('Camera feed unavailable — ensure ESP32-CAM is online.', 'error');
            return;
          }
          const canvas = document.createElement('canvas');
          canvas.width = 480;
          canvas.height = 320;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(camImg, 0, 0, 480, 320);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

          const [fireRes, accRes] = await Promise.all([
            fetch('/api/roboflow/check-frame', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ image: dataUrl })
            }).then(r => r.json()).catch(e => ({ predictions: [], error: e.message })),
            fetch('/api/roboflow/check-accident', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ image: dataUrl })
            }).then(r => r.json()).catch(e => ({ predictions: [], error: e.message }))
          ]);

          const fireCount = (fireRes.predictions || []).length;
          const accCount = (accRes.predictions || []).length;

          if (fireCount > 0 && accCount > 0) {
            showToast(`AI Alert: Detected ${fireCount} flame/smoke & ${accCount} collision hazard!`, 'error');
          } else if (fireCount > 0) {
            const p = fireRes.predictions[0];
            showToast(`AI Alert: ${p.class} Detected (${Math.round(p.confidence * 100)}%)!`, 'error');
          } else if (accCount > 0) {
            showToast(`AI Alert: Vehicle Collision Detected!`, 'error');
          } else {
            showToast('AI Model Scan Complete: Scene clear (No fire or collision detected).', 'success');
          }
          fetchIncidents();
        } catch (e) {
          showToast('Scan error: ' + e.message, 'error');
        } finally {
          btnManualScan.disabled = false;
          btnManualScan.innerHTML = origContent;
          if (window.lucide) window.lucide.createIcons();
        }
      });
    }

    // Video Recording Button (Manual CCTV Recording Toggle)
    const btnRecord = document.getElementById('btn-record-video');
    if (btnRecord) {
      btnRecord.addEventListener('click', () => {
        if (isRecording) {
          stopRecording();
        } else {
          startRecording();
        }
      });
    }

    // Automatic Autonomous AI Surveillance (Fire & Accident Dual-Engine)
    // Continuously monitors live camera feed, alternating between Fire and Accident scans every 3 seconds
    let autoScanStep = 0;
    setInterval(() => {
      if (!camImg || !camImg.complete || !camImg.naturalWidth) return;

      // Skip background frame dispatch if emergency panel or details modal is open
      const modal = document.getElementById('modal-incident-details');
      const panel = document.getElementById('active-emergency-panel');
      if ((modal && !modal.classList.contains('hidden')) || (panel && !panel.classList.contains('hidden'))) return;

      try {
        const canvas = document.createElement('canvas');
        canvas.width = 480;
        canvas.height = 320;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(camImg, 0, 0, 480, 320);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.80);

        if (autoScanStep % 2 === 0) {
          // Scan for Fire / Smoke
          fetch('/api/roboflow/check-frame', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: dataUrl })
          })
          .then(r => r.json())
          .then(d => {
            if (d.predictions && d.predictions.length > 0) {
              fetchIncidents();
            }
          })
          .catch(() => {});
        } else {
          // Scan for Vehicle Accidents
          fetch('/api/roboflow/check-accident', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: dataUrl })
          })
          .then(r => r.json())
          .then(d => {
            if (d.predictions && d.predictions.length > 0) {
              fetchIncidents();
            }
          })
          .catch(() => {});
        }
        autoScanStep++;
      } catch (_) {}
    }, 3000);

    // Unified System Configuration: Save Pole & Camera IP
    const inputPole = document.getElementById('settings-pole-ip');
    const inputCam = document.getElementById('settings-cam-ip');
    const btnSaveAllSettings = document.getElementById('btn-save-all-settings');
    const btnCancelSettings = document.getElementById('btn-cancel-settings');

    if (btnSaveAllSettings) {
      btnSaveAllSettings.addEventListener('click', async () => {
        const poleIp = inputPole ? inputPole.value.trim() : '';
        const camIp = inputCam ? inputCam.value.trim() : '';
        if (!poleIp && !camIp) {
          showToast('Please enter a valid IP address.', 'warning');
          return;
        }
        btnSaveAllSettings.disabled = true;
        const origText = btnSaveAllSettings.innerHTML;
        btnSaveAllSettings.innerHTML = '<span>Saving...</span>';
        try {
          const res = await fetch('/api/settings/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ poleIp, camIp })
          });
          const d = await res.json();
          if (d.success) {
            showToast('System configuration & network settings saved!', 'success');
            const topEsp = document.getElementById('top-esp-host');
            const topCam = document.getElementById('top-cam-host');
            if (topEsp && d.poleHost) topEsp.innerText = d.poleHost;
            if (topCam && d.camHost) topCam.innerText = d.camHost;
            if (camImg) camImg.src = '/api/camera-stream?t=' + Date.now();
          } else {
            showToast(d.error || 'Failed to save settings.', 'error');
          }
        } catch (e) {
          showToast('Error saving settings: ' + e.message, 'error');
        } finally {
          btnSaveAllSettings.disabled = false;
          btnSaveAllSettings.innerHTML = origText;
          if (window.lucide) window.lucide.createIcons();
        }
      });
    }

    if (btnCancelSettings) {
      btnCancelSettings.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/config');
          const d = await res.json();
          if (inputPole && d.poleHost) inputPole.value = d.poleHost;
          if (inputCam && d.camHost) inputCam.value = d.camHost;
          showToast('Settings reverted to active configuration.', 'info');
        } catch (_) {
          showToast('Reverted settings.', 'info');
        }
      });
    }

    // Calibrate Tilt Baseline button
    const btnCalibrateTilt = document.getElementById('btn-calibrate-tilt');
    if (btnCalibrateTilt) {
      btnCalibrateTilt.addEventListener('click', async () => {
        const origContent = btnCalibrateTilt.innerHTML;
        btnCalibrateTilt.disabled = true;
        btnCalibrateTilt.innerHTML = '<span>Calibrating...</span>';
        try {
          const res = await fetch('/api/pole/calibrate-tilt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threshold: 8.0 })
          });
          const d = await res.json();
          if (d.success) {
            showToast(`Pole tilt calibrated! Baseline zeroed at X=${d.baselineTiltX.toFixed(1)}°, Y=${d.baselineTiltY.toFixed(1)}° (Threshold: ${d.threshold.toFixed(1)}°)`, 'success');
          } else {
            showToast('Tilt calibration failed', 'error');
          }
        } catch (err) {
          showToast('Could not reach pole server for calibration', 'error');
        } finally {
          btnCalibrateTilt.disabled = false;
          btnCalibrateTilt.innerHTML = origContent;
          if (window.lucide) window.lucide.createIcons();
        }
      });
    }

    // Table filter tabs
    const filterBtns = document.querySelectorAll('.table-filter-btn');
    filterBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        filterBtns.forEach(b => {
          b.classList.remove('active', 'bg-slate-100', 'text-navy-900');
          b.classList.add('text-slate-600');
        });
        btn.classList.add('active', 'bg-slate-100', 'text-navy-900');
        btn.classList.remove('text-slate-600');

        state.filterSeverity = btn.getAttribute('data-filter') || 'all';
        renderAlertsTable();
      });
    });

    // Theme Switcher Logic (Dark / Light mode)
    const btnThemeToggle = document.getElementById('btn-theme-toggle');
    const btnDashThemeToggle = document.getElementById('btn-dash-theme-toggle');

    function applyTheme(isDark) {
      if (isDark) {
        document.documentElement.classList.add('dark');
        localStorage.setItem('smartpole-theme', 'dark');
      } else {
        document.documentElement.classList.remove('dark');
        localStorage.setItem('smartpole-theme', 'light');
      }
      const iconName = isDark ? 'sun' : 'moon';
      const icon1 = document.getElementById('theme-icon');
      const icon2 = document.getElementById('dash-theme-icon');
      if (icon1) icon1.setAttribute('data-lucide', iconName);
      if (icon2) icon2.setAttribute('data-lucide', iconName);
      if (window.lucide) window.lucide.createIcons();
    }

    const savedTheme = localStorage.getItem('smartpole-theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const initialDark = savedTheme ? savedTheme === 'dark' : prefersDark;
    applyTheme(initialDark);

    const toggleTheme = () => {
      const currentDark = document.documentElement.classList.contains('dark');
      applyTheme(!currentDark);
    };

    if (btnThemeToggle) btnThemeToggle.addEventListener('click', toggleTheme);
    if (btnDashThemeToggle) btnDashThemeToggle.addEventListener('click', toggleTheme);

    // Sorting State & Controller
    function setSorting(field, order) {
      state.sortField = field;
      state.sortOrder = order;

      // Synchronize all sort dropdown elements
      const sortVal = `${field}-${order}`;
      const sel1 = document.getElementById('select-incident-sort');
      const sel2 = document.getElementById('select-emergency-sort');
      const sel3 = document.getElementById('select-sos-sort');
      if (sel1) sel1.value = sortVal;
      if (sel2) sel2.value = sortVal;
      if (sel3) sel3.value = sortVal;

      // Update sort arrow icons
      const updateIcon = (iconId, activeField) => {
        const icon = document.getElementById(iconId);
        if (!icon) return;
        if (state.sortField === activeField) {
          icon.setAttribute('data-lucide', state.sortOrder === 'asc' ? 'arrow-up' : 'arrow-down');
          icon.classList.add('text-blue-600');
          icon.classList.remove('text-slate-400');
        } else {
          icon.setAttribute('data-lucide', 'arrow-up-down');
          icon.classList.remove('text-blue-600');
          icon.classList.add('text-slate-400');
        }
      };
      updateIcon('sort-icon-id', 'id');
      updateIcon('sort-icon-time', 'date');

      renderAlertsTable();
      renderCriticalAlertsTable();
      renderSosTable();
      renderCameraGallery();
      renderGasTable();
      if (window.lucide) window.lucide.createIcons();
    }

    // Sort Dropdown Change Listeners
    ['select-incident-sort', 'select-emergency-sort', 'select-sos-sort'].forEach(id => {
      const sel = document.getElementById(id);
      if (sel) {
        sel.addEventListener('change', (e) => {
          const parts = e.target.value.split('-');
          setSorting(parts[0], parts[1]);
        });
      }
    });

    // Sortable Column Headers
    const bindSortHeader = (elemId, field) => {
      const el = document.getElementById(elemId);
      if (el) {
        el.addEventListener('click', () => {
          const nextOrder = (state.sortField === field && state.sortOrder === 'desc') ? 'asc' : 'desc';
          setSorting(field, nextOrder);
        });
      }
    };
    bindSortHeader('th-sort-id', 'id');
    bindSortHeader('th-sort-time', 'date');
    bindSortHeader('th-emergency-sort-id', 'id');
    bindSortHeader('th-emergency-sort-time', 'date');
    bindSortHeader('th-sos-sort-id', 'id');
    bindSortHeader('th-sos-sort-time', 'date');

    // Data Management: Purge Evidence Photos (Requires Admin Password)
    const btnClearPhotos = document.getElementById('btn-clear-photos');
    if (btnClearPhotos) {
      btnClearPhotos.addEventListener('click', async () => {
        const pwd = window.prompt(
          "⚠️ SECURITY CONFIRMATION\n\nPurging evidence photos will permanently delete all camera JPEG snapshots from local memory and Firebase RTDB.\nTelemetry and case logs will remain.\n\nEnter current Admin Password to proceed:"
        );
        if (pwd === null) return; // User cancelled
        if (!pwd.trim()) {
          showToast('Admin password is required to purge evidence.', 'warning');
          return;
        }
        try {
          const res = await fetch('/api/incidents/clear-photos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pwd.trim(), user: getCurrentUser() })
          });
          const d = await res.json();
          if (!res.ok || !d.success) {
            showToast(d.error || 'Authentication failed: Invalid admin password.', 'error');
            return;
          }
          showToast(`Successfully purged ${d.count || 0} evidence photos.`, 'success');
          fetchIncidents();
        } catch (e) {
          showToast('Purge failed: ' + e.message, 'error');
        }
      });
    }

    // Data Management: Clear All Incident Logs (Requires Admin Password)
    const btnClearAllLogs = document.getElementById('btn-clear-all-logs');
    if (btnClearAllLogs) {
      btnClearAllLogs.addEventListener('click', async () => {
        const pwd = window.prompt(
          "🚨 CRITICAL DATA DESTRUCTION WARNING\n\nThis will permanently delete ALL incident logs, civic distress cases, and audit trails from both the local server and Firebase RTDB cloud.\nThis action cannot be undone.\n\nEnter current Admin Password to proceed:"
        );
        if (pwd === null) return; // User cancelled
        if (!pwd.trim()) {
          showToast('Admin password is required to erase incident logs.', 'warning');
          return;
        }
        try {
          const res = await fetch('/api/incidents/clear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pwd.trim(), user: getCurrentUser() })
          });
          const d = await res.json();
          if (!res.ok || !d.success) {
            showToast(d.error || 'Authentication failed: Invalid admin password.', 'error');
            return;
          }
          state.incidents = [];
          renderAlertsTable();
          renderCriticalAlertsTable();
          renderCameraGallery();
          renderGasTable();
          renderSosTable();
          updateKPICounters();
          showToast('All incident logs permanently erased.', 'info');
        } catch (e) {
          showToast('Clear failed: ' + e.message, 'error');
        }
      });
    }

    // ========================================================
    // TILT CALIBRATION CONTROLS & BASELINE SYNC
    // ========================================================
    async function fetchCalibrationData() {
      try {
        const res = await fetch('/api/pole/calibration');
        if (res.ok) {
          const cal = await res.json();
          const baseElX = document.getElementById('cal-base-x');
          const baseElY = document.getElementById('cal-base-y');
          const dateEl = document.getElementById('cal-date-time');
          const statusText = document.getElementById('cal-status-text');
          const selectThresh = document.getElementById('select-tilt-threshold');

          if (baseElX && cal.baselineTiltX !== undefined) baseElX.innerText = Number(cal.baselineTiltX).toFixed(2) + '°';
          if (baseElY && cal.baselineTiltY !== undefined) baseElY.innerText = Number(cal.baselineTiltY).toFixed(2) + '°';
          if (dateEl && cal.calibratedAt) dateEl.innerText = new Date(cal.calibratedAt).toLocaleString();
          if (statusText) statusText.innerText = cal.status === 'calibrated' ? 'Calibrated Baseline Active' : 'Uncalibrated / Factory Zero';
          if (selectThresh && cal.tiltThreshold) selectThresh.value = Number(cal.tiltThreshold).toFixed(1);
        }
      } catch (_) {}
    }

    function setupCalibrationControls() {
      const btnStart = document.getElementById('btn-start-calibration-flow');
      const btnReset = document.getElementById('btn-reset-calibration');
      const btnSaveThresh = document.getElementById('btn-save-threshold');
      const selectThresh = document.getElementById('select-tilt-threshold');
      const progContainer = document.getElementById('cal-progress-container');
      const progBar = document.getElementById('cal-progress-bar');
      const progPct = document.getElementById('cal-progress-pct');
      const progLabel = document.getElementById('cal-progress-label');

      if (btnStart) {
        btnStart.addEventListener('click', async () => {
          const ok = confirm("Ensure the pole is stationary in its normal upright position.\n\nThe system will collect 20 noise-filtered samples over ~3 seconds to compute the zero baseline.\n\nProceed with calibration?");
          if (!ok) return;

          btnStart.disabled = true;
          btnStart.classList.add('opacity-60', 'cursor-not-allowed');
          if (progContainer) progContainer.classList.remove('hidden');
          if (progLabel) progLabel.innerText = "Sampling sensor stability (20 samples)...";

          let pct = 0;
          const progressTimer = setInterval(() => {
            pct += 5;
            if (pct > 95) pct = 95;
            if (progBar) progBar.style.width = pct + '%';
            if (progPct) progPct.innerText = pct + '%';
          }, 120);

          try {
            const res = await fetch('/api/pole/calibrate-start', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ samples: 20 })
            });
            clearInterval(progressTimer);

            if (progBar) progBar.style.width = '100%';
            if (progPct) progPct.innerText = '100%';

            const data = await res.json();
            if (data.success) {
              showToast(`Calibration Successful! Baseline zeroed at X=${data.baselineTiltX.toFixed(2)}°, Y=${data.baselineTiltY.toFixed(2)}° (Jitter: ${data.jitterX.toFixed(2)}° / ${data.jitterY.toFixed(2)}°)`, 'success');
              fetchCalibrationData();
            } else {
              showToast(`Calibration Failed: ${data.error || 'Unknown error'}`, 'error');
            }
          } catch (err) {
            clearInterval(progressTimer);
            showToast(`Calibration error: ${err.message}`, 'error');
          } finally {
            setTimeout(() => {
              if (progContainer) progContainer.classList.add('hidden');
              if (progBar) progBar.style.width = '0%';
              if (progPct) progPct.innerText = '0%';
              btnStart.disabled = false;
              btnStart.classList.remove('opacity-60', 'cursor-not-allowed');
            }, 800);
          }
        });
      }

      if (btnReset) {
        btnReset.addEventListener('click', async () => {
          if (!confirm("Reset tilt calibration baseline back to factory 0.0°, 0.0°?")) return;
          try {
            const res = await fetch('/api/pole/calibrate-reset', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
              showToast('Calibration baseline reset to factory 0,0.', 'info');
              fetchCalibrationData();
            }
          } catch (err) {
            showToast('Could not reset calibration: ' + err.message, 'error');
          }
        });
      }

      if (btnSaveThresh && selectThresh) {
        btnSaveThresh.addEventListener('click', async () => {
          const threshold = parseFloat(selectThresh.value);
          try {
            const res = await fetch('/api/pole/set-tilt-threshold', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ threshold })
            });
            const data = await res.json();
            if (data.success) {
              showToast(`Tilt threshold updated to ±${threshold.toFixed(1)}°`, 'success');
              fetchCalibrationData();
            }
          } catch (err) {
            showToast('Could not save threshold: ' + err.message, 'error');
          }
        });
      }
    }
    setupCalibrationControls();

    // ========================================================
    // OFFICER PROFILE & MUNICIPAL USER APPROVALS
    // ========================================================
    async function loadProfileAndUsers() {
      const sessionStr = localStorage.getItem('smartpole_auth_session') || sessionStorage.getItem('smartpole_auth_session') || localStorage.getItem('smartpole_user') || sessionStorage.getItem('smartpole_user');
      let user = null;
      try {
        if (sessionStr) user = JSON.parse(sessionStr);
      } catch (_) {}

      const nameEl = document.getElementById('profile-name');
      const emailEl = document.getElementById('profile-email');
      const roleBadge = document.getElementById('profile-badge-role');
      const avatarEl = document.getElementById('profile-avatar');
      const statusEl = document.getElementById('profile-status');
      const sessionTimeEl = document.getElementById('profile-session-time');

      if (user) {
        if (nameEl) nameEl.innerText = user.name || user.email || 'Municipal Officer';
        if (emailEl) emailEl.innerText = user.email || 'officer@smartpole.gov';
        if (roleBadge) roleBadge.innerText = (user.role || 'Operator').toUpperCase();
        if (avatarEl) avatarEl.innerText = (user.name || user.email || 'O').charAt(0).toUpperCase();
        if (statusEl) statusEl.innerText = user.status === 'approved' || !user.status ? 'Active & Approved' : 'Pending Authorization';
        if (sessionTimeEl && user.loginTime) sessionTimeEl.innerText = new Date(user.loginTime).toLocaleTimeString();
      }

      const tableBody = document.getElementById('table-users-body');
      if (!tableBody) return;

      try {
        const res = await fetch('/api/auth/users');
        if (res.ok) {
          const d = await res.json();
          const users = d.users || [];
          if (users.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="5" class="py-4 text-center text-slate-400">No registered officer records found.</td></tr>`;
            return;
          }

          tableBody.innerHTML = users.map(u => {
            const isApproved = u.status === 'approved';
            const statusBadge = isApproved
              ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">Approved</span>`
              : `<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">Pending</span>`;

            const approveBtn = !isApproved
              ? `<button onclick="approveOfficer('${u.email}', '${u.role || 'operator'}')" class="px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white transition">Approve</button>`
              : `<span class="text-xs text-slate-400">Verified</span>`;

            return `
              <tr class="hover:bg-slate-50/70 transition">
                <td class="py-3 px-4 font-semibold text-navy-900">${u.name || u.email.split('@')[0]}</td>
                <td class="py-3 px-4 font-mono text-slate-500">${u.email}</td>
                <td class="py-3 px-4 capitalize font-medium text-slate-700">${u.role || 'operator'}</td>
                <td class="py-3 px-4">${statusBadge}</td>
                <td class="py-3 px-4 text-right">${approveBtn}</td>
              </tr>
            `;
          }).join('');
        } else {
          tableBody.innerHTML = `<tr><td colspan="5" class="py-4 text-center text-slate-400">User directory access restricted or unavailable.</td></tr>`;
        }
      } catch (e) {
        tableBody.innerHTML = `<tr><td colspan="5" class="py-4 text-center text-red-500">Failed to load officer list: ${e.message}</td></tr>`;
      }
    }

    window.approveOfficer = async (email, role) => {
      try {
        const res = await fetch('/api/auth/approve-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, role, status: 'approved' })
        });
        const d = await res.json();
        if (d.success) {
          showToast(`Officer ${email} approved!`, 'success');
          loadProfileAndUsers();
        } else {
          showToast(d.error || 'Approval failed', 'error');
        }
      } catch (e) {
        showToast('Error approving user: ' + e.message, 'error');
      }
    };

    const btnProfileLogout = document.getElementById('btn-profile-logout');
    if (btnProfileLogout) {
      btnProfileLogout.addEventListener('click', () => {
        localStorage.removeItem('smartpole_auth_session');
        sessionStorage.removeItem('smartpole_auth_session');
        localStorage.removeItem('smartpole_user');
        sessionStorage.removeItem('smartpole_user');
        showToast('Signed out successfully.', 'info');
        setTimeout(() => {
          window.location.href = 'login.html';
        }, 400);
      });
    }

    const btnRefreshUsers = document.getElementById('btn-refresh-users');
    if (btnRefreshUsers) {
      btnRefreshUsers.addEventListener('click', () => {
        loadProfileAndUsers();
      });
    }

    // User Access Portal (Sign In / Sign Up) Logic
    function setupLandingAuth() {
      const tabSignIn = document.getElementById('tab-btn-signin');
      const tabSignUp = document.getElementById('tab-btn-signup');
      const formSignIn = document.getElementById('form-landing-signin');
      const formSignUp = document.getElementById('form-landing-signup');
      const profileCard = document.getElementById('landing-user-profile-card');
      const authTabBar = document.getElementById('auth-tab-bar');
      const navUserLabel = document.getElementById('nav-user-label');
      const btnLogout = document.getElementById('btn-landing-logout');

      function updateAuthUI(user) {
        if (user && user.email) {
          if (formSignIn) formSignIn.classList.add('hidden');
          if (formSignUp) formSignUp.classList.add('hidden');
          if (authTabBar) authTabBar.classList.add('hidden');
          if (profileCard) {
            profileCard.classList.remove('hidden');
            const nameEl = document.getElementById('landing-user-name');
            const emailEl = document.getElementById('landing-user-email');
            const roleEl = document.getElementById('landing-user-role');
            const avatarEl = document.getElementById('landing-user-avatar');
            if (nameEl) nameEl.textContent = user.name || user.email;
            if (emailEl) emailEl.textContent = user.email;
            if (roleEl) roleEl.textContent = user.role || 'Operator';
            if (avatarEl) avatarEl.textContent = (user.name || user.email || 'U').charAt(0).toUpperCase();
          }
          if (navUserLabel) navUserLabel.textContent = user.name ? user.name.split(' ')[0] : 'Account';
        } else {
          if (profileCard) profileCard.classList.add('hidden');
          if (authTabBar) authTabBar.classList.remove('hidden');
          showTab('signin');
          if (navUserLabel) navUserLabel.textContent = 'Sign In';
        }
      }

      function showTab(tab) {
        if (tab === 'signin') {
          if (formSignIn) formSignIn.classList.remove('hidden');
          if (formSignUp) formSignUp.classList.add('hidden');
          if (tabSignIn) {
            tabSignIn.className = 'flex-1 py-2 text-xs font-semibold rounded-lg bg-white text-navy-900 shadow-sm transition';
          }
          if (tabSignUp) {
            tabSignUp.className = 'flex-1 py-2 text-xs font-semibold rounded-lg text-slate-500 hover:text-slate-800 transition';
          }
        } else {
          if (formSignIn) formSignIn.classList.add('hidden');
          if (formSignUp) formSignUp.classList.remove('hidden');
          if (tabSignUp) {
            tabSignUp.className = 'flex-1 py-2 text-xs font-semibold rounded-lg bg-white text-navy-900 shadow-sm transition';
          }
          if (tabSignIn) {
            tabSignIn.className = 'flex-1 py-2 text-xs font-semibold rounded-lg text-slate-500 hover:text-slate-800 transition';
          }
        }
      }

      if (tabSignIn) tabSignIn.addEventListener('click', () => showTab('signin'));
      if (tabSignUp) tabSignUp.addEventListener('click', () => showTab('signup'));

      // Handle Sign In Submit
      if (formSignIn) {
        formSignIn.addEventListener('submit', async (e) => {
          e.preventDefault();
          const email = document.getElementById('signin-email')?.value.trim();
          const password = document.getElementById('signin-password')?.value;
          const btn = document.getElementById('btn-submit-signin');
          const origText = btn ? btn.textContent : '';

          if (!email || !password) return;

          if (btn) {
            btn.disabled = true;
            btn.textContent = 'Signing in...';
          }

          try {
            const res = await fetch('/api/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email, password })
            });
            const d = await res.json();
            if (d.success && d.user) {
              const u = d.user;
              localStorage.setItem('smartpole_user', JSON.stringify(u));
              localStorage.setItem('smartpole_auth_session', JSON.stringify(u));
              updateAuthUI(u);
              if (u.status === 'pending_approval') {
                showToast(`Account registered for ${u.name}! Pending Municipal Admin Authorization.`, 'info');
              } else {
                showToast(`Signed in as ${u.name || u.email}`, 'success');
                setTimeout(() => { window.location.hash = '#dashboard'; }, 400);
              }
            } else {
              showToast(d.error || 'Authentication failed', 'error');
            }
          } catch (err) {
            console.error('[Auth] Sign in error:', err);
            showToast('Could not connect to auth service', 'error');
          } finally {
            if (btn) {
              btn.disabled = false;
              btn.textContent = origText;
            }
          }
        });
      }

      // Handle Sign Up Submit
      if (formSignUp) {
        formSignUp.addEventListener('submit', async (e) => {
          e.preventDefault();
          const name = document.getElementById('signup-name')?.value.trim();
          const email = document.getElementById('signup-email')?.value.trim();
          const password = document.getElementById('signup-password')?.value;
          const role = document.getElementById('signup-role')?.value || 'Operator';
          const btn = document.getElementById('btn-submit-signup');
          const origText = btn ? btn.textContent : '';

          if (!name || !email || !password) return;

          if (btn) {
            btn.disabled = true;
            btn.textContent = 'Creating account...';
          }

          try {
            const res = await fetch('/api/auth/register', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name, email, password, role })
            });
            const d = await res.json();
            if (d.success && d.user) {
              const u = d.user;
              localStorage.setItem('smartpole_user', JSON.stringify(u));
              localStorage.setItem('smartpole_auth_session', JSON.stringify(u));
              updateAuthUI(u);
              if (u.status === 'pending_approval') {
                showToast(`Account registered for ${u.name}! Pending Municipal Admin Approval.`, 'info');
              } else {
                showToast(`Account registered for ${u.name}!`, 'success');
                setTimeout(() => { window.location.hash = '#dashboard'; }, 400);
              }
            } else {
              showToast(d.error || 'Registration failed', 'error');
            }
          } catch (err) {
            console.error('[Auth] Registration error:', err);
            showToast('Could not register account', 'error');
          } finally {
            if (btn) {
              btn.disabled = false;
              btn.textContent = origText;
            }
          }
        });
      }

      // Handle Sign Out
      if (btnLogout) {
        btnLogout.addEventListener('click', () => {
          localStorage.removeItem('smartpole_user');
          sessionStorage.removeItem('smartpole_user');
          localStorage.removeItem('smartpole_auth_session');
          sessionStorage.removeItem('smartpole_auth_session');
          updateAuthUI(null);
          showToast('You have signed out', 'info');
        });
      }

      // Initialize state
      try {
        const stored = localStorage.getItem('smartpole_user') || sessionStorage.getItem('smartpole_user');
        if (stored) {
          updateAuthUI(JSON.parse(stored));
        }
      } catch (_) {}
    }
    setupLandingAuth();

    // Firebase Sync All Evidence Button
    const btnSyncFirebase = document.getElementById('btn-sync-firebase');
    if (btnSyncFirebase) {
      btnSyncFirebase.addEventListener('click', async () => {
        const origContent = btnSyncFirebase.innerHTML;
        btnSyncFirebase.disabled = true;
        btnSyncFirebase.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span>Syncing...</span>';
        if (window.lucide) window.lucide.createIcons();

        try {
          const res = await fetch('/api/firebase/sync', { method: 'POST' });
          const d = await res.json();
          if (d.success) {
            showToast(`Firebase synced: ${d.uploaded || 0} cases uploaded to /evidence`, 'success');
            checkFirebaseStatus();
          } else {
            showToast('Firebase Sync failed: ' + (d.error || 'Unknown error'), 'error');
          }
        } catch (err) {
          showToast('Firebase Sync error: ' + err.message, 'error');
        } finally {
          btnSyncFirebase.disabled = false;
          btnSyncFirebase.innerHTML = origContent;
          if (window.lucide) window.lucide.createIcons();
        }
      });
    }

    // Direct incident resolution with municipal confirmation dialog
    window.resolveIncidentDirect = async (id) => {
      if (!confirm(`Mark Incident ${id} as resolved and closed?`)) return;
      const user = getCurrentUser();
      try {
        await fetch(`/api/incidents/${id}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user })
        });
      } catch (_) { }
      const item = state.incidents.find(i => i.id === id);
      if (item) {
        item.status = 'Resolved';
        item.resolvedBy = user;
        mergeIncidents([item]);
      }
    };

    // Firebase RTDB Health Polling
    async function checkFirebaseStatus() {
      try {
        const res = await fetch('/api/firebase/status');
        if (!res.ok) return;
        const d = await res.json();

        const badgeOverview = document.getElementById('status-firebase-badge');
        const subtextOverview = document.getElementById('status-firebase-subtext');
        const badgeSettings = document.getElementById('badge-firebase-status');
        const summarySettings = document.getElementById('firebase-sync-summary');

        if (d.connected) {
          if (badgeOverview) {
            badgeOverview.textContent = 'Online';
            badgeOverview.className = 'px-2 py-0.5 rounded text-xs font-semibold bg-emerald-100 text-emerald-800';
          }
          if (subtextOverview) {
            subtextOverview.textContent = `RTDB: ${d.loggedEvidenceCount} evidence synced`;
          }
          if (badgeSettings) {
            badgeSettings.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span><span>Connected (asia-southeast1)</span>';
            badgeSettings.className = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200';
          }
          if (summarySettings) {
            summarySettings.textContent = `Evidence: ${d.loggedEvidenceCount} items | User audit logs: ${d.loggedUserCount} entries`;
          }
        } else {
          if (badgeOverview) {
            badgeOverview.textContent = 'Offline';
            badgeOverview.className = 'px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-800';
          }
          if (badgeSettings) {
            badgeSettings.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span><span>Connecting...</span>';
            badgeSettings.className = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-200';
          }
        }
      } catch (_) {}
    }

    checkFirebaseStatus();
    setInterval(checkFirebaseStatus, 15000);
  }

  // ========================================================
  // 8. INTERACTIVE ENHANCEMENTS
  // ========================================================
  function setupInteractivePole() {
    const POLE_COMPONENTS_DATA = {
      camera: {
        title: 'AI CCTV Camera Unit (ESP32-CAM)',
        badge: 'Visual Evidence Engine',
        badgeClass: 'bg-blue-100 text-blue-800',
        desc: 'High-framerate camera running real-time vehicle impact and collision detection. When dynamic tilt or impact jerk is sensed, it captures photographic evidence and streams live video directly to the municipal monitoring dashboard.'
      },
      gas: {
        title: 'MQ-2 Combustible Gas Transducer',
        badge: 'Gas & Smoke Sentinel',
        badgeClass: 'bg-amber-100 text-amber-800',
        desc: 'High-sensitivity electrochemical sensor configured to detect LPG, Propane, Methane, and smoke plumes. Continuously samples surrounding air quality and triggers emergency sirens when levels exceed the 1800 ppm threshold.'
      },
      sos: {
        title: 'Citizen Emergency SOS Panic Button',
        badge: 'Priority Distress Alert',
        badgeClass: 'bg-red-100 text-red-800',
        desc: 'One-touch physical emergency call station for pedestrians and citizens. Pressing the button instantly dispatches an emergency alert with exact GPS coordinates and triggers the pole strobe relay and alert siren.'
      },
      esp32: {
        title: 'ESP32 Dual-Core Edge Controller',
        badge: 'Core Intelligence Unit',
        badgeClass: 'bg-emerald-100 text-emerald-800',
        desc: 'Dual-core 240MHz microcontroller orchestrating all pole sensors. Houses an MPU-6050 6-axis gyro/accelerometer, NEO-6M GPS receiver for live coordinates, Wi-Fi connectivity, and direct cloud synchronization.'
      }
    };

    const compBtns = document.querySelectorAll('.pole-component-btn');
    const popoverTitle = document.getElementById('popover-title');
    const popoverBadge = document.getElementById('popover-badge');
    const popoverDesc = document.getElementById('popover-desc');

    compBtns.forEach(btn => {
      const compKey = btn.getAttribute('data-comp');
      const data = POLE_COMPONENTS_DATA[compKey];
      if (!data) return;

      const showComp = () => {
        if (popoverTitle) popoverTitle.innerText = data.title;
        if (popoverBadge) {
          popoverBadge.innerText = data.badge;
          popoverBadge.className = `px-2 py-0.5 rounded text-[10px] font-semibold ${data.badgeClass}`;
        }
        if (popoverDesc) popoverDesc.innerText = data.desc;
      };

      btn.addEventListener('mouseenter', showComp);
      btn.addEventListener('click', showComp);
    });
  }

  function setupInteractiveWorkflow() {
    const WORKFLOW_STEPS_DATA = {
      '1': {
        title: 'Stage 1: Sensor Layer (Real-time Telemetry Acquisition)',
        subtitle: 'Autonomous continuous sampling from low-latency sensors',
        protocol: 'I2C + ADC + GPIO',
        desc: 'The safety pole\'s peripheral suite operates concurrently: the MPU-6050 samples tilt angles and collision jerk over I2C at 200ms intervals, the MQ-2 gas sensor streams analog voltage for combustible hydrocarbons, and the citizen SOS panic button sits on a noise-filtered interrupt.'
      },
      '2': {
        title: 'Stage 2: ESP32 Edge Processing & Siren Trigger',
        subtitle: 'Microsecond edge decision making without cloud latency dependency',
        protocol: 'Dual-Core 240MHz RTOS',
        desc: 'The ESP32 runs edge filtering algorithms. If static tilt exceeds 12 degrees, impact jerk exceeds 0.40 G, or MQ-2 exceeds 1800 ppm, the microcontroller immediately triggers the onboard buzzer, actuates the street light relay, and coordinates the camera module.'
      },
      '3': {
        title: 'Stage 3: Cloud Sync & Event Logging',
        subtitle: 'Instantaneous multi-channel dispatch to Firestore and Node.js proxy',
        protocol: 'REST API + WebSocket + Blynk',
        desc: 'Telemetry and event alerts are dispatched simultaneously via local REST API to the municipal proxy server, pushed to Firebase Firestore for cloud persistence, and logged to Blynk Cloud for mobile field officer notifications.'
      },
      '4': {
        title: 'Stage 4: Centralized Municipal Safety Dashboard',
        subtitle: 'Real-time incident classification, visual evidence & GPS mapping',
        protocol: 'Socket.IO Live Streaming',
        desc: 'The operations dashboard receives live telemetry via Socket.IO. Incidents are classified by severity (Critical, Warning, Normal), placed on the interactive Leaflet map, and displayed with live camera snapshots for dispatch verification.'
      },
      '5': {
        title: 'Stage 5: Emergency Authority Dispatch',
        subtitle: 'Actionable intelligence delivered to Traffic Police, Fire & EMS',
        protocol: 'Municipal CAD & Radio Link',
        desc: 'Dispatched emergency units receive the pole\'s exact Google Maps GPS location, photographic visual evidence of the incident, and current environmental conditions (fire/smoke/tilt), cutting initial response time down to under 3 seconds.'
      }
    };

    const stepBtns = document.querySelectorAll('.workflow-step-btn');
    const badgeStep = document.getElementById('wf-badge-step');
    const wfTitle = document.getElementById('wf-title');
    const wfSubtitle = document.getElementById('wf-subtitle');
    const wfProtocol = document.getElementById('wf-protocol');
    const wfDesc = document.getElementById('wf-desc');

    stepBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const step = btn.getAttribute('data-step');
        const data = WORKFLOW_STEPS_DATA[step];
        if (!data) return;

        stepBtns.forEach(b => {
          b.classList.remove('border-2', 'border-blue-500');
          b.classList.add('border-slate-200');
          const num = b.querySelector('.step-num');
          if (num) {
            num.classList.remove('bg-blue-600', 'text-white');
            num.classList.add('bg-slate-100', 'text-slate-700');
          }
        });

        btn.classList.add('border-2', 'border-blue-500');
        btn.classList.remove('border-slate-200');
        const activeNum = btn.querySelector('.step-num');
        if (activeNum) {
          activeNum.classList.add('bg-blue-600', 'text-white');
          activeNum.classList.remove('bg-slate-100', 'text-slate-700');
        }

        if (badgeStep) badgeStep.innerText = step;
        if (wfTitle) wfTitle.innerText = data.title;
        if (wfSubtitle) wfSubtitle.innerText = data.subtitle;
        if (wfProtocol) wfProtocol.innerText = data.protocol;
        if (wfDesc) wfDesc.innerText = data.desc;
      });
    });
  }

  function setupClickableKPICards() {
    const cardPoles = document.getElementById('kpi-card-poles');
    const cardEmergencies = document.getElementById('kpi-card-emergencies');
    const cardGas = document.getElementById('kpi-card-gas');
    const cardResolved = document.getElementById('kpi-card-resolved');

    if (cardPoles) {
      cardPoles.addEventListener('click', () => activateTab('tab-locations'));
    }
    if (cardEmergencies) {
      cardEmergencies.addEventListener('click', () => {
        state.filterSeverity = 'Critical';
        activateTab('tab-alerts');
      });
    }
    if (cardGas) {
      cardGas.addEventListener('click', () => activateTab('tab-gas'));
    }
    if (cardResolved) {
      cardResolved.addEventListener('click', () => {
        state.filterSeverity = 'Resolved';
        renderAlertsTable();
        activateTab('tab-overview');
      });
    }

    // Hero stat cards
    const heroStatPoles = document.getElementById('hero-stat-poles');
    const heroStatIncidents = document.getElementById('hero-stat-incidents');
    const heroStatResolved = document.getElementById('hero-stat-resolved');

    if (heroStatPoles && heroStatPoles.closest('a')) {
      heroStatPoles.closest('a').addEventListener('click', (e) => {
        e.preventDefault();
        window.location.hash = '#dashboard';
        activateTab('tab-locations');
      });
    }
    if (heroStatIncidents && heroStatIncidents.closest('a')) {
      heroStatIncidents.closest('a').addEventListener('click', (e) => {
        e.preventDefault();
        window.location.hash = '#dashboard';
        activateTab('tab-alerts');
      });
    }
    if (heroStatResolved && heroStatResolved.closest('a')) {
      heroStatResolved.closest('a').addEventListener('click', (e) => {
        e.preventDefault();
        window.location.hash = '#dashboard';
        state.filterSeverity = 'Resolved';
        renderAlertsTable();
        activateTab('tab-overview');
      });
    }

    // Feature cards goto tab links
    document.querySelectorAll('.feature-goto-tab').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const tab = link.getAttribute('data-tab');
        window.location.hash = '#dashboard';
        if (tab) activateTab(tab);
      });
    });
  }

  function setupGlobalSearchAndNotifications() {
    const searchInput = document.getElementById('global-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        state.searchQuery = e.target.value.trim();
        renderAlertsTable();
      });
    }

    const bellBtn = document.getElementById('btn-notification-bell');
    const dropdown = document.getElementById('notification-dropdown');
    if (bellBtn && dropdown) {
      bellBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.toggle('hidden');
      });

      document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target) && !bellBtn.contains(e.target)) {
          dropdown.classList.add('hidden');
        }
      });
    }

    const clearNotif = document.getElementById('btn-clear-notifications');
    if (clearNotif) {
      clearNotif.addEventListener('click', () => {
        const badge = document.getElementById('notification-badge');
        if (badge) badge.classList.add('hidden');
        const listEl = document.getElementById('notification-list');
        if (listEl) listEl.innerHTML = `<div class="p-4 text-center text-slate-400">All notifications marked read.</div>`;
      });
    }
  }

  function setupMobileMenu() {
    const btn = document.getElementById('btn-mobile-menu');
    const menu = document.getElementById('mobile-nav-dropdown');
    if (!btn || !menu) return;

    btn.addEventListener('click', () => {
      menu.classList.toggle('hidden');
    });

    document.querySelectorAll('.mobile-nav-link').forEach(link => {
      link.addEventListener('click', () => {
        menu.classList.add('hidden');
      });
    });

    const mobileLogin = document.getElementById('btn-mobile-open-login');
    if (mobileLogin) {
      mobileLogin.addEventListener('click', () => {
        menu.classList.add('hidden');
      });
    }
  }

  function setupLandingHeroVideo() {
    const vid = document.getElementById('landing-hero-video');
    const btnSound = document.getElementById('btn-toggle-video-sound');
    const iconSound = document.getElementById('video-sound-icon');
    const btnPlay = document.getElementById('btn-toggle-video-play');
    const iconPlay = document.getElementById('video-play-icon');

    if (!vid) return;

    // Toggle Sound (Unmute / Mute)
    if (btnSound) {
      btnSound.addEventListener('click', (e) => {
        e.stopPropagation();
        vid.muted = !vid.muted;
        if (iconSound) {
          iconSound.setAttribute('data-lucide', vid.muted ? 'volume-x' : 'volume-2');
          if (window.lucide) window.lucide.createIcons();
        }
      });
    }

    // Toggle Play / Pause
    const togglePlayback = (e) => {
      if (e) e.stopPropagation();
      if (vid.paused) {
        vid.play().catch(() => {});
        if (iconPlay) iconPlay.setAttribute('data-lucide', 'pause');
      } else {
        vid.pause();
        if (iconPlay) iconPlay.setAttribute('data-lucide', 'play');
      }
      if (window.lucide) window.lucide.createIcons();
    };

    if (btnPlay) btnPlay.addEventListener('click', togglePlayback);
    vid.addEventListener('click', togglePlayback);
  }

  // ========================================================
  // 9. INITIALIZATION
  // ========================================================
  window.addEventListener('DOMContentLoaded', () => {
    // Initial Routing
    window.addEventListener('hashchange', handleNavigation);
    handleNavigation();

    setupTabs();
    setupSidebarToggle();
    setupModalHandlers();
    setupControls();
    setupInteractivePole();
    setupInteractiveWorkflow();
    setupClickableKPICards();
    setupGlobalSearchAndNotifications();
    setupMobileMenu();
    setupLandingHeroVideo();
    initSocketIO();
    fetchIncidents();

    setTimeout(() => {
      initMaps();
    }, 300);

    // Camera offline overlay detection
    const camImg = document.getElementById('live-cam-img');
    const camOverlay = document.getElementById('cam-offline-overlay');
    if (camImg && camOverlay) {
      camImg.onerror = () => camOverlay.classList.remove('hidden');
      camImg.onload = () => camOverlay.classList.add('hidden');
    }

    if (window.lucide) window.lucide.createIcons();
  });

})();
