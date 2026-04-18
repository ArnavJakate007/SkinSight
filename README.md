# SkinSight AI 

**SkinSight AI** is an intelligent web application that analyzes facial skin conditions using computer vision. Upload a photo and get a visual health report in seconds.

---

##  Quick Setup

### 1. Backend (Python/FastAPI)
```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
python app/main.py
```

### 2. Frontend (React/Vite)
```bash
cd frontend
npm install
npm run dev
```

---

##  Features
- **Acne Grading**: Automated severity detection (Mild to Severe).
- **Lesion Detection**: Color-coded analysis of skin spots.
- **Zone Segmentation**: Analyzes forehead, cheeks, and jawline separately.
- **Progress Tracking**: Compare your skin health over time.

---


##  Tech Stack
- **Frontend**: React.js, CSS
- **Backend**: FastAPI, Python
- **AI/CV**: YOLOv8, MediaPipe, OpenCV
- **Database**: SQLite (for local history)
