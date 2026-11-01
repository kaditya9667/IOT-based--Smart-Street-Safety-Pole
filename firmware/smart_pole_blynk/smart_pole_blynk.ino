#define BLYNK_TEMPLATE_ID "YOUR_BLYNK_TEMPLATE_ID"
#define BLYNK_TEMPLATE_NAME "Smart Pole"
#define BLYNK_AUTH_TOKEN "YOUR_BLYNK_AUTH_TOKEN"

#define BLYNK_PRINT Serial

#include <BlynkSimpleEsp32.h>
#include <ESPmDNS.h>
#include <TinyGPSPlus.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <Wire.h>
#include <math.h>

// Alert Types Enum (defined at top so function prototypes can use it)
enum AlertType { ALERT_NONE, ALERT_MOTION, ALERT_TILT, ALERT_SMOKE, ALERT_SOS };

int alertPriority(AlertType a);
unsigned long alertDuration(AlertType a);
unsigned long alertInterval(AlertType a);
void triggerBuzzerAlert(AlertType a);

// ==================================================
// WIFI
// ==================================================
char ssid[] = "YOUR_WIFI_SSID";
char pass[] = "YOUR_WIFI_PASSWORD";

// Local hostname: http://smartpole.local
const char *MDNS_NAME = "smartpole";

// ==================================================
// ESP32 PIN CONFIGURATION
// ==================================================
#define MQ2_PIN 34
#define MPU_SDA 21
#define MPU_SCL 22
#define GPS_RX 16
#define GPS_TX 17
#define PIR_PIN 27
#define SOS_BUTTON 26
#define BUZZER_PIN 25
#define LDR_PIN 33
#define RELAY_PIN 32

// ==================================================
// CONFIGURATION
// ==================================================
const int MQ2_THRESHOLD = 1800;

// Dynamic Accident & Impact Detection
// Triggers on either:
// 1. Static Tilt angle change >= 10.0 degrees (Calibrated from upright baseline)
// 2. Shake / Impact jerk >= 0.40 G (responsive to moderate pole shaking without
// breaking)
float tiltDeltaThreshold = 10.0;
const float SHAKE_JERK_THRESHOLD = 1.20;

// 3-Pin Digital LDR Module (VCC, GND, DO):
// Standard LM393 comparator module:
// When light shines: DO is LOW.
// When dark/covered: DO is HIGH.
const bool DARKNESS_IS_LOW = false;
const bool RELAY_ACTIVE_LOW = false;

// ==================================================
// SERVICES
// ==================================================
WebServer server(80);
HardwareSerial GPSSerial(2);
TinyGPSPlus gps;
BlynkTimer timer;

// ==================================================
// SENSOR DATA
// ==================================================
int mq2Value = 0;
int ldrRawValue = 0;

float tiltX = 0;
float tiltY = 0;

bool mpuAvailable = false;
bool smokeDetected = false;
bool motionDetected = false;
bool darkDetected = false;
bool tiltDetected = false;
bool sosPressed = false;

// Latched possible-accident state
bool accidentAlert = false;
String accidentReason = "";

// Send notification only once for each newly detected alert.
bool eventPending = false;
String pendingEventMessage = "";

bool previousSmoke = false;
bool previousMotion = false;
bool previousTilt = false;
bool previousSOS = false;

unsigned long lastSensorRead = 0;

// ==================================================
// RELAY
// ==================================================
void setRelay(bool on) {
  digitalWrite(RELAY_PIN,
               RELAY_ACTIVE_LOW ? (on ? LOW : HIGH) : (on ? HIGH : LOW));
}

// ==================================================
// MPU MODULE
// ==================================================
int16_t readMPU16(uint8_t reg) {
  Wire.beginTransmission(0x68);
  Wire.write(reg);

  if (Wire.endTransmission(false) != 0)
    return 0;
  if (Wire.requestFrom((uint8_t)0x68, (uint8_t)2) != 2)
    return 0;

  uint8_t hi = Wire.read();
  uint8_t lo = Wire.read();

  return (int16_t)((hi << 8) | lo);
}

bool initMPU() {
  Wire.beginTransmission(0x68);
  Wire.write(0x6B);
  Wire.write(0x00);

  if (Wire.endTransmission() != 0)
    return false;

  delay(100);

  Wire.beginTransmission(0x68);
  Wire.write(0x3B);

  if (Wire.endTransmission(false) != 0)
    return false;

  return Wire.requestFrom((uint8_t)0x68, (uint8_t)6) == 6;
}

// Dynamic baseline and shake tracking
float baselineTiltX = 0;
float baselineTiltY = 0;
bool baselineSet = false;
float lastAccelTotal = 1.0;
float shakeIntensity = 0;

void readTilt() {
  float sumAx = 0, sumAy = 0, sumAz = 0;
  int validSamples = 0;

  // Average 5 sensor reads to filter electrical noise and jitter
  for (int i = 0; i < 5; i++) {
    int16_t rx = readMPU16(0x3B);
    int16_t ry = readMPU16(0x3D);
    int16_t rz = readMPU16(0x3F);
    if (rx != 0 || ry != 0 || rz != 0) {
      sumAx += (rx / 16384.0);
      sumAy += (ry / 16384.0);
      sumAz += (rz / 16384.0);
      validSamples++;
    }
    delayMicroseconds(250);
  }

  if (validSamples == 0) return;

  float ax = sumAx / validSamples;
  float ay = sumAy / validSamples;
  float az = sumAz / validSamples;

  float newTiltX = atan2(ay, sqrt(ax * ax + az * az)) * 180.0 / PI;
  float newTiltY = atan2(-ax, sqrt(ay * ay + az * az)) * 180.0 / PI;

  // Smooth filter
  if (tiltX == 0 && tiltY == 0) {
    tiltX = newTiltX;
    tiltY = newTiltY;
  } else {
    tiltX = 0.75 * tiltX + 0.25 * newTiltX;
    tiltY = 0.75 * tiltY + 0.25 * newTiltY;
  }

  if (!baselineSet && (tiltX != 0 || tiltY != 0)) {
    baselineTiltX = tiltX;
    baselineTiltY = tiltY;
    baselineSet = true;
  }

  // Calculate dynamic shake jerk (magnitude change in acceleration vector)
  float totalAccel = sqrt(ax * ax + ay * ay + az * az);
  shakeIntensity = fabs(totalAccel - lastAccelTotal);
  lastAccelTotal = totalAccel;
}

// ==================================================
// BUZZER ALERTS
// ==================================================
AlertType activeAlert = ALERT_NONE;
unsigned long alertStart = 0;
unsigned long lastToggle = 0;
bool buzzerOn = false;

int alertPriority(AlertType a) {
  switch (a) {
  case ALERT_SOS:
    return 4;
  case ALERT_SMOKE:
    return 3;
  case ALERT_TILT:
    return 2;
  case ALERT_MOTION:
    return 1;
  default:
    return 0;
  }
}

unsigned long alertDuration(AlertType a) {
  switch (a) {
  case ALERT_SOS:
    return 3000;
  case ALERT_SMOKE:
    return 5000;
  case ALERT_TILT:
    return 3000;
  case ALERT_MOTION:
    return 500;
  default:
    return 0;
  }
}

unsigned long alertInterval(AlertType a) {
  switch (a) {
  case ALERT_SOS:
    return 150;
  case ALERT_SMOKE:
    return 250;
  case ALERT_TILT:
    return 400;
  case ALERT_MOTION:
    return 200;
  default:
    return 0;
  }
}

void triggerBuzzerAlert(AlertType a) {
  if (a == ALERT_NONE)
    return;

  if (activeAlert == ALERT_NONE ||
      alertPriority(a) > alertPriority(activeAlert)) {
    activeAlert = a;
    alertStart = millis();
    lastToggle = millis();
    buzzerOn = true;
    digitalWrite(BUZZER_PIN, HIGH);
  }
}

void updateBuzzer() {
  if (activeAlert == ALERT_NONE) {
    digitalWrite(BUZZER_PIN, LOW);
    buzzerOn = false;
    return;
  }

  unsigned long now = millis();

  if (now - alertStart >= alertDuration(activeAlert)) {
    activeAlert = ALERT_NONE;
    digitalWrite(BUZZER_PIN, LOW);
    buzzerOn = false;
    return;
  }

  if (now - lastToggle >= alertInterval(activeAlert)) {
    lastToggle = now;
    buzzerOn = !buzzerOn;
    digitalWrite(BUZZER_PIN, buzzerOn ? HIGH : LOW);
  }
}

// ==================================================
// ACCIDENT EVENT / BLYNK NOTIFICATION
// ==================================================
void raiseAccidentAlert(const String &reason) {
  accidentAlert = true;
  accidentReason = reason;
  eventPending = true;
  pendingEventMessage = reason;

  Serial.print("ALERT: ");
  Serial.println(reason);

  triggerBuzzerAlert(reason.indexOf("SOS") >= 0 ? ALERT_SOS : ALERT_TILT);
}

void sendBlynkData() {
  if (!Blynk.connected())
    return;

  Blynk.virtualWrite(V0, 1);
  Blynk.virtualWrite(V1, accidentAlert ? 1 : 0);
  Blynk.virtualWrite(V2, smokeDetected ? 1 : 0);
  Blynk.virtualWrite(V3, motionDetected ? 1 : 0);
  Blynk.virtualWrite(V4, darkDetected ? 1 : 0);
  Blynk.virtualWrite(V5, mq2Value);
  Blynk.virtualWrite(V6, tiltX);
  Blynk.virtualWrite(V7, tiltY);
  Blynk.virtualWrite(V10, sosPressed ? 1 : 0);

  if (gps.location.isValid()) {
    double lat = gps.location.lat();
    double lon = gps.location.lng();

    Blynk.virtualWrite(V8, lat);
    Blynk.virtualWrite(V9, lon);

    String url = "https://maps.google.com/?q=";
    url += String(lat, 6);
    url += ",";
    url += String(lon, 6);

    Blynk.virtualWrite(V11, url);
  }

  if (eventPending) {
    Blynk.logEvent("accident_alert", pendingEventMessage);
    eventPending = false;
    Serial.println("Blynk accident event submitted.");
  }
}

// Blynk dashboard button V12: PUSH, values 0/1
BLYNK_WRITE(V12) {
  if (param.asInt() == 1) {
    accidentAlert = false;
    Serial.println("Blynk dashboard alert acknowledged.");
  }
}

BLYNK_CONNECTED() { Serial.println("Blynk Cloud connected."); }

// ==================================================
// LOCAL WEB SERVER & REST API
// ==================================================
void handleAPI() {
  String json = "{";

  json += "\"mq2\":" + String(mq2Value);
  json += ",\"ldr\":" + String(ldrRawValue);
  json += ",\"smoke\":" + String(smokeDetected ? "true" : "false");
  json += ",\"motion\":" + String(motionDetected ? "true" : "false");
  json += ",\"dark\":" + String(darkDetected ? "true" : "false");
  json += ",\"tiltX\":" + String(tiltX, 2);
  json += ",\"tiltY\":" + String(tiltY, 2);
  json += ",\"tilt\":" + String(tiltDetected ? "true" : "false");
  json += ",\"sos\":" + String(sosPressed ? "true" : "false");
  json += ",\"accident\":" + String(accidentAlert ? "true" : "false");
  json += ",\"accidentReason\":\"" + accidentReason + "\"";
  json += ",\"mpu\":" + String(mpuAvailable ? "true" : "false");
  json += ",\"blynk\":" + String(Blynk.connected() ? "true" : "false");
  json +=
      ",\"wifi\":" + String(WiFi.status() == WL_CONNECTED ? "true" : "false");
  json += ",\"gpsValid\":" + String(gps.location.isValid() ? "true" : "false");

  json += ",\"lat\":" +
          String(gps.location.isValid() ? gps.location.lat() : 0.0, 6);
  json += ",\"lon\":" +
          String(gps.location.isValid() ? gps.location.lng() : 0.0, 6);

  json += "}";

  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", json);
}

void handleAcknowledge() {
  accidentAlert = false;
  tiltDetected = false;
  previousTilt = false;
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "text/plain", "Alert acknowledged");
  Serial.println("Dashboard alert acknowledged.");
}

void handleCalibrate() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  if (server.hasArg("x") && server.hasArg("y")) {
    baselineTiltX = server.arg("x").toFloat();
    baselineTiltY = server.arg("y").toFloat();
    baselineSet = true;
  } else {
    baselineTiltX = tiltX;
    baselineTiltY = tiltY;
    baselineSet = true;
  }
  if (server.hasArg("t")) {
    float t = server.arg("t").toFloat();
    if (t >= 3.0 && t <= 45.0) {
      tiltDeltaThreshold = t;
    }
  }
  accidentAlert = false;
  tiltDetected = false;
  previousTilt = false;
  String resp = "{\"status\":\"calibrated\",\"baseX\":" + String(baselineTiltX, 2) + ",\"baseY\":" + String(baselineTiltY, 2) + ",\"threshold\":" + String(tiltDeltaThreshold, 1) + "}";
  server.send(200, "application/json", resp);
  Serial.println("Baseline calibrated via HTTP.");
}

// ==================================================
// SETUP
// ==================================================
void setup() {
  Serial.begin(115200);
  delay(300);

  pinMode(MQ2_PIN, INPUT);
  pinMode(PIR_PIN, INPUT);
  pinMode(LDR_PIN, INPUT);
  pinMode(SOS_BUTTON, INPUT_PULLUP);

  digitalWrite(RELAY_PIN, RELAY_ACTIVE_LOW ? HIGH : LOW);
  pinMode(RELAY_PIN, OUTPUT);

  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  Wire.begin(MPU_SDA, MPU_SCL);
  mpuAvailable = initMPU();

  GPSSerial.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);

  setRelay(false);

  Serial.println("\n==============================");
  Serial.println("SMART ELECTRIC POLE INITIALIZING");
  Serial.println("==============================");

  // Connect Wi-Fi with wait loop
  Serial.print("Connecting to Wi-Fi: ");
  Serial.println(ssid);

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, pass);

  unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 20000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("Wi-Fi Connected successfully!");
    Serial.print("ESP32 IP: ");
    Serial.println(WiFi.localIP());

    if (MDNS.begin(MDNS_NAME)) {
      MDNS.addService("http", "tcp", 80);
      Serial.println("mDNS started: http://smartpole.local");
    }
  } else {
    Serial.println("Wi-Fi connection failed. Will retry in loop.");
  }

  // Configure Blynk
  Blynk.config(BLYNK_AUTH_TOKEN);

  // Start local WebServer endpoints
  server.on("/api", HTTP_GET, handleAPI);
  server.on("/ack", HTTP_POST, handleAcknowledge);
  server.on("/calibrate", handleCalibrate);
  server.begin();
  Serial.println("HTTP Server started on port 80");

  timer.setInterval(2000L, sendBlynkData);

  Serial.print("MPU accessible: ");
  Serial.println(mpuAvailable ? "YES" : "NO");
}

// ==================================================
// MAIN LOOP
// ==================================================
void loop() {
  Blynk.run();
  timer.run();

  while (GPSSerial.available()) {
    gps.encode(GPSSerial.read());
  }

  server.handleClient();

  // Wi-Fi reconnect check
  static unsigned long lastWiFiAttempt = 0;
  if (WiFi.status() != WL_CONNECTED && millis() - lastWiFiAttempt >= 10000) {
    lastWiFiAttempt = millis();
    WiFi.reconnect();
  }

  // Blynk reconnection check
  static unsigned long lastBlynkAttempt = 0;
  if (WiFi.status() == WL_CONNECTED && !Blynk.connected() &&
      millis() - lastBlynkAttempt >= 5000) {
    lastBlynkAttempt = millis();
    Blynk.connect(1000);
  }

  // Read sensors
  if (millis() - lastSensorRead >= 200) {
    lastSensorRead = millis();

    mq2Value = analogRead(MQ2_PIN);
    smokeDetected = mq2Value >= MQ2_THRESHOLD;

    motionDetected = digitalRead(PIR_PIN) == HIGH;

    // Read 3-pin digital LDR module (VCC, GND, DO)
    int ldrState = digitalRead(LDR_PIN);
    darkDetected = (ldrState == (DARKNESS_IS_LOW ? LOW : HIGH));
    ldrRawValue = darkDetected ? 1 : 0;

    setRelay(darkDetected);

    // Debug print sensors every 2 seconds to Serial Monitor
    static unsigned long lastSensorsDebug = 0;
    if (millis() - lastSensorsDebug >= 2000) {
      lastSensorsDebug = millis();
      Serial.print("[SENSORS] LDR Pin 33: ");
      Serial.print(ldrState == HIGH ? "HIGH" : "LOW");
      Serial.print(" | Dark: ");
      Serial.print(darkDetected ? "YES (Street Light ON)"
                                : "NO (Daylight OFF)");
      Serial.print(" | MQ-2 Smoke: ");
      Serial.println(mq2Value);
    }

    sosPressed = digitalRead(SOS_BUTTON) == LOW;

    bool shakeDetected = false;
    if (mpuAvailable) {
      readTilt();

      // Check 1: Dynamic tilt angle change from baseline
      bool angleTilted = fabs(tiltX - baselineTiltX) >= tiltDeltaThreshold ||
                         fabs(tiltY - baselineTiltY) >= tiltDeltaThreshold;

      // Check 2: Shake / Impact acceleration jerk (instant response to pole
      // being shaken)
      shakeDetected = (shakeIntensity >= SHAKE_JERK_THRESHOLD);

      tiltDetected = angleTilted || shakeDetected;
    } else {
      tiltDetected = false;
    }

    if (tiltDetected && !previousTilt) {
      if (shakeDetected) {
        raiseAccidentAlert("Pole Shaking / Impact");
      } else {
        raiseAccidentAlert("Pole Tilt / Fall Detected");
      }
    }

    if (sosPressed && !previousSOS) {
      raiseAccidentAlert("SOS Call");
    }

    if (smokeDetected && !previousSmoke) {
      Serial.println("Smoke/gas threshold exceeded.");
      triggerBuzzerAlert(ALERT_SMOKE);
    }

    if (motionDetected && !previousMotion) {
      Serial.println("PIR motion detected.");
      triggerBuzzerAlert(ALERT_MOTION);
    }

    previousTilt = tiltDetected;
    previousSOS = sosPressed;
    previousSmoke = smokeDetected;
    previousMotion = motionDetected;
  }

  updateBuzzer();
}
