"""
SafePole – YOLOv8 Fire & Smoke Detection Sidecar
=================================================
Reads the live MJPEG stream from the ESP32-CAM (via the Node.js proxy),
runs YOLOv8 inference every frame, draws bounding boxes in an OpenCV
window, and POSTs /api/fire-alert to the Node.js server whenever fire
or smoke is detected above the confidence threshold.

Setup (one-time):
    pip install -r requirements.txt
    python fire_ai.py --download-model     # grabs the fire model weights

Run:
    python fire_ai.py

Options (edit CONFIG below or pass as CLI args):
    --stream  URL of MJPEG stream  (default: http://localhost:5000/api/camera-stream)
    --server  Node.js server URL   (default: http://localhost:5000)
    --model   Path to .pt weights  (default: ai/models/fire_best.pt)
    --conf    Confidence threshold (default: 0.45)
    --no-gui  Suppress OpenCV window (useful on headless servers)
"""

import argparse
import sys
import os
import time
import threading
import urllib.request

import cv2
import numpy as np
import requests
from ultralytics import YOLO

# ─── CONFIG ────────────────────────────────────────────────────────────────────
DEFAULT_STREAM   = "http://localhost:5000/api/camera-stream"
DEFAULT_SERVER   = "http://localhost:5000"
DEFAULT_MODEL    = os.path.join(os.path.dirname(__file__), "models", "fire_best.pt")
FALLBACK_MODEL   = "yolov8n.pt"          # used if fire_best.pt not found
CONF_THRESHOLD   = 0.45                  # minimum confidence to report
ALERT_COOLDOWN   = 10.0                  # seconds between repeated POSTs
DISPLAY_SCALE    = 1.0                   # scale the OpenCV window (1.0 = native)
WINDOW_TITLE     = "SafePole – YOLOv8 Fire Detection"

# Fire / smoke class names from a standard fire dataset (Roboflow fire-smoke-ultralytics)
# When using a generic COCO model as fallback, we map 'fire' if the model supports it
FIRE_CLASSES     = {"fire", "smoke", "flame", "fire-smoke"}
COCO_FIRE_IDS    = set()  # COCO doesn't have fire; fallback mode uses pixel heuristics

# ─── MODEL DOWNLOAD ───────────────────────────────────────────────────────────
FIRE_MODEL_URL = (
    "https://github.com/spacewalk01/yolov8-fire-detection/releases/download/v1.0/best.pt"
)

def download_model(dest: str):
    """Download pre-trained YOLOv8 fire model weights."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    print(f"[AI] Downloading fire model → {dest}")
    print(f"[AI] Source: {FIRE_MODEL_URL}")
    try:
        urllib.request.urlretrieve(
            FIRE_MODEL_URL,
            dest,
            reporthook=lambda b, bs, ts: print(
                f"\r[AI] {min(b*bs, ts) / 1024:.0f} KB / {ts/1024:.0f} KB", end=""
            )
        )
        print("\n[AI] Download complete ✓")
    except Exception as e:
        print(f"\n[AI] Download failed: {e}")
        print("[AI] Tip: manually download a YOLOv8 fire model and save it as:")
        print(f"     {dest}")
        sys.exit(1)

# ─── MJPEG STREAM READER ──────────────────────────────────────────────────────
class MJPEGStream:
    """Thread-safe MJPEG stream consumer. Decodes boundary-delimited JPEG frames."""

    def __init__(self, url: str):
        self.url    = url
        self.frame  = None
        self.lock   = threading.Lock()
        self.alive  = True
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()

    def _read_loop(self):
        while self.alive:
            try:
                print(f"[Stream] Connecting → {self.url}")
                resp = requests.get(self.url, stream=True, timeout=10)
                buf  = bytes()
                for chunk in resp.iter_content(chunk_size=4096):
                    if not self.alive:
                        break
                    buf += chunk
                    # Look for JPEG start/end markers
                    a = buf.find(b'\xff\xd8')
                    b_ = buf.find(b'\xff\xd9')
                    if a != -1 and b_ != -1 and b_ > a:
                        jpg = buf[a:b_ + 2]
                        buf = buf[b_ + 2:]
                        frame = cv2.imdecode(np.frombuffer(jpg, dtype=np.uint8), cv2.IMREAD_COLOR)
                        if frame is not None:
                            with self.lock:
                                self.frame = frame
            except Exception as e:
                print(f"[Stream] Error: {e}. Retrying in 2 s…")
                time.sleep(2)

    def read(self):
        with self.lock:
            return self.frame.copy() if self.frame is not None else None

    def stop(self):
        self.alive = False

# ─── FIRE ALERT ───────────────────────────────────────────────────────────────
last_alert_time = 0.0

def post_alert(server_url: str, confidence: float, boxes: list, frame: np.ndarray):
    """POST a fire detection event to the Node.js server."""
    global last_alert_time
    now = time.time()
    if now - last_alert_time < ALERT_COOLDOWN:
        return
    last_alert_time = now

    payload = {
        "confidence": round(float(confidence) * 100, 1),
        "timestamp":  time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source":     "YOLOv8-Python",
        "boxes":      boxes,
    }

    try:
        r = requests.post(f"{server_url}/api/fire-alert", json=payload, timeout=3)
        status = r.json().get("caseId", "?")
        print(f"[Alert] POSTed → {server_url}/api/fire-alert | Case: {status}")
    except Exception as e:
        print(f"[Alert] POST failed: {e}")


# ─── PIXEL HEURISTIC (fallback when model has no fire class) ──────────────────
def pixel_fire_ratio(frame: np.ndarray) -> float:
    """Return fraction of pixels that match HSV flame colour (0-45°, S≥50%, V≥45%)."""
    hsv  = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, np.array([0, 128, 115]), np.array([25, 255, 255]))
    return float(mask.sum()) / (frame.shape[0] * frame.shape[1] * 255)


# ─── DRAW OVERLAY ─────────────────────────────────────────────────────────────
def draw_boxes(frame: np.ndarray, results, class_names: dict, conf_thresh: float):
    """Draw YOLOv8 bounding boxes on the frame. Returns list of box dicts & max conf."""
    boxes_out = []
    max_conf  = 0.0

    for r in results:
        for box in r.boxes:
            conf = float(box.conf[0])
            cls  = int(box.cls[0])
            label = class_names.get(cls, str(cls)).lower()

            is_fire = label in FIRE_CLASSES or cls in COCO_FIRE_IDS
            if not is_fire or conf < conf_thresh:
                continue

            x1, y1, x2, y2 = map(int, box.xyxy[0])
            max_conf = max(max_conf, conf)

            # Red bounding box
            cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 0, 220), 3)

            # Label badge
            tag = f"{label.upper()}  {conf:.0%}"
            tw, th = cv2.getTextSize(tag, cv2.FONT_HERSHEY_DUPLEX, 0.65, 1)[0]
            cv2.rectangle(frame, (x1, y1 - th - 10), (x1 + tw + 8, y1), (0, 0, 200), -1)
            cv2.putText(frame, tag, (x1 + 4, y1 - 5),
                        cv2.FONT_HERSHEY_DUPLEX, 0.65, (255, 255, 255), 1, cv2.LINE_AA)

            boxes_out.append({"x1": x1, "y1": y1, "x2": x2, "y2": y2,
                               "conf": round(conf, 3), "label": label})

    return boxes_out, max_conf


# ─── HUD OVERLAY ──────────────────────────────────────────────────────────────
def draw_hud(frame: np.ndarray, fps: float, fire_detected: bool, model_name: str):
    h, w = frame.shape[:2]

    # Status banner
    if fire_detected:
        cv2.rectangle(frame, (0, 0), (w, 34), (0, 0, 180), -1)
        cv2.putText(frame, "  \U0001f525 FIRE DETECTED – Alerting Dashboard",
                    (8, 23), cv2.FONT_HERSHEY_DUPLEX, 0.7, (255, 255, 255), 1, cv2.LINE_AA)
    else:
        cv2.rectangle(frame, (0, 0), (w, 30), (20, 20, 20), -1)
        cv2.putText(frame, f"  SafePole AI  |  {model_name}  |  {fps:.1f} FPS",
                    (6, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 230, 120), 1, cv2.LINE_AA)

    # Timestamp bottom-left
    ts = time.strftime("%Y-%m-%d  %H:%M:%S")
    cv2.rectangle(frame, (0, h - 26), (260, h), (10, 10, 10), -1)
    cv2.putText(frame, ts, (6, h - 8),
                cv2.FONT_HERSHEY_SIMPLEX, 0.50, (180, 180, 180), 1, cv2.LINE_AA)


# ─── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="SafePole YOLOv8 Fire Detection")
    parser.add_argument("--stream",         default=DEFAULT_STREAM)
    parser.add_argument("--server",         default=DEFAULT_SERVER)
    parser.add_argument("--model",          default=DEFAULT_MODEL)
    parser.add_argument("--conf",           type=float, default=CONF_THRESHOLD)
    parser.add_argument("--no-gui",         action="store_true")
    parser.add_argument("--download-model", action="store_true",
                        help="Download fire model weights and exit")
    args = parser.parse_args()

    # ── Download mode ──
    if args.download_model:
        download_model(args.model)
        return

    # ── Load model ──
    model_path = args.model
    if not os.path.exists(model_path):
        print(f"[AI] Fire model not found at: {model_path}")
        print(f"[AI] Run once with:  python fire_ai.py --download-model")
        print(f"[AI] Falling back to generic YOLOv8n (reduced fire accuracy)…")
        model_path = FALLBACK_MODEL

    print(f"[AI] Loading model: {model_path}")
    model = YOLO(model_path)
    class_names = model.names  # {0: 'fire', 1: 'smoke', ...}
    model_label = os.path.basename(model_path).replace(".pt", "")
    print(f"[AI] Model ready ✓  Classes: {list(class_names.values())}")

    # ── Connect stream ──
    stream = MJPEGStream(args.stream)
    print(f"[AI] Connecting to stream: {args.stream}")
    print(f"[AI] Alert endpoint:        {args.server}/api/fire-alert")
    print(f"[AI] Confidence threshold:  {args.conf:.0%}")
    print(f"[AI] Press Q in the window to quit.\n")

    # Wait for first frame
    for _ in range(30):
        if stream.read() is not None:
            break
        time.sleep(0.2)

    fps_timer   = time.time()
    frame_count = 0
    fps         = 0.0

    while True:
        frame = stream.read()
        if frame is None:
            time.sleep(0.05)
            continue

        # ── Inference ──
        results = model(frame, conf=args.conf, verbose=False)
        boxes, max_conf = draw_boxes(frame, results, class_names, args.conf)

        # Pixel heuristic as supplementary signal when model has no fire class
        pix_ratio  = pixel_fire_ratio(frame)
        fire_by_px = pix_ratio > 0.05 and not class_names  # only if model has no classes

        fire_detected = len(boxes) > 0 or fire_by_px

        # ── Alert ──
        if fire_detected:
            effective_conf = max_conf if max_conf > 0 else min(pix_ratio * 15, 1.0)
            post_alert(args.server, effective_conf, boxes, frame)

        # ── FPS ──
        frame_count += 1
        if time.time() - fps_timer >= 1.0:
            fps = frame_count / (time.time() - fps_timer)
            frame_count = 0
            fps_timer = time.time()

        # ── GUI ──
        if not args.no_gui:
            display = frame.copy()
            draw_hud(display, fps, fire_detected, model_label)

            if DISPLAY_SCALE != 1.0:
                dh, dw = display.shape[:2]
                display = cv2.resize(display,
                                     (int(dw * DISPLAY_SCALE), int(dh * DISPLAY_SCALE)))

            cv2.imshow(WINDOW_TITLE, display)
            key = cv2.waitKey(1) & 0xFF
            if key == ord('q') or key == 27:
                break

    stream.stop()
    if not args.no_gui:
        cv2.destroyAllWindows()
    print("[AI] Stopped.")


if __name__ == "__main__":
    main()

