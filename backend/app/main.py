import mimetypes
from pathlib import Path

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.auth import (
    authenticate_user,
    get_user_by_id,
    register_user,
    verify_access_token,
)
from app.pipeline import analyze_image, compare_progress
from app.reporting import generate_detailed_report
from app.schemas import (
    AnalysisResult,
    AuthLoginRequest,
    AuthRegisterRequest,
    AuthTokenResponse,
    AuthUserResponse,
    DetailedReportRequest,
    DetailedReportResponse,
    ProgressReport,
    RoutineLogRequest,
    RoutineLogResponse,
    TrackerCompareRequest,
    TrackerCompareResponse,
    TrackerInitResponse,
    TrackerOverviewResponse,
    TrackerReportRequest,
    TrackerReportResponse,
    TrackerUploadResponse,
)
from app.storage import store_analyze_backup, store_track_backup
from app.tracker import (
    compare_tracker_progress,
    generate_tracker_report,
    initialize_tracker,
    log_routine,
    parse_concern_types,
    tracker_asset_dir,
    tracker_overview,
    upload_progress_image,
)

app = FastAPI(title="SkinSight AI MVP", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


TRACKER_ASSET_DIR = tracker_asset_dir()
if Path(TRACKER_ASSET_DIR).exists():
    app.mount(
        "/tracker-assets",
        StaticFiles(directory=str(TRACKER_ASSET_DIR)),
        name="tracker-assets",
    )


def _is_image_upload(file: UploadFile) -> bool:
    if file.content_type and file.content_type.startswith("image/"):
        return True
    guessed, _ = mimetypes.guess_type(file.filename or "")
    return bool(guessed and guessed.startswith("image/"))


def _extract_bearer_token(authorization: str | None) -> str:
    header = (authorization or "").strip()
    if not header:
        raise HTTPException(status_code=401, detail="Authorization header is required")
    if not header.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Authorization must use Bearer token")
    token = header[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Access token is missing")
    return token


@app.get("/")
def read_root():
    return {"message": "SkinSight AI API is running. Use /docs for API documentation."}


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/auth/register", response_model=AuthTokenResponse)
def auth_register(payload: AuthRegisterRequest) -> AuthTokenResponse:
    try:
        user, token = register_user(
            name=payload.name,
            email=payload.email,
            password=payload.password,
        )
        return AuthTokenResponse(access_token=token, user=user)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Registration failed: {exc}") from exc


@app.post("/auth/login", response_model=AuthTokenResponse)
def auth_login(payload: AuthLoginRequest) -> AuthTokenResponse:
    try:
        user, token = authenticate_user(email=payload.email, password=payload.password)
        return AuthTokenResponse(access_token=token, user=user)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Login failed: {exc}") from exc


@app.get("/auth/me", response_model=AuthUserResponse)
def auth_me(authorization: str | None = Header(default=None)) -> AuthUserResponse:
    token = _extract_bearer_token(authorization)
    try:
        user_id = verify_access_token(token)
        user = get_user_by_id(user_id)
        if user is None:
            raise HTTPException(status_code=401, detail="Invalid authentication token")
        return user
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


@app.post("/analyze", response_model=AnalysisResult)
async def analyze(file: UploadFile = File(...)) -> AnalysisResult:
    if not _is_image_upload(file):
        raise HTTPException(status_code=400, detail="Please upload an image file")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    try:
        result = analyze_image(data)
        store_analyze_backup(
            source_filename=file.filename or "upload.jpg",
            source_content_type=file.content_type,
            image_bytes=data,
            result=result,
        )
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Analysis failed: {exc}") from exc


@app.post("/track", response_model=ProgressReport)
async def track(
    baseline: UploadFile = File(...),
    followup: UploadFile = File(...),
) -> ProgressReport:
    if not _is_image_upload(baseline):
        raise HTTPException(status_code=400, detail="Baseline must be an image file")
    if not _is_image_upload(followup):
        raise HTTPException(status_code=400, detail="Follow-up must be an image file")

    baseline_data = await baseline.read()
    followup_data = await followup.read()

    if not baseline_data:
        raise HTTPException(status_code=400, detail="Baseline image is empty")
    if not followup_data:
        raise HTTPException(status_code=400, detail="Follow-up image is empty")

    try:
        result = compare_progress(baseline_data, followup_data)
        store_track_backup(
            baseline_filename=baseline.filename or "baseline.jpg",
            baseline_content_type=baseline.content_type,
            baseline_image_bytes=baseline_data,
            followup_filename=followup.filename or "followup.jpg",
            followup_content_type=followup.content_type,
            followup_image_bytes=followup_data,
            result=result,
        )
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"Progress tracking failed: {exc}"
        ) from exc


@app.post("/report", response_model=DetailedReportResponse)
async def detailed_report(payload: DetailedReportRequest) -> DetailedReportResponse:
    try:
        return generate_detailed_report(payload.analysis)
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Detailed report generation failed: {exc}",
        ) from exc


@app.post("/tracker/init", response_model=TrackerInitResponse)
async def tracker_init(
    user_id: str = Form(...),
    concern_types: str = Form(...),
    duration_days: int = Form(...),
    baseline_image: UploadFile = File(...),
    auto_delete_images: bool = Form(False),
) -> TrackerInitResponse:
    if not user_id.strip():
        raise HTTPException(status_code=400, detail="user_id is required")
    if not _is_image_upload(baseline_image):
        raise HTTPException(status_code=400, detail="baseline_image must be an image")

    baseline_data = await baseline_image.read()
    if not baseline_data:
        raise HTTPException(status_code=400, detail="baseline_image is empty")

    parsed_concerns = parse_concern_types(concern_types)
    if not parsed_concerns:
        raise HTTPException(status_code=400, detail="At least one concern type is required")

    try:
        return initialize_tracker(
            user_id=user_id,
            concern_types=parsed_concerns,
            duration_days=duration_days,
            baseline_image_bytes=baseline_data,
            auto_delete_images=auto_delete_images,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Tracker init failed: {exc}") from exc


@app.post("/tracker/upload", response_model=TrackerUploadResponse)
async def tracker_upload(
    tracker_id: str = Form(...),
    image: UploadFile = File(...),
    timestamp: str | None = Form(None),
) -> TrackerUploadResponse:
    if not tracker_id.strip():
        raise HTTPException(status_code=400, detail="tracker_id is required")
    if not _is_image_upload(image):
        raise HTTPException(status_code=400, detail="image must be an image")

    image_data = await image.read()
    if not image_data:
        raise HTTPException(status_code=400, detail="image is empty")

    try:
        return upload_progress_image(
            tracker_id=tracker_id,
            image_bytes=image_data,
            timestamp=timestamp,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Tracker upload failed: {exc}") from exc


@app.post("/tracker/compare", response_model=TrackerCompareResponse)
def tracker_compare(payload: TrackerCompareRequest) -> TrackerCompareResponse:
    try:
        return compare_tracker_progress(
            tracker_id=payload.tracker_id,
            current_image_id=payload.current_image_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Tracker compare failed: {exc}") from exc


@app.post("/tracker/routine", response_model=RoutineLogResponse)
def tracker_routine(payload: RoutineLogRequest) -> RoutineLogResponse:
    try:
        return log_routine(
            tracker_id=payload.tracker_id,
            date=payload.date,
            morning_routine=payload.morning_routine,
            night_routine=payload.night_routine,
            adherence_score=payload.adherence_score,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Routine logging failed: {exc}") from exc


@app.get("/tracker/{tracker_id}", response_model=TrackerOverviewResponse)
def tracker_get(tracker_id: str) -> TrackerOverviewResponse:
    try:
        return tracker_overview(tracker_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Tracker load failed: {exc}") from exc


@app.post("/tracker/report", response_model=TrackerReportResponse)
def tracker_report(payload: TrackerReportRequest) -> TrackerReportResponse:
    try:
        return generate_tracker_report(
            tracker_id=payload.tracker_id,
            current_image_id=payload.current_image_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Tracker report generation failed: {exc}",
        ) from exc
