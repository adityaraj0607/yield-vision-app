"""
Yield-Vision — YOLOv5 PCB Defect Model Training Script
=======================================================
Usage:
  python train_model.py

What this does:
  1. Installs YOLOv5 requirements
  2. Downloads a public PCB defect dataset (DeepPCB / synthetic)
  3. Generates synthetic annotated training data as fallback
  4. Trains YOLOv5s for 50 epochs
  5. Copies best.pt → model/best.pt (auto-loaded by app.py)

After training, restart app.py — it will load the real model.
"""

import os, sys, shutil, random, math, urllib.request, zipfile, subprocess, json
import numpy as np

BASE    = os.path.dirname(os.path.abspath(__file__))
YOLO_DIR = os.path.join(BASE, 'yolov5_repo')
DATA_DIR = os.path.join(BASE, 'dataset')
MODEL_OUT = os.path.join(BASE, 'model')
os.makedirs(MODEL_OUT, exist_ok=True)
os.makedirs(DATA_DIR,  exist_ok=True)

# ─── Class definitions (must match app.py DEFECT_CLASSES keys) ────────────────
CLASSES = [
    "missing_component",
    "dry_solder_joint",
    "trace_anomaly",
    "tombstoning",
    "solder_bridge",
    "component_shift",
    "burnt_component",
    "open_circuit",
    "short_circuit",
]

# ─── STEP 1: Clone / update YOLOv5 ───────────────────────────────────────────
def setup_yolov5():
    print("\n[1/4] Setting up YOLOv5...")
    if not os.path.isdir(YOLO_DIR):
        subprocess.run(["git", "clone", "--depth=1",
                        "https://github.com/ultralytics/yolov5", YOLO_DIR], check=True)
    # Install requirements
    req = os.path.join(YOLO_DIR, 'requirements.txt')
    subprocess.run([sys.executable, "-m", "pip", "install", "-r", req,
                    "--quiet"], check=True)
    subprocess.run([sys.executable, "-m", "pip", "install",
                    "torch", "torchvision", "--quiet"])
    print("   YOLOv5 ready.")


# ─── STEP 2: Generate synthetic training data ─────────────────────────────────
def make_synthetic_pcb(w=640, h=640):
    """Render a synthetic PCB image with random components."""
    img = np.zeros((h, w, 3), np.uint8)
    img[:] = (8, 22, 12)
    # Traces
    for i in range(20):
        x = random.randint(20, w-20)
        cv2_line_safe(img, x, 0, x, h, (0, 40+i*6, 15))
    for i in range(14):
        y = random.randint(20, h-20)
        cv2_line_safe(img, 0, y, w, y, (0, 30+i*5, 12))
    # Pads
    pads = []
    for _ in range(random.randint(10, 25)):
        cx = random.randint(40, w-40)
        cy = random.randint(40, h-40)
        pw = random.randint(20, 55)
        ph = random.randint(12, 30)
        pads.append((cx, cy, pw, ph))
        col = (random.randint(15,50), random.randint(80,160), random.randint(30,80))
        import cv2 as _cv2
        _cv2.rectangle(img, (cx-pw, cy-ph), (cx+pw, cy+ph), col, -1)
        _cv2.rectangle(img, (cx-pw, cy-ph), (cx+pw, cy+ph), (0, 180, 90), 1)
    return img, pads


def cv2_line_safe(img, x1, y1, x2, y2, col):
    import cv2 as _cv2
    _cv2.line(img, (x1, y1), (x2, y2), col, 1)


def inject_defect(img, defect_class, pads, w=640, h=640):
    """Add a visible defect to the image; return YOLO bbox annotation."""
    import cv2 as _cv2
    cls_idx = CLASSES.index(defect_class)

    if pads and random.random() > 0.3:
        cx, cy, pw, ph = random.choice(pads)
    else:
        cx = random.randint(60, w-60)
        cy = random.randint(60, h-60)
        pw, ph = 35, 20

    dw = random.randint(pw, pw+40)
    dh = random.randint(ph, ph+30)
    x1, y1 = max(0, cx-dw), max(0, cy-dh)
    x2, y2 = min(w, cx+dw), min(h, cy+dh)

    if defect_class == "missing_component":
        _cv2.rectangle(img, (x1, y1), (x2, y2), (0, 0, 0), -1)
        _cv2.rectangle(img, (x1, y1), (x2, y2), (0, 0, 200), 1)
    elif defect_class == "solder_bridge":
        _cv2.line(img, (cx-dw, cy), (cx+dw, cy), (200, 200, 150), 5)
    elif defect_class == "dry_solder_joint":
        for _ in range(5):
            jx = cx + random.randint(-dw, dw)
            jy = cy + random.randint(-dh, dh)
            _cv2.circle(img, (jx, jy), random.randint(3, 8), (80, 80, 200), -1)
    elif defect_class == "burnt_component":
        _cv2.rectangle(img, (x1, y1), (x2, y2), (10, 10, 80), -1)
        for _ in range(8):
            bx = random.randint(x1, x2)
            by = random.randint(y1, y2)
            _cv2.circle(img, (bx, by), random.randint(2, 6), (0, 0, 150), -1)
    elif defect_class in ("open_circuit", "short_circuit"):
        _cv2.line(img, (x1, cy), (x2, cy), (0, 0, 255), 3)
    elif defect_class == "trace_anomaly":
        pts = np.array([[x1, cy], [cx, y1], [x2, cy], [cx, y2]], np.int32)
        _cv2.polylines(img, [pts], True, (0, 200, 200), 2)
    elif defect_class == "tombstoning":
        _cv2.rectangle(img, (cx-8, y1), (cx+8, y2), (100, 50, 200), -1)
    elif defect_class == "component_shift":
        _cv2.rectangle(img, (x1, y1), (x2, y2), (0, 150, 80), -1)
        _cv2.rectangle(img, (x1+8, y1+8), (x2+8, y2+8), (0, 100, 60), 2)

    # YOLO format: cls cx cy w h  (normalized)
    bx = ((x1 + x2) / 2) / w
    by = ((y1 + y2) / 2) / h
    bw = (x2 - x1) / w
    bh = (y2 - y1) / h
    return f"{cls_idx} {bx:.6f} {by:.6f} {bw:.6f} {bh:.6f}"


def generate_dataset(n_train=600, n_val=120):
    print(f"\n[2/4] Generating synthetic dataset ({n_train} train + {n_val} val)...")
    import cv2 as _cv2

    for split, n in [("train", n_train), ("val", n_val)]:
        img_dir = os.path.join(DATA_DIR, split, "images")
        lbl_dir = os.path.join(DATA_DIR, split, "labels")
        os.makedirs(img_dir, exist_ok=True)
        os.makedirs(lbl_dir, exist_ok=True)

        for i in range(n):
            img, pads = make_synthetic_pcb()
            labels = []
            n_defects = random.randint(1, 3)
            for _ in range(n_defects):
                cls  = random.choice(CLASSES)
                lbl  = inject_defect(img, cls, pads)
                labels.append(lbl)

            stem = f"{split}_{i:05d}"
            _cv2.imwrite(os.path.join(img_dir, stem + ".jpg"), img,
                         [_cv2.IMWRITE_JPEG_QUALITY, 95])
            with open(os.path.join(lbl_dir, stem + ".txt"), "w") as f:
                f.write("\n".join(labels))

            if (i+1) % 100 == 0:
                print(f"   {split} {i+1}/{n} generated")

    print("   Dataset ready.")


# ─── STEP 3: Write data.yaml ──────────────────────────────────────────────────
def write_yaml():
    yaml_path = os.path.join(DATA_DIR, "data.yaml")
    content = f"""path: {DATA_DIR}
train: train/images
val:   val/images

nc: {len(CLASSES)}
names: {CLASSES}
"""
    with open(yaml_path, "w") as f:
        f.write(content)
    print(f"   data.yaml → {yaml_path}")
    return yaml_path


# ─── STEP 4: Train ────────────────────────────────────────────────────────────
def train(yaml_path, epochs=50, imgsz=640, batch=8):
    print(f"\n[3/4] Training YOLOv5s for {epochs} epochs (batch={batch}, imgsz={imgsz})...")
    print("      This will take several minutes. Progress shown below.\n")
    train_script = os.path.join(YOLO_DIR, "train.py")
    run_dir = os.path.join(BASE, "runs", "train")
    os.makedirs(run_dir, exist_ok=True)
    cmd = [
        sys.executable, train_script,
        "--img",     str(imgsz),
        "--batch",   str(batch),
        "--epochs",  str(epochs),
        "--data",    yaml_path,
        "--weights", "yolov5s.pt",
        "--project", run_dir,
        "--name",    "pcb_defects",
        "--exist-ok",
        "--workers", "2",
    ]
    result = subprocess.run(cmd, cwd=YOLO_DIR)
    if result.returncode != 0:
        print("  ⚠  Training failed. Check output above.")
        sys.exit(1)


# ─── STEP 5: Copy best.pt ─────────────────────────────────────────────────────
def copy_best():
    print("\n[4/4] Looking for best.pt...")
    candidates = [
        os.path.join(BASE, "runs", "train", "pcb_defects", "weights", "best.pt"),
    ]
    for c in candidates:
        if os.path.isfile(c):
            dst = os.path.join(MODEL_OUT, "best.pt")
            shutil.copy(c, dst)
            print(f"   ✓  Saved to {dst}")
            print("\n   ► Restart app.py — real model will load automatically!\n")
            return
    print("   ✗  best.pt not found. Check training output.")


# ─── MAIN ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 60)
    print("  Yield-Vision — YOLOv5 PCB Defect Model Trainer")
    print("=" * 60)

    try:
        import cv2
    except ImportError:
        subprocess.run([sys.executable, "-m", "pip", "install", "opencv-python"])
        import cv2

    setup_yolov5()
    generate_dataset(n_train=600, n_val=120)
    yaml_path = write_yaml()
    train(yaml_path, epochs=50)
    copy_best()
