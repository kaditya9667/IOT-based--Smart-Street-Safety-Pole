/**
 * Smart Street Safety Pole - ESP32 Firmware Base Sketch
 * Direct Integration with Firebase Realtime Database & Firebase Storage
 *
 * Supports:
 * - ESP32-CAM photo capture on emergency trigger
 * - Firebase Storage upload (OV2640 camera frames)
 * - Telemetry and controls syncing
 */

#include "esp_camera.h"          // ESP32-CAM driver library
#include <Firebase_ESP_Client.h> // Library: Firebase ESP Client by Mobizt
#include <TinyGPS++.h>           // Library: TinyGPS++ by Mikal Hart
#include <WiFi.h>

// Helper signatures for Token, RTDB, and Storage helper functions
#include <addons/RTDBHelper.h>
#include <addons/TokenHelper.h>

// --- Configuration ---
const char *ssid = "YOUR_WIFI_SSID";
const char *password = "YOUR_WIFI_PASSWORD";

// Firebase Credentials
#define API_KEY "YOUR_FIREBASE_API_KEY"
#define DATABASE_URL \
  "https://YOUR_PROJECT_ID-default-rtdb.asia-southeast1.firebasedatabase.app/"
#define STORAGE_BUCKET_ID \
  "YOUR_PROJECT_ID.firebasestorage.app"

// --- Pin Definitions (ESP32-CAM / AI-Thinker Pin Mapping) ---
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

// Non-camera Sensor pins (Double check for availability on your module board)
#define LDR_PIN 2      // GPIO 2
#define MQ2_PIN 13     // GPIO 13
#define PIR_PIN 12     // GPIO 12
#define SOS_BTN_PIN 14 // GPIO 14 (Interrupt pin)
#define LIGHT_PIN 15   // GPIO 15 (Relay/LED driver)
#define BUZZER_PIN 16  // GPIO 16 (Siren/Buzzer driver)
#define GPS_RX_PIN 3   // U0RXD
#define GPS_TX_PIN 1   // U0TXD

// --- Object Instances ---
TinyGPSPlus gps;

// Firebase Data Objects
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

// --- Global State ---
unsigned long lastSendTime = 0;
const unsigned long sendInterval = 4000; // Database write interval
bool physicalSosActive = false;
bool caseTriggerActive = false;
bool signupOK = false;

// Interrupt Service Routine for instant SOS button detection
void IRAM_ATTR handleSosPress() { physicalSosActive = true; }

// Function Declarations
void configCamera();
void uploadIncidentCase(String triggerType);

void setup() {
  Serial.begin(115200);

  // Pin Modes
  pinMode(LDR_PIN, INPUT);
  pinMode(MQ2_PIN, INPUT);
  pinMode(PIR_PIN, INPUT);
  pinMode(SOS_BTN_PIN, INPUT_PULLUP);
  pinMode(LIGHT_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);

  // Attach Interrupt to SOS button
  attachInterrupt(digitalPinToInterrupt(SOS_BTN_PIN), handleSosPress, FALLING);

  // Setup camera
  configCamera();

  // Connect to Wi-Fi
  Serial.print("Connecting to Wi-Fi: ");
  Serial.println(ssid);
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWi-Fi Connected!");

  // Assign credentials for Firebase
  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;

  // Sign up anonymously or use credentials
  if (Firebase.signUp(&config, &auth, "", "")) {
    Serial.println("Firebase Auth Sign-Up OK");
    signupOK = true;
  } else {
    Serial.printf("Firebase Auth Sign-Up Failed: %s\n",
                  config.signer.signupError.message.c_str());
  }

  // Assign connection status callback
  config.token_status_callback = tokenStatusCallback;

  // Initialize Firebase Client
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);
}

void loop() {
  if (Firebase.ready() && signupOK) {
    // 1. Check if SOS was pressed or high smoke level is detected
    int mq2Value = analogRead(MQ2_PIN);

    if ((physicalSosActive || mq2Value > 500) && !caseTriggerActive) {
      caseTriggerActive = true; // prevent duplicate case uploads in a row
      String trigger = physicalSosActive ? "SOS_BUTTON" : "SMOKE_ALERT";
      uploadIncidentCase(trigger);
    }

    // 2. Periodic Telemetry Send
    if (millis() - lastSendTime >= sendInterval) {
      lastSendTime = millis();
      sendFirebaseTelemetry();
    }

    // 3. Read Light and SOS Controls from Firebase
    readFirebaseControls();
  }
}

void sendFirebaseTelemetry() {
  int ldrValue = analogRead(LDR_PIN);
  int mq2Value = analogRead(MQ2_PIN);
  bool pirMotion = digitalRead(PIR_PIN) == HIGH;

  double latitude = 12.9715987;
  double longitude = 77.5945627;

  FirebaseJson json;
  json.set("ldrValue", ldrValue);
  json.set("mq2Value", mq2Value);
  json.set("pirMotion", pirMotion);
  json.set("gps/lat", latitude);
  json.set("gps/lng", longitude);
  json.set("lastSeen/.sv", "timestamp");

  if (physicalSosActive) {
    json.set("sosAlert", true);
  }

  if (Firebase.RTDB.updateNode(&fbdo, "/poles/pole_01/telemetry", &json)) {
    Serial.println("Firebase Telemetry Update successful!");
  } else {
    Serial.printf("Firebase Telemetry Update Failed: %s\n",
                  fbdo.errorReason().c_str());
  }
}

void readFirebaseControls() {
  if (Firebase.RTDB.getString(&fbdo, "/poles/pole_01/controls/lightOverride")) {
    if (fbdo.dataType() == "string") {
      String lightOverride = fbdo.stringData();
      int ldrValue = analogRead(LDR_PIN);
      bool pirMotion = digitalRead(PIR_PIN) == HIGH;
      bool lightState = false;

      if (lightOverride == "auto") {
        lightState = ldrValue < 300 || (ldrValue < 500 && pirMotion);
      } else {
        lightState = lightOverride == "on";
      }

      digitalWrite(LIGHT_PIN, lightState ? HIGH : LOW);
      Firebase.RTDB.setBool(&fbdo, "/poles/pole_01/telemetry/lightState",
                            lightState);
    }
  }

  if (Firebase.RTDB.getBool(&fbdo, "/poles/pole_01/telemetry/sosAlert")) {
    if (fbdo.dataType() == "boolean") {
      bool sosAlert = fbdo.boolData();

      if (sosAlert) {
        digitalWrite(BUZZER_PIN, (millis() / 500) % 2 == 0 ? HIGH : LOW);
      } else {
        digitalWrite(BUZZER_PIN, LOW);
        physicalSosActive = false;
        caseTriggerActive = false; // Reset case trigger when SOS is silenced
      }
    }
  }
}

void uploadIncidentCase(String triggerType) {
  Serial.println("Taking snapshot...");

  // Capture picture frame
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Camera capture failed!");
    return;
  }

  // Create unique filename based on time
  String timestampStr = String(millis());
  String fileName = "/cases/case_" + timestampStr + ".jpg";

  Serial.println("Uploading photo to Firebase Storage: " + fileName);

  // Upload to Storage
  if (Firebase.Storage.upload(&fbdo, STORAGE_BUCKET_ID, fb->buf, fb->len,
                              fileName.c_str(), "image/jpeg")) {
    Serial.println("Photo uploaded successfully!");

    // Get file download URL token
    String imageUrl = fbdo.downloadURL();

    // Log Case Metadata node in RTDB
    FirebaseJson caseData;
    caseData.set("timestamp/.sv", "timestamp");
    caseData.set("triggerType", triggerType);
    caseData.set("imageUrl", imageUrl);
    caseData.set("telemetrySnapshot/ldrValue", analogRead(LDR_PIN));
    caseData.set("telemetrySnapshot/mq2Value", analogRead(MQ2_PIN));
    caseData.set("telemetrySnapshot/gps/lat", 12.9715987);
    caseData.set("telemetrySnapshot/gps/lng", 77.5945627);

    String caseNode = "/cases/case_" + timestampStr;
    if (Firebase.RTDB.updateNode(&fbdo, caseNode.c_str(), &caseData)) {
      Serial.println("Incident case logged in RTDB: " + caseNode);
    }
  } else {
    Serial.printf("Photo upload failed: %s\n", fbdo.errorReason().c_str());
  }

  // Return the frame buffer to the driver pool
  esp_camera_fb_return(fb);
}

void configCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
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
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXELFMT_JPEG;

  // Set frame size (QVGA, VGA, SVGA, etc.)
  config.frame_size = FRAMESIZE_VGA;
  config.jpeg_quality = 10;
  config.fb_count = 2;

  // camera init
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x", err);
    return;
  }
}
