# Smart Street Safety Pole

A beginner-friendly guide to the **Smart Street Safety Pole** project.

The Smart Street Safety Pole is an IoT-based safety system designed to
help detect possible street emergencies and send information to a
central dashboard. It combines sensors, a microcontroller, a
camera-based detection system, and Firebase so that incidents can be
monitored from one place.

> **Project status:** This README describes the intended system.
> Features that depend on your hardware, firmware, Firebase
> configuration, or camera model may need to be completed or verified in
> your setup. Do not treat demo data as live sensor data.

------------------------------------------------------------------------

## Contents

-   [What does the project do?](#what-does-the-project-do)
-   [How the system works](#how-the-system-works)
-   [Main components](#main-components)
-   [Software used](#software-used)
-   [Before you begin](#before-you-begin)
-   [Set up the hardware](#set-up-the-hardware)
-   [Set up Firebase](#set-up-firebase)
-   [Run the dashboard](#run-the-dashboard)
-   [Connect the ESP32](#connect-the-esp32)
-   [Calibrate the pole tilt sensor](#calibrate-the-pole-tilt-sensor)
-   [Understand alerts](#understand-alerts)
-   [Troubleshooting](#troubleshooting)
-   [Safety and limitations](#safety-and-limitations)
-   [Future improvements](#future-improvements)

------------------------------------------------------------------------

## What does the project do?

The system brings several safety features together:

### 1. Camera-based accident detection

A camera and computer-vision software look for signs of a possible road
accident. The system can create an alert and attach a camera frame when
evidence is available.

Camera detection can make mistakes. A single suspicious frame should not
automatically be treated as a confirmed accident.

### 2. Gas monitoring

A gas sensor monitors the surrounding air. When its reading passes a
configured threshold, the system can report a warning.

The exact gases detected depend on the sensor. For example, an MQ-2 is a
broad-response sensor and does not identify a specific gas with
laboratory accuracy.

### 3. Emergency SOS

A person can press the physical SOS button to send a manual emergency
alert.

### 4. Pole tilt and impact monitoring

An MPU-6050 accelerometer and gyroscope measure movement and
orientation. The system can use changes from the pole's normal
calibrated position to identify a possible impact or tilt event.

### 5. GPS location

A GPS receiver provides coordinates for the pole or incident. The
dashboard can display the coordinates and open the location in a map.

### 6. Central dashboard

The dashboard brings sensor readings and incident alerts together.
Authorized users can review incidents, inspect available evidence, and
update incident status.

------------------------------------------------------------------------

## How the system works

``` text
Camera ───────────────┐
Gas sensor ───────────┤
MPU-6050 ─────────────┤
SOS button ───────────┤
GPS receiver ─────────┤
                      ▼
                ESP32 / Controller
                      │
                      ▼
             Wi-Fi / Internet connection
                      │
                      ▼
                   Firebase
                      │
                      ▼
              Safety Dashboard
                      │
                      ▼
          Authorized monitoring officers
```

The exact data path depends on the firmware and application
configuration. Some camera processing may run separately from the ESP32.

------------------------------------------------------------------------

## Main components

  -----------------------------------------------------------------------
  Component                           Purpose
  ----------------------------------- -----------------------------------
  ESP32 development board             Reads supported sensors and
                                      communicates over Wi-Fi

  Camera module                       Provides images or video for
                                      computer-vision detection

  MQ-2 gas sensor                     Detects changes in certain
                                      combustible gases and smoke-related
                                      conditions

  MPU-6050                            Measures acceleration, rotation,
                                      and pole orientation

  NEO-6M GPS module                   Provides latitude and longitude
                                      when it has a GPS fix

  SOS push button                     Sends a manual emergency signal

  LDR                                 Measures ambient light for
                                      day/night lighting logic

  Relay module and light              Switches the streetlight, when
                                      supported by the wiring and
                                      firmware
  -----------------------------------------------------------------------

**Important:** Check the pin assignments in your own firmware before
connecting components. This table does not define a wiring diagram.

------------------------------------------------------------------------

## Software used

The project may include the following software:

-   Arduino IDE or another ESP32-compatible development environment
-   ESP32 board support package
-   Camera or computer-vision software
-   Firebase Authentication
-   Firebase Realtime Database or Cloud Firestore
-   A web dashboard built with the framework used in this repository

The exact frontend framework and database service should be confirmed
from the project files.

------------------------------------------------------------------------

## Before you begin

You will need:

-   The project source code
-   An ESP32 board and the required sensors
-   A USB data cable
-   A computer with Windows, macOS, or Linux
-   A Wi-Fi network available to the ESP32
-   A Firebase project
-   The software required by the existing project

### Check your USB cable and COM port

On Windows:

1.  Connect the ESP32 to your computer using a USB data cable.
2.  Open **Device Manager**.
3.  Expand **Ports (COM & LPT)**.
4.  Note the COM port shown for the board.
5.  Select that port in the Arduino IDE or your upload tool.

If no port appears, try another USB cable or USB port and check whether
the correct USB-to-serial driver is installed.

------------------------------------------------------------------------

## Set up the hardware

1.  Disconnect power before changing wiring.
2.  Connect each sensor according to the pin assignments in your
    firmware.
3.  Check the voltage requirements of every module.
4.  Confirm that the ESP32 and sensors share a common ground where
    required.
5.  Inspect the wiring before powering the board.
6.  Upload the firmware and check the serial output for sensor readings.

Do not connect a relay or mains-powered streetlight circuit while
experimenting unless you are qualified to work with that voltage. Use a
safe low-voltage test load for demonstrations.

------------------------------------------------------------------------

## Set up Firebase

Firebase stores or synchronizes information used by the dashboard.
Authentication can also control who is allowed to access the monitoring
interface.

### 1. Create a Firebase project

1.  Open the [Firebase Console](https://console.firebase.google.com/).
2.  Create a project or select the project's existing Firebase project.
3.  Add a Web App if the dashboard uses the Firebase Web SDK.
4.  Copy the web app configuration into the location expected by the
    project.

### 2. Enable the database used by the project

Check the source code to see whether it uses **Realtime Database** or
**Cloud Firestore**. Enable and configure the same service rather than
creating a different database without updating the code.

### 3. Enable Authentication

If login and signup use Firebase email/password authentication:

1.  Open **Authentication** in the Firebase Console.
2.  Select **Sign-in method**.
3.  Enable **Email/Password**.
4.  Configure the authorized officer or administrator role according to
    the project's access-control design.

A successful signup should not automatically grant administrator
privileges.

### 4. Configure security

-   Do not publish service-account credentials.
-   Do not store passwords in the database.
-   Use Firebase Security Rules to restrict access.
-   Verify authorization on the server or through secure Firebase
    rules---not only by hiding buttons in the browser.
-   Keep private configuration out of public repositories.

Follow the configuration expected by the existing project. Never replace
working Firebase paths or rules without checking their effect on the
ESP32 and dashboard.

------------------------------------------------------------------------

## Run the dashboard

The exact commands depend on the frontend framework and the scripts in
the repository.

### 1. Open the project folder

Open the dashboard's folder in your code editor or terminal.

### 2. Check the project instructions

Look for files such as:

-   `package.json`
-   `.env.example`
-   `vite.config.*`
-   `README` files in subfolders

If the project uses Node.js, install a compatible Node.js version before
continuing.

### 3. Install dependencies

For a typical Node.js project, the package manager may be npm. If the
repository contains a `package-lock.json`, a common installation command
is:

``` bash
npm install
```

### 4. Start the development server

Check the `scripts` section of `package.json` and use the command
defined there. A common command for a Vite project is:

``` bash
npm run dev
```

A different project may use another command. Do not assume this command
applies until you check `package.json`.

### 5. Open the local website

Use the local URL printed in the terminal. It may look similar to:

``` text
http://localhost:5173
```

The port may be different in your project.

### Demo mode

If Firebase or the hardware is not connected, the dashboard may provide
demo data. Look for a demo-mode indicator. Demo readings and incidents
are for interface testing only and must not be described as live
hardware data.

------------------------------------------------------------------------

## Connect the ESP32

1.  Open the firmware project in the supported IDE.
2.  Select the correct ESP32 board.
3.  Select the COM port shown in Device Manager.
4.  Configure the Wi-Fi credentials using the project's supported
    method.
5.  Configure the Firebase connection details expected by the firmware.
6.  Upload the firmware.
7.  Open the serial monitor at the baud rate configured in the code.
8.  Check that the board starts and reports sensor or connection status.
9.  Confirm that new readings appear in the expected Firebase location.
10. Confirm that the dashboard receives and displays those readings.

Use the actual Firebase database paths and field names from the
firmware. If the dashboard expects a different field name, correct the
data mapping consistently rather than hardcoding a value in the UI.

------------------------------------------------------------------------

## Calibrate the pole tilt sensor

The MPU-6050 may be mounted at an angle. Its raw orientation is not
necessarily the same as the pole's normal installed orientation.

### Beginner calibration procedure

1.  Install the pole or sensor in its normal resting position.
2.  Make sure the pole is steady and not being touched.
3.  Open the dashboard's **Tilt Calibration** section, if available.
4.  Select **Calibrate**.
5.  Wait while the system collects multiple sensor samples.
6.  Save the calibration when prompted.
7.  Check that the displayed tilt is close to the calibrated baseline.
8.  Gently move the sensor and confirm that the readings change.
9.  Return it to its normal position and check that the readings return
    near the baseline.

Calibration should not be performed while the pole is moving or during
an active incident.

### Understanding the threshold

An accident threshold should be based on the **change from the
calibrated baseline**, not simply the sensor's absolute angle.

For example, if the pole normally rests at approximately -63° on one
axis, that angle should not by itself trigger an accident alert.

Use the project's configured threshold and test it carefully. A
threshold that is too sensitive may create false alerts; one that is too
high may miss real movement.

------------------------------------------------------------------------

## Understand alerts

The dashboard may show different types of alerts:

  -----------------------------------------------------------------------
  Alert                               Meaning
  ----------------------------------- -----------------------------------
  Camera detection                    The camera software detected a
                                      possible incident

  Gas warning                         The gas reading crossed a
                                      configured threshold

  Pole tilt / impact                  The sensor detected movement beyond
                                      its configured criteria

  SOS                                 A person manually activated the
                                      emergency button
  -----------------------------------------------------------------------

An alert is an indication that something may need attention. It is not
proof that an accident or gas leak has occurred.

For camera alerts, inspect the available evidence and validation status.
If no evidence is available, the dashboard should say so instead of
displaying an unrelated frame.

------------------------------------------------------------------------

## Troubleshooting

### ESP32 COM port is missing

-   Try a USB data cable instead of a charge-only cable.
-   Try another USB port.
-   Check Device Manager.
-   Install the correct USB-to-serial driver for the board.
-   Close any serial monitor or application that may already be using
    the port.

### ESP32 cannot connect to Wi-Fi

-   Check the Wi-Fi name and password.
-   Confirm that the network is available to the board.
-   Check the serial monitor for connection errors.
-   Verify that the firmware uses the correct network configuration.

### Firebase data is not appearing

-   Confirm that the ESP32 is connected to Wi-Fi.
-   Check the Firebase project configuration.
-   Verify that the firmware is writing to the expected database path.
-   Check the database field names and data types.
-   Review Firebase Security Rules.
-   Check the browser console for dashboard errors.

### Tilt is always showing an accident

-   Check the sensor mounting position.
-   Confirm that calibration was completed while stationary.
-   Verify the X/Y axis calculations.
-   Check whether the threshold uses calibrated angle differences.
-   Inspect sensor noise and filtering.

### Accident alerts are too frequent

-   Review camera confidence thresholds.
-   Check whether a single frame can trigger an alert.
-   Enable multi-frame validation if supported.
-   Check for duplicate incident generation.
-   Verify that the camera evidence corresponds to the detected event.
-   Review the configured cooldown and sensor validation logic.

### GPS coordinates appear, but the map marker is missing

-   Confirm that latitude and longitude are valid numbers.
-   Check whether the map expects `[latitude, longitude]` or
    `[longitude, latitude]`.
-   Verify that the marker receives the latest coordinates.
-   Check the browser console for map errors.
-   Confirm that the map container has a visible height.
-   Retain the last valid position when a temporary GPS update is
    unavailable.

### Login or signup is not working

-   Confirm that Email/Password authentication is enabled in Firebase.
-   Check the Firebase web configuration.
-   Review the browser console and Firebase Authentication error.
-   Confirm that the current user's role is authorized to access the
    dashboard.
-   Check that security rules allow the intended operation.

------------------------------------------------------------------------

## Safety and limitations

-   This project is a prototype and should not be treated as a certified
    emergency response system.
-   Camera-based detection can produce false positives and false
    negatives.
-   Gas sensor readings depend on sensor calibration, environment, and
    the gases present.
-   GPS accuracy depends on satellite reception and the surrounding
    environment.
-   The MPU-6050 measures movement; it cannot independently prove that a
    road accident occurred.
-   Do not rely on the dashboard as the only way to contact emergency
    services.
-   Test the system using safe, controlled scenarios.
-   Do not expose private Firebase credentials or real user information
    in screenshots or public repositories.

------------------------------------------------------------------------

## Future improvements

Possible future improvements include:

-   Better camera detection with validated training data.
-   More robust multi-sensor incident confirmation.
-   Incident history and analytics.
-   Officer roles and approval workflows.
-   Improved GPS mapping.
-   Sensor health monitoring.
-   Automated system diagnostics.
-   More detailed calibration and testing tools.

------------------------------------------------------------------------

## Project slogan

**Smart Street Safety Pole --- Detect Early. Alert Faster. Protect Every
Street.**

Built as an IoT-based public safety project to bring camera detection,
sensor monitoring, emergency reporting, and centralized incident
management into one platform.
