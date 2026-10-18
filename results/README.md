# D-ASK Empirical Evaluation & Benchmarking Deliverables

This directory contains the verified experimental evaluation results, generated publication graphs, raw dataset CSV, live screenshot evidence, and the complete academic evaluation report for **D-ASK: AI-Powered Desktop Assistant**.

---

## 📁 Deliverables Directory Structure

```text
results/
├── D-ASK_Results_and_Graphs_Report.docx  # Complete academic research report with embedded charts & tables
├── test_results.csv                      # Machine-readable per-trial measurements (N = 176)
├── test_summary.json                     # Aggregate metrics, pass/fail counts, and execution metadata
├── README.md                             # This reproducibility guide & findings summary
├── fig1_test_outcome_distribution.png    # Chart 1: Pass vs. Fail distribution
├── fig2_feature_success_rate.png         # Chart 2: Success rate by capability group
├── fig3_operation_latency_comparison.png # Chart 3: Mean & P95 latency by operation class (log scale)
├── fig4_gesture_precision_recall_confusion.png # Chart 4: Pinch hysteresis metrics & confusion matrix
├── fig5_system_resource_telemetry.png    # Chart 5: Idle vs. Active RAM consumption telemetry
├── fig6_ai_prompt_latency.png            # Chart 6: Assistant intent classification latency by prompt
├── graphs/                               # Directory containing 300 DPI publication chart assets
├── screenshots/
│   └── orb_ui_live.png                   # Live 1080p Chromium capture of Three.js holographic UI
└── logs/
    └── sample_eval_records.log           # Sample formatted trial log extract
```

---

## 📊 Summary of Empirical Findings

| Metric Category | Measured Finding | Verification Details |
| :--- | :--- | :--- |
| **Total Test Trials** | **176 trials** across 11 groups | Executed deterministically via `scratch/run_evaluation_suite.ts` |
| **Passed Trials** | **174 (98.86%)** | Verified end-to-end against live processes & APIs |
| **Failed Trials** | **2 (1.14%)** | Negative security edge cases (schema missing param & policy gate) |
| **Blocked Trials** | **0 (0.00%)** | All suites executed safely without unhandled halts |
| **AI Intent Parsing Mean Latency** | **1,610.9 ms** (Median: 1,638.0 ms) | Measured across 5 standardized prompt modalities (3 trials each) |
| **SQLite Preference R/W Latency** | **0.3 ms** write/read | Local SQLite query performance via `better-sqlite3` |
| **Semantic Memory Retrieval Latency**| **936.0 ms** | 1536-dimensional vector embedding + cosine similarity ranking |
| **MediaPipe Gesture Precision/Recall**| **100.0% / 100.0%** | 30 calibrated landmark trials evaluated against hysteresis rules |
| **Memory Footprint Overhead** | **+17.0 MB RAM** | Baseline host RAM: 13,770 MB; Active full-stack RAM: 13,787 MB |
| **Database File Size on Disk** | **496.0 KB** | `.d-ask-memory.db` on Windows NTFS filesystem |

---

## 🛠️ Step-by-Step Test Reproducibility Instructions

### 1. Prerequisites
- **Operating System:** Windows 10/11 (x64)
- **Node.js:** v24.x (or v20+ LTS)
- **Python:** v3.11+ (Python 3.14 tested)

### 2. Install Project & Python Dependencies
```bash
# Node dependencies
npm install

# Setup isolated Python virtual environment for reporting
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

### 3. Build & Launch Next.js Background Server
```bash
# Build Next.js production bundle (Turbopack)
npm run build

# Start local Next.js production server on port 3000
npm run start
```

### 4. Execute the Full Automated Benchmark Suite
```bash
# Runs all 176 automated test trials with high-resolution timers
npx tsx --env-file=.env.local scratch/run_evaluation_suite.ts
```
*Outputs will be saved directly into `results/test_results.csv` and `results/test_summary.json`.*

### 5. Generate Publication Graphs & Academic Report
```bash
# Generate high-resolution 300 DPI matplotlib charts
.venv\Scripts\python scripts/generate_charts.py

# Compile the professional academic Word document
.venv\Scripts\python scripts/build_word_report.py
```
*The compiled document will be updated at `D-ASK_Results_and_Graphs_Report.docx` and `results/D-ASK_Results_and_Graphs_Report.docx`.*

---

## 🔍 Manual Tests Required for Physical Setup

While the automated test suite verified algorithmic, DOM, API, and OS layers, the following two workflows require physical human interaction:

1. **Live Camera Hand Gestures:**
   - Launch the Electron app via `npm run desktop` (or navigate to `http://localhost:3000`).
   - Click **GESTURES OFF** (or press the `G` key) to activate the webcam.
   - Hold your hand 0.5–1.0 meter in front of the lens. Pinch thumb and index fingers to rotate the orb; pinch both hands and spread them apart to zoom.
2. **Android ADB Device Pairing:**
   - Connect an Android phone via USB cable with USB Debugging enabled in Developer Options.
   - When the prompt appears on the phone screen (*"Allow USB debugging?"*), tap **Allow** and check *"Always allow from this computer"*.
   - Verify connection with `adb devices` to transition status from `UNAUTHORIZED` to `device`.
