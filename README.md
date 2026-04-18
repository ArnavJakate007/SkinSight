# SkinSight AI - AI Skin Health Analyzer

**Upload a selfie → Get a full dermatological-grade visual skin report in under 5 seconds.**

SkinSight AI is an intelligent web application that analyzes facial skin conditions using computer vision and AI, delivering instant, visual, and actionable insights - making professional-level skin analysis accessible to everyone.

---

## **Problem Statement**

- **3 billion people** worldwide lack access to a dermatologist.
- Dermatology consultations cost **$150–$300+** with **3–6 week** waiting times.
- **85% of skin conditions** are visually diagnosable, yet remain undetected due to access barriers.
- Existing apps lack **visual depth**, **medical-grade accuracy**, and **skin-tone inclusivity**.

**Result:** Millions suffer in silence with preventable or treatable skin issues.

---

## **Our Solution**

**SkinSight AI** bridges the gap between self-diagnosis and professional care.

**How it works:**

1. User uploads a clear facial photo
2. AI processes the image in real-time
3. Delivers a **structured, visual-first dermatological report**

### Core Outputs

- **Acne Severity Grading** (Clear → Mild → Moderate → Severe)
- **Lesion Detection** with color-coded bounding boxes
- **Facial Zone Segmentation** (Forehead, Cheeks, Nose, Chin/Jawline)
- **Hyperpigmentation Coverage** estimation with traced overlays
- **Progress Tracking** (Now / Short-term / Long-term)

---

## **Unique Selling Points (USPs)**

- **Visual-first interface** - All findings overlaid directly on the user's photo
- **Real-time inference** (< 5 seconds)
- **Non-diagnostic framing** - Medically responsible language
- **Skin-tone inclusive** - Trained across **Fitzpatrick Scale I–VI**
- **Mobile-friendly** web app

---

## **Tech Stack**

| Layer                 | Technology                                       |
| --------------------- | ------------------------------------------------ |
| **Frontend**          | React.js + TailwindCSS                           |
| **Backend**           | FastAPI (Python)                                 |
| **CV Models**         | YOLOv8 (lesion detection), MediaPipe (face mesh) |
| **Segmentation**      | SAM (Segment Anything) / DeepLabv3               |
| **Hyperpigmentation** | OpenCV HSV + Custom Skin Tone Calibration        |
| **LLM Layer**         | Claude (Anthropic) API                           |
| **Deployment**        | Docker + Render / Hugging Face Spaces            |

**Pipeline Flow:**

`Image Upload → Preprocessing → Face Mesh → Zone Segmentation → Lesion Detection → Hyperpigmentation Analysis → Severity Scoring → Visual Overlays → LLM Summary`

---

## System Architecture

### End-to-End Inference Pipeline

```mermaid
flowchart TD
    A[User Photo Upload]
    --> B[Image Preprocessing<br/>Resize • Normalize • Lighting Correction]

    B --> C[MediaPipe Face Mesh<br/>468 Landmark Detection]

    C --> D[Facial Zone Segmentation<br/>Forehead • Cheeks • Nose • Chin+Jawline]

    D --> E[YOLOv8 Lesion Detection<br/>Bounding Boxes + Classification]
    D --> F[Hyperpigmentation Analysis<br/>OpenCV HSV + Skin Tone Calibration]

    E & F --> G[Severity Scoring Engine<br/>Rule-based + ML Classifier]

    G --> H[Visual Overlay Composer<br/>Annotated Image Generation]

    H --> I[Claude LLM Layer<br/>Report + Recommendations]

    I --> J[Final Structured Report<br/>+ Annotated Photo]

    classDef input fill:#2563EB,stroke:#1E3A8A,color:#fff,rx:20,ry:20
    classDef process fill:#10B981,stroke:#166534,color:#fff,rx:20,ry:20
    classDef core fill:#8B5CF6,stroke:#5B21B6,color:#fff,rx:20,ry:20
    classDef output fill:#F59E0B,stroke:#B45309,color:#fff,rx:20,ry:20

    class A input
    class B,C process
    class D,E,F,G,H core
    class I,J output
```

---

## Backup Support

Environment variables:

- `SKINSIGHT_SQLITE_PATH` (optional, default `backend/data/skinsight_backup.sqlite3`): SQLite file path for image/result backups.

Backups saved in SQLite:

- `analyze_backup`: original uploaded image + `/analyze` response JSON
- `track_backup`: baseline/followup images + `/track` response JSON
