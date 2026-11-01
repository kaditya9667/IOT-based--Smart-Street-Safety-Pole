#include "esp_camera.h"
#include "esp_http_server.h"
#include <WiFi.h>
#include <ESPmDNS.h>
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"

// ==================================================
// SMART ELECTRIC POLE HD CAMERA (OPTIMIZED)
// ==================================================
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* HOSTNAME      = "polecam";

// AI Thinker ESP32-CAM Pin Mapping
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27

#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5

#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

// Camera Quality Configuration (Zero-Lag Smooth Real-Time Stream)
#define JPEG_QUALITY       15              // Clean, crisp detail with low frame size
#define CAMERA_RESOLUTION  FRAMESIZE_HVGA  // 480x320 resolution (instant Wi-Fi transmission, zero lag)

httpd_handle_t camera_httpd = NULL;

// ==================================================
// EMBEDDED DASHBOARD (WITH RECORDING & DOWNLOAD)
// ==================================================
static const char INDEX_HTML[] PROGMEM = R"HTML(
<!DOCTYPE html>
<html lang="en">
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta charset="UTF-8">
<title>Smart Electric Pole - HD CCTV</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#0b1220;color:#e5edf8;font-family:Arial,sans-serif}
header{padding:20px;text-align:center;background:#111c30;border-bottom:1px solid #29364b}
h1{margin:0;color:#60a5fa;font-size:24px}
header p{color:#9aabc3;margin:6px 0 0;font-size:14px}
main{max-width:760px;margin:20px auto;padding:14px}
.card{background:#131f33;border:1px solid #29364b;border-radius:14px;padding:18px;margin-bottom:18px}
h2{font-size:18px;margin-top:0}
.viewport{width:100%;aspect-ratio:4/3;background:#000;border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center;position:relative}
#camera{width:100%;height:100%;object-fit:contain;display:block;transition:transform 0.2s}
.controls{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:14px}
button,.btn{padding:10px 14px;border:0;border-radius:8px;background:#2563eb;color:white;font-weight:bold;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
.secondary{background:#374151}
.green{background:#059669}
.red{background:#dc2626}
#status{text-align:center;color:#aab3c5;margin-top:12px;font-size:14px}
.preview-box{width:100%;display:none;margin-top:14px;border-radius:8px;background:#000}
.badge-rec{position:absolute;top:12px;left:12px;background:rgba(220,38,38,0.85);color:#fff;padding:4px 9px;border-radius:4px;font-size:12px;font-weight:bold;display:none;animation:pulse 1.2s infinite}
@keyframes pulse{0%{opacity:1}50%{opacity:0.5}100%{opacity:1}}
.info{color:#aab3c5;font-size:14px;line-height:1.6}
</style>
</head>
<body>
<header>
  <h1>Smart Electric Pole</h1>
  <p>HD Live Surveillance • ESP32-CAM</p>
</header>
<main>
  <section class="card">
    <h2>Live Pole Camera</h2>
    <div class="viewport">
      <div id="rec-badge" class="badge-rec">● REC <span id="rec-time">00:00</span></div>
      <img id="camera" alt="Connecting to stream...">
    </div>

    <!-- Zoom Controls -->
    <div class="controls">
      <button class="secondary" onclick="zoomBy(-0.2)">− Zoom</button>
      <button class="secondary" id="zoom-txt" onclick="resetZoom()">100%</button>
      <button class="secondary" onclick="zoomBy(0.2)">+ Zoom</button>
    </div>

    <!-- Main Controls -->
    <div class="controls">
      <button class="green" onclick="startStream()">Start Stream</button>
      <button class="red" onclick="stopStream()">Pause</button>
      <button class="secondary" onclick="capturePhoto()">Snapshot</button>
      <button class="red" id="rec-btn" onclick="toggleRecord()">Record Video</button>
    </div>
    <div id="status">Connecting...</div>
  </section>

  <!-- Photo Preview & Download -->
  <section class="card" id="photo-card" style="display:none">
    <h2>Captured Photo</h2>
    <img id="photo-preview" class="preview-box" alt="Snapshot" style="display:block">
    <div class="controls">
      <a id="photo-dl" class="btn green" download="smartpole-snapshot.jpg">Download Photo</a>
    </div>
  </section>

  <!-- Video Preview & Download -->
  <section class="card" id="video-card" style="display:none">
    <h2>Recorded Video</h2>
    <video id="video-player" class="preview-box" controls style="display:block"></video>
    <div class="controls">
      <a id="video-dl" class="btn green" download="smartpole-video.webm">Download Video</a>
    </div>
  </section>

  <section class="card">
    <h2>Camera Info</h2>
    <div class="info">
      <p><b>Resolution:</b> VGA (640 × 480) Native Hardware JPEG</p>
      <p><b>Endpoints:</b> Stream: <code>/stream</code> | Snapshot: <code>/capture</code></p>
    </div>
  </section>
</main>

<script>
const camera = document.getElementById('camera');
const statusText = document.getElementById('status');
let running = false, busy = false, zoom = 1, frameURL = null, timer = null;

// Digital Zoom
function updateZoom(){
  camera.style.transform = 'scale(' + zoom + ')';
  document.getElementById('zoom-txt').textContent = Math.round(zoom * 100) + '%';
}
function zoomBy(amt){ zoom = Math.max(1, Math.min(3, Math.round((zoom + amt)*10)/10)); updateZoom(); }
function resetZoom(){ zoom = 1; updateZoom(); }

// Native Continuous Stream Engine
function startStream(){
  running = true;
  camera.src = '/stream';
  statusText.textContent = 'Streaming live (Continuous Hardware MJPEG)';
}
function stopStream(){
  running = false;
  camera.src = '';
  statusText.textContent = 'Stream paused';
}

// Photo Snapshot
async function capturePhoto(){
  statusText.textContent = 'Taking high-res snapshot...';
  try{
    const res = await fetch('/capture?t=' + Date.now(), {cache:'no-store'});
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    document.getElementById('photo-preview').src = url;
    document.getElementById('photo-dl').href = url;
    document.getElementById('photo-card').style.display = 'block';
    statusText.textContent = 'Snapshot captured!';
  }catch(e){
    statusText.textContent = 'Snapshot error: ' + e.message;
  }
}

// In-Browser Video Recording
let mediaRecorder = null, recordedChunks = [], isRecording = false, recTimer = null, recStart = 0;
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');
let drawInterval = null;

function toggleRecord(){
  if(isRecording) stopRecord(); else startRecord();
}

function startRecord(){
  recordedChunks = [];
  canvas.width = camera.naturalWidth || 640;
  canvas.height = camera.naturalHeight || 480;
  const stream = canvas.captureStream(15);
  mediaRecorder = new MediaRecorder(stream, {mimeType: 'video/webm'});
  mediaRecorder.ondataavailable = e => { if(e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, {type:'video/webm'});
    const url = URL.createObjectURL(blob);
    document.getElementById('video-player').src = url;
    document.getElementById('video-dl').href = url;
    document.getElementById('video-card').style.display = 'block';
  };
  mediaRecorder.start(500);
  isRecording = true;
  recStart = Date.now();
  document.getElementById('rec-badge').style.display = 'block';
  document.getElementById('rec-btn').textContent = 'Stop Recording';

  drawInterval = setInterval(() => {
    if(camera.complete && camera.naturalWidth > 0){
      ctx.drawImage(camera, 0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(10, canvas.height - 28, 220, 22);
      ctx.fillStyle = '#10b981';
      ctx.font = '12px Arial';
      ctx.fillText('SafePole CCTV • ' + new Date().toLocaleTimeString(), 14, canvas.height - 12);
    }
  }, 66);

  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    const m = String(Math.floor(s/60)).padStart(2,'0');
    const sec = String(s%60).padStart(2,'0');
    document.getElementById('rec-time').textContent = m + ':' + sec;
  }, 1000);
}

function stopRecord(){
  isRecording = false;
  clearInterval(drawInterval);
  clearInterval(recTimer);
  if(mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  document.getElementById('rec-badge').style.display = 'none';
  document.getElementById('rec-btn').textContent = 'Record Video';
}

startStream();
</script>
</body>
</html>
)HTML";

// ==================================================
// CAMERA INITIALIZATION (HARDWARE JPEG & ISP TUNING)
// ==================================================
bool initializeCamera() {
  // 1. Hardware Power-Cycle to unstick sensor I2C/SCCB bus
  pinMode(PWDN_GPIO_NUM, OUTPUT);
  digitalWrite(PWDN_GPIO_NUM, HIGH); // Cut power to sensor
  delay(150);
  digitalWrite(PWDN_GPIO_NUM, LOW);  // Restore clean power to sensor
  delay(150);

  camera_config_t config = {};

  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;

  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;

  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;

  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;

  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;

  // 10MHz XCLK clock (OV3660 stability requirement - prevents DMA overflow & panic crashes)
  config.xclk_freq_hz = 10000000;

  // Native Hardware JPEG
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size   = CAMERA_RESOLUTION; // FRAMESIZE_HVGA (480x320)
  config.jpeg_quality = JPEG_QUALITY;

  // Buffering Configuration (WHEN_EMPTY prevents DMA deadlock and first-frame freeze on OV3660)
  if (psramFound()) {
    config.fb_count = 2;
    config.fb_location = CAMERA_FB_IN_PSRAM;
    config.grab_mode = CAMERA_GRAB_WHEN_EMPTY; // CRITICAL: Fixes the 1-frame freeze permanently
    Serial.println("PSRAM detected: Double buffering active (WHEN_EMPTY)");
  } else {
    config.fb_count = 1;
    config.fb_location = CAMERA_FB_IN_DRAM;
    config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
    Serial.println("No PSRAM: Single buffer in DRAM (WHEN_EMPTY)");
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera initialization failed: 0x%x\n", err);
    return false;
  }

  // ISP Tuning & OV3660 Hardware Fixes
  sensor_t* s = esp_camera_sensor_get();
  if (s != NULL) {
    Serial.printf("Camera Sensor PID: 0x%04X\n", s->id.PID);

    // If OV3660, apply essential sensor register configuration
    if (s->id.PID == OV3660_PID || s->id.PID == 0x3660) {
      Serial.println("Applying OV3660 stability registers...");
      s->set_vflip(s, 1);       // OV3660 default orientation
      s->set_brightness(s, 1);  // Auto boost
      s->set_saturation(s, 0);  // Natural
      s->set_whitebal(s, 1);    // AWB
      s->set_awb_gain(s, 1);
    } else {
      s->set_brightness(s, 1);
      s->set_contrast(s, 1);
      s->set_saturation(s, 0);
      s->set_whitebal(s, 1);
      s->set_awb_gain(s, 1);
    }
  }

  // Flush first 2 frames so sensor DMA ring buffer starts completely clean
  for (int i = 0; i < 2; i++) {
    camera_fb_t* flushFb = esp_camera_fb_get();
    if (flushFb) esp_camera_fb_return(flushFb);
    delay(50);
  }

  Serial.println("Camera hardware initialized successfully!");
  return true;
}

// ==================================================
// FAST ZERO-COPY HARDWARE JPEG SENDER
// ==================================================
esp_err_t sendJpegFrame(httpd_req_t* req) {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("[CAM ERROR] esp_camera_fb_get failed!");
    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Camera frame unavailable");
    return ESP_FAIL;
  }

  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store, no-cache, must-revalidate");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");

  // Send hardware-compressed JPEG directly without software conversion
  esp_err_t res = httpd_resp_send(req, (const char*)fb->buf, fb->len);
  esp_camera_fb_return(fb);

  return res;
}

// ==================================================
// HTTP HANDLERS
// ==================================================
static esp_err_t indexHandler(httpd_req_t* req) {
  httpd_resp_set_type(req, "text/html; charset=utf-8");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  return httpd_resp_send(req, INDEX_HTML, HTTPD_RESP_USE_STRLEN);
}

#define PART_BOUNDARY "123456789000000000000987654321"
static const char* _STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* _STREAM_BOUNDARY = "\r\n--" PART_BOUNDARY "\r\n";
static const char* _STREAM_PART = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

// ==================================================
// HIGH-SPEED CONTINUOUS MJPEG STREAM HANDLER (CANONICAL)
// ==================================================
static esp_err_t streamHandler(httpd_req_t* req) {
  camera_fb_t* fb = NULL;
  esp_err_t res = ESP_OK;
  char part_buf[64];

  res = httpd_resp_set_type(req, _STREAM_CONTENT_TYPE);
  if (res != ESP_OK) return res;

  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(req, "X-Framerate", "25");

  Serial.println("[STREAM] Client connected to MJPEG stream");

  while (true) {
    fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("[STREAM ERROR] Frame capture failed!");
      res = ESP_FAIL;
      break;
    }

    // Standard Canonical Multipart Sequence:
    // 1. Boundary delimiter
    res = httpd_resp_send_chunk(req, _STREAM_BOUNDARY, strlen(_STREAM_BOUNDARY));
    // 2. Part headers (Content-Type & Content-Length)
    if (res == ESP_OK) {
      size_t hlen = snprintf(part_buf, 64, _STREAM_PART, fb->len);
      res = httpd_resp_send_chunk(req, part_buf, hlen);
    }
    // 3. Binary JPEG frame payload
    if (res == ESP_OK) {
      res = httpd_resp_send_chunk(req, (const char*)fb->buf, fb->len);
    }

    esp_camera_fb_return(fb);
    fb = NULL;

    if (res != ESP_OK) {
      Serial.println("[STREAM] Client disconnected");
      break;
    }

    vTaskDelay(pdMS_TO_TICKS(5));
  }

  return res;
}

static esp_err_t captureHandler(httpd_req_t* req) {
  return sendJpegFrame(req);
}

// ==================================================
// HTTP SERVER (PORT 80)
// ==================================================
void startCameraServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 80;
  config.ctrl_port = 32768;
  config.max_uri_handlers = 8;
  config.max_open_sockets = 7;
  config.stack_size = 16384;
  config.lru_purge_enable = true;
  config.send_wait_timeout = 10;
  config.recv_wait_timeout = 10;

  esp_err_t err = httpd_start(&camera_httpd, &config);
  if (err != ESP_OK) {
    Serial.printf("HTTP server start failed: 0x%x\n", err);
    return;
  }

  httpd_uri_t indexURI   = { "/",       HTTP_GET, indexHandler,   NULL };
  httpd_uri_t streamURI  = { "/stream",  HTTP_GET, streamHandler,  NULL };
  httpd_uri_t captureURI = { "/capture", HTTP_GET, captureHandler, NULL };

  httpd_register_uri_handler(camera_httpd, &indexURI);
  httpd_register_uri_handler(camera_httpd, &streamURI);
  httpd_register_uri_handler(camera_httpd, &captureURI);

  Serial.println("Camera HTTP Server started on Port 80");
}

// ==================================================
// SETUP
// ==================================================
void setup() {
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0); // Disable brownout detector to prevent reboots on Wi-Fi power spikes
  Serial.begin(115200);
  Serial.setDebugOutput(false);
  delay(1000);

  Serial.println();
  Serial.println("==========================================");
  Serial.println("SMART ELECTRIC POLE HD CAMERA (OPTIMIZED)");
  Serial.println("VGA 640x480 Hardware JPEG");
  Serial.println("==========================================");

  if (!initializeCamera()) {
    Serial.println("Camera initialization failed. Check lens ribbon cable.");
    while (true) delay(1000);
  }

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setHostname(HOSTNAME);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Connecting to Wi-Fi: ");
  Serial.println(WIFI_SSID);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 30000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi connection failed. Check 2.4 GHz credentials.");
    return;
  }

  Serial.println("Wi-Fi connected successfully!");
  Serial.print("Camera IP address: ");
  Serial.println(WiFi.localIP());

  if (MDNS.begin(HOSTNAME)) {
    MDNS.addService("http", "tcp", 80);
    Serial.println("Local hostname: http://polecam.local/");
  }

  startCameraServer();

  Serial.print("Stream endpoint: http://");
  Serial.print(WiFi.localIP());
  Serial.println("/stream");
}

// ==================================================
// LOOP
// ==================================================
void loop() {
  delay(1000);
}
