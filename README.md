# SkinSight AI 🩺

**SkinSight AI** is an intelligent web application that analyzes facial skin conditions using computer vision. Upload a photo and get a visual health report in seconds.

---

## 🚀 Quick Setup

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

## ✨ Features
- **Acne Grading**: Automated severity detection (Mild to Severe).
- **Lesion Detection**: Color-coded analysis of skin spots.
- **Zone Segmentation**: Analyzes forehead, cheeks, and jawline separately.
- **Progress Tracking**: Compare your skin health over time.

---

## 🤝 How to Contribute
We welcome contributions from everyone! If you want to help improve SkinSight, follow these steps:

1.  **Fork the Repository**: Create your own copy of the project.
2.  **Create a Branch**: `git checkout -b feature/your-feature-name`.
3.  **Make Your Changes**: Add new features, fix bugs, or improve the UI.
4.  **Test Your Code**: Ensure everything runs smoothly locally.
5.  **Submit a Pull Request (PR)**: Explain what you changed and why.

### Areas for Improvement:
- 🎨 **UI/UX**: Better animations or mobile responsiveness.
- 🧠 **ML Models**: Improving accuracy of the YOLOv8 or segmentation models.
- 📝 **Documentation**: Helping others understand the codebase.
- 🐛 **Bug Fixes**: Checking the issue tracker for open bugs.

---

## 🛠 Tech Stack
- **Frontend**: React.js, CSS
- **Backend**: FastAPI, Python
- **AI/CV**: YOLOv8, MediaPipe, OpenCV
- **Database**: SQLite (for local history)
