/**
 * Firebase Realtime Database Service for Smart Street Safety Pole
 * Project: smart-street-safety-pole
 * Target RTDB: https://smart-street-safety-pole-default-rtdb.asia-southeast1.firebasedatabase.app
 * 
 * Features:
 * - Evidence logging (Incident ID, Timestamp, Location, GPS, Telemetry, Snapshot photo)
 * - User and Officer session logging (/users and /user_logs)
 * - Incident status synchronization (Pending -> Acknowledged -> Resolved)
 * - Non-blocking asynchronous execution with timeout resilience
 */

const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');

const DEFAULT_DB_URL = 'https://smart-street-safety-pole-default-rtdb.asia-southeast1.firebasedatabase.app';
const DB_URL = process.env.FIREBASE_DATABASE_URL || DEFAULT_DB_URL;

function hashPassword(password, salt) {
  if (!password) return '';
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, s, 1000, 32, 'sha256').toString('hex');
  return { hash, salt: s };
}

function verifyPassword(password, hash, salt) {
  if (!password || !hash || !salt) return false;
  const h = crypto.pbkdf2Sync(password, salt, 1000, 32, 'sha256').toString('hex');
  return h === hash;
}

let isConnected = true;
let lastSyncTimestamp = null;
let lastSyncError = null;
let loggedEvidenceCount = 0;
let loggedUserCount = 0;

/**
 * Generic Firebase RTDB REST request wrapper
 */
function rtdbRequest(path, method = 'GET', data = null, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    try {
      const cleanPath = path.startsWith('/') ? path : '/' + path;
      const targetUrl = new URL(cleanPath + '.json', DB_URL);
      const postData = data ? JSON.stringify(data) : null;

      const options = {
        method,
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
        }
      };

      const req = https.request(targetUrl, options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            isConnected = true;
            lastSyncTimestamp = new Date().toISOString();
            lastSyncError = null;
            try {
              resolve({ ok: true, status: res.statusCode, data: JSON.parse(body) });
            } catch (_) {
              resolve({ ok: true, status: res.statusCode, data: body });
            }
          } else {
            const err = `Firebase returned HTTP ${res.statusCode}: ${body}`;
            lastSyncError = err;
            resolve({ ok: false, status: res.statusCode, error: err });
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        lastSyncError = 'Firebase request timed out';
        resolve({ ok: false, error: 'Request timed out' });
      });

      req.on('error', (err) => {
        lastSyncError = err.message;
        isConnected = false;
        resolve({ ok: false, error: err.message });
      });

      if (postData) req.write(postData);
      req.end();
    } catch (err) {
      lastSyncError = err.message;
      resolve({ ok: false, error: err.message });
    }
  });
}

/**
 * 1. Log or Update Evidence in Firebase RTDB
 * Path: /evidence/{incidentId}
 */
async function logEvidence(incident) {
  if (!incident || !incident.id) return { ok: false, error: 'Invalid incident payload' };

  console.log(`[Firebase RTDB] Uploading incident evidence: ${incident.id} (${incident.triggerType})...`);

  // Prepare evidence payload
  const payload = {
    id: incident.id,
    timestamp: incident.timestamp || new Date().toISOString(),
    triggerType: incident.triggerType || 'Emergency Incident',
    severity: incident.severity || 'Critical',
    status: incident.status || 'Pending',
    location: incident.location || 'Municipal Sector 14',
    poleId: incident.poleId || 'POLE-01',
    gps: incident.telemetrySnapshot?.gps || { lat: 30.68236, lng: 76.60628 },
    telemetrySnapshot: incident.telemetrySnapshot || {},
    imageUrl: incident.imageUrl || '',
    evidenceLoggedAt: new Date().toISOString()
  };

  const res = await rtdbRequest(`/evidence/${incident.id}`, 'PUT', payload);
  if (res.ok) {
    loggedEvidenceCount++;
    console.log(`[Firebase RTDB] Successfully logged evidence: ${incident.id}`);
  } else {
    console.warn(`[Firebase RTDB] Failed to log evidence ${incident.id}:`, res.error || res.status);
  }
  return res;
}

/**
 * 2. Update Evidence Status (e.g. Acknowledged or Resolved)
 * Path: /evidence/{incidentId}
 */
async function updateEvidenceStatus(incidentId, status, meta = {}) {
  if (!incidentId) return;

  const patch = {
    status: status,
    updatedAt: new Date().toISOString(),
    ...meta
  };

  const res = await rtdbRequest(`/evidence/${incidentId}`, 'PATCH', patch);
  if (res.ok) {
    console.log(`[Firebase RTDB] Updated evidence ${incidentId} status -> ${status}`);
  }
  return res;
}

/**
 * 3. Delete Single Evidence Record
 * Path: /evidence/{incidentId}
 */
async function deleteEvidence(incidentId) {
  if (!incidentId) return;
  const res = await rtdbRequest(`/evidence/${incidentId}`, 'DELETE');
  console.log(`[Firebase RTDB] Deleted evidence ${incidentId}:`, res.ok ? 'OK' : res.error);
  return res;
}

/**
 * 4. Remove Evidence Photo (Keep incident metadata)
 */
async function deleteEvidencePhoto(incidentId) {
  if (!incidentId) return;
  const res = await rtdbRequest(`/evidence/${incidentId}`, 'PATCH', { imageUrl: '' });
  console.log(`[Firebase RTDB] Cleared evidence photo for ${incidentId}`);
  return res;
}

/**
 * 5. Log User / Officer Session & Profile
 * Path: /users/{userKey} & /user_logs
 */
async function logUser(userData) {
  const email = (userData.email || 'user@smartpole.gov').toLowerCase().trim();
  const safeKey = email.replace(/[^a-z0-9]/g, '_');
  const now = new Date().toISOString();

  // Check existing user profile
  let existing = null;
  const exRes = await rtdbRequest(`/users/${safeKey}`, 'GET');
  if (exRes.ok && exRes.data) {
    existing = exRes.data;
  }

  // Password verification if password was provided and existing profile has passwordHash
  if (userData.password && existing && existing.passwordHash && existing.passwordSalt) {
    const isValid = verifyPassword(userData.password, existing.passwordHash, existing.passwordSalt);
    if (!isValid) {
      return { ok: false, error: 'Incorrect credentials' };
    }
  }

  const isAdmin = email === 'admin@safepole.org' || email === 'admin@smartpole.gov';
  const role = existing?.role || (isAdmin ? 'Administrator' : (userData.role || 'Officer'));
  const status = existing?.status || (isAdmin ? 'approved' : (userData.status || 'approved'));

  const userProfile = {
    email: email,
    name: userData.name || existing?.name || email.split('@')[0],
    role: role,
    status: status,
    lastLogin: now,
    lastIp: userData.ip || '127.0.0.1'
  };

  // 1. Update user profile under /users/{safeKey}
  await rtdbRequest(`/users/${safeKey}`, 'PATCH', userProfile);

  // 2. Append immutable login audit trail under /user_logs
  const auditEntry = {
    type: 'USER_LOGIN',
    user: email,
    name: userProfile.name,
    role: userProfile.role,
    status: userProfile.status,
    ip: userData.ip || '127.0.0.1',
    userAgent: userData.userAgent || 'Web Console',
    timestamp: now
  };

  const logRes = await rtdbRequest('/user_logs', 'POST', auditEntry);
  if (logRes.ok) {
    loggedUserCount++;
    console.log(`[Firebase RTDB] User session logged: ${email} (${userProfile.role} - ${userProfile.status})`);
  }

  return { ok: true, user: { ...userProfile, logId: logRes.data?.name } };
}

/**
 * Register New User Account
 * Path: /users/{userKey} & /user_logs
 */
async function registerUser(userData) {
  const email = (userData.email || '').toLowerCase().trim();
  if (!email) return { ok: false, error: 'Email is required' };

  const safeKey = email.replace(/[^a-z0-9]/g, '_');
  const now = new Date().toISOString();

  // Securely hash password using PBKDF2 with unique salt
  let passData = {};
  if (userData.password) {
    const { hash, salt } = hashPassword(userData.password);
    passData = { passwordHash: hash, passwordSalt: salt };
  }

  const isAdmin = email === 'admin@safepole.org' || email === 'admin@smartpole.gov';
  const role = isAdmin ? 'Administrator' : (userData.role || 'Officer');
  const status = isAdmin ? 'approved' : 'pending_approval'; // New registrations require municipal officer approval

  const userProfile = {
    email: email,
    name: userData.name || email.split('@')[0],
    role: role,
    status: status,
    createdAt: now,
    lastLogin: now,
    lastIp: userData.ip || '127.0.0.1',
    ...passData
  };

  // Store in /users
  await rtdbRequest(`/users/${safeKey}`, 'PUT', userProfile);

  // Append to /user_logs
  const auditEntry = {
    type: 'USER_REGISTER',
    user: email,
    name: userProfile.name,
    role: userProfile.role,
    status: userProfile.status,
    ip: userData.ip || '127.0.0.1',
    userAgent: userData.userAgent || 'Web Console',
    timestamp: now
  };

  const logRes = await rtdbRequest('/user_logs', 'POST', auditEntry);
  if (logRes.ok) {
    loggedUserCount++;
    console.log(`[Firebase RTDB] New user registered: ${email} (${userProfile.name} - ${userProfile.status})`);
  }

  const { passwordHash, passwordSalt, ...safeProfile } = userProfile;
  return { ok: true, user: { ...safeProfile, logId: logRes.data?.name } };
}

/**
 * Get All Registered Users & Officers
 */
async function getUsers() {
  const res = await rtdbRequest('/users', 'GET');
  if (res.ok && res.data) {
    return Object.values(res.data).map(u => ({
      email: u.email,
      name: u.name,
      role: u.role || 'Officer',
      status: u.status || 'approved',
      createdAt: u.createdAt,
      lastLogin: u.lastLogin,
      lastIp: u.lastIp
    }));
  }
  return [];
}

/**
 * Update User Role & Approval Status
 */
async function updateUserStatus(email, role, status = 'approved') {
  const safeKey = (email || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '_');
  const patchData = { role, status, updatedAt: new Date().toISOString() };
  const res = await rtdbRequest(`/users/${safeKey}`, 'PATCH', patchData);
  if (res.ok) {
    await logUserActivity('APPROVE_OFFICER', { email, role, status }, 'Administrator');
  }
  return res;
}

/**
 * Save Persistent Calibration to Firebase
 */
async function saveCalibration(calData) {
  return rtdbRequest('/system/calibration', 'PUT', calData);
}

/**
 * Load Persistent Calibration from Firebase
 */
async function getCalibration() {
  const res = await rtdbRequest('/system/calibration', 'GET');
  return res.ok ? res.data : null;
}

/**
 * 6. Log Specific User Activity (Resolving alerts, updating IPs, etc.)
 * Path: /user_logs
 */
async function logUserActivity(action, details = {}, user = 'Officer') {
  const entry = {
    type: 'ACTIVITY',
    action: action,
    user: user,
    details: details,
    timestamp: new Date().toISOString()
  };

  return rtdbRequest('/user_logs', 'POST', entry);
}

/**
 * 7. Batch Synchronize All Existing Local Incidents to Firebase RTDB
 */
async function syncAllIncidents(incidentsList) {
  if (!Array.isArray(incidentsList)) return { count: 0 };
  console.log(`[Firebase RTDB] Starting sync of ${incidentsList.length} incident cases...`);
  
  let synced = 0;
  for (const inc of incidentsList) {
    if (inc && inc.id) {
      const res = await logEvidence(inc);
      if (res.ok) synced++;
    }
  }
  return { total: incidentsList.length, synced: synced };
}

/**
 * 8. Return Live Firebase Service Diagnostics
 */
function getFirebaseStatus() {
  return {
    connected: isConnected,
    databaseUrl: DB_URL,
    region: 'asia-southeast1',
    projectId: 'smart-street-safety-pole',
    lastSyncTimestamp: lastSyncTimestamp,
    lastSyncError: lastSyncError,
    loggedEvidenceCount: loggedEvidenceCount,
    loggedUserCount: loggedUserCount
  };
}

module.exports = {
  logEvidence,
  updateEvidenceStatus,
  deleteEvidence,
  deleteEvidencePhoto,
  logUser,
  registerUser,
  getUsers,
  updateUserStatus,
  saveCalibration,
  getCalibration,
  logUserActivity,
  syncAllIncidents,
  getFirebaseStatus
};

