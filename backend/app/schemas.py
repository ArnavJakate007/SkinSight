from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class BoundingBox(BaseModel):
    x: int
    y: int
    width: int
    height: int
    label: str
    confidence: float
    zone: str
    acne_type: str = "unknown"   # comedone | papule | pustule | nodule_cyst | unknown


class HyperpigmentationReport(BaseModel):
    coverage_percent: float
    severity: str


class AnalysisResult(BaseModel):
    acne_severity: str
    acne_score: float
    gags_score: int = 0
    gags_severity: str = "Clear"
    lesions: list[BoundingBox]
    zone_counts: dict[str, int]
    acne_type_breakdown: dict[str, dict[str, int]] = {}
    hyperpigmentation: HyperpigmentationReport
    summary: str
    annotated_image_base64: str
    heatmap_image_base64: str


class ProgressStage(BaseModel):
    key: str
    title: str
    bullets: list[str]


class ProgressReport(BaseModel):
    similarity: float
    baseline_lesions: int
    followup_lesions: int
    improvement_percent: float
    timeline: str  # "short_term" or "long_term"
    stages: list[ProgressStage]
    summary: str


class DetailedReportRequest(BaseModel):
    analysis: AnalysisResult


class DetailedReportResponse(BaseModel):
    generated_by: str
    model: str
    report: str
    disclaimer: str
    created_at: str


class AuthRegisterRequest(BaseModel):
    name: str
    email: str
    password: str


class AuthLoginRequest(BaseModel):
    email: str
    password: str


class AuthUserResponse(BaseModel):
    id: str
    name: str
    email: str
    created_at: str


class AuthTokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: AuthUserResponse


class LesionTypeSummary(BaseModel):
    comedones: int = 0
    papules: int = 0
    pustules: int = 0
    nodules: int = 0


class SkinMetrics(BaseModel):
    acne_count: int
    lesion_types: LesionTypeSummary
    pigmentation_score: float
    redness_score: float
    texture_score: float
    oiliness_score: float
    skin_health_score: float


class TrackerInitResponse(BaseModel):
    tracker_id: str
    baseline_image_id: str
    baseline_metrics: SkinMetrics
    disclaimer: str


class TrackerComparison(BaseModel):
    baseline_image_id: str
    current_image_id: str
    acne_reduction_percent: float
    pigmentation_improvement_percent: float
    redness_reduction_percent: float
    texture_improvement_percent: float
    skin_health_score_delta: float


class RecoveryForecast(BaseModel):
    estimated_days_to_mild_acne: int | None = None
    estimated_days_to_target_health: int | None = None
    narrative: str


class TrackerUploadResponse(BaseModel):
    tracker_id: str
    image_id: str
    updated_metrics: SkinMetrics
    comparison: TrackerComparison
    prediction: RecoveryForecast
    recovery_percent: float
    latest_insights: str
    disclaimer: str


class TrackerCompareRequest(BaseModel):
    tracker_id: str
    current_image_id: str | None = None


class TrackerCompareResponse(BaseModel):
    tracker_id: str
    baseline_metrics: SkinMetrics
    current_metrics: SkinMetrics
    comparison: TrackerComparison
    prediction: RecoveryForecast
    recovery_percent: float
    disclaimer: str


class TrackerReportRequest(BaseModel):
    tracker_id: str
    current_image_id: str | None = None


class TrackerReportResponse(BaseModel):
    generated_by: str
    model: str
    summary: str
    created_at: str
    disclaimer: str


class RoutineLogRequest(BaseModel):
    tracker_id: str
    date: str
    morning_routine: dict[str, bool] = Field(default_factory=dict)
    night_routine: dict[str, bool] = Field(default_factory=dict)
    adherence_score: float | None = None


class RoutineLogResponse(BaseModel):
    tracker_id: str
    date: str
    adherence_score: float


class TrackerImagePoint(BaseModel):
    image_id: str
    timestamp: str
    day_index: int
    is_baseline: bool
    image_url: str
    lesion_overlay_url: str
    pigmentation_overlay_url: str
    metrics: SkinMetrics


class TrackerOverviewResponse(BaseModel):
    tracker_id: str
    user_id: str
    start_date: str
    duration_days: int
    concern_types: list[str]
    adherence_percent: float
    recovery_percent: float
    latest_metrics: SkinMetrics
    latest_insights: str
    prediction: RecoveryForecast
    timeline: list[TrackerImagePoint]
    disclaimer: str


class TrackerInitPayload(BaseModel):
    user_id: str
    concern_types: list[str]
    duration_days: int


class TrackerImageComputed(BaseModel):
    image_id: str
    timestamp: str
    metrics: SkinMetrics
    analysis: AnalysisResult
    image_url: str
    lesion_overlay_url: str
    pigmentation_overlay_url: str


class TrackerRecord(BaseModel):
    id: str
    user_id: str
    start_date: str
    duration_days: int
    concern_types: list[str]
    auto_delete_images: bool


class TrackerImageRow(BaseModel):
    id: str
    tracker_id: str
    image_url: str
    lesion_overlay_url: str
    pigmentation_overlay_url: str
    timestamp: str
    is_baseline: bool


class TrackerMetricRow(BaseModel):
    image_id: str
    acne_count: int
    lesion_types: dict[str, Any]
    pigmentation_score: float
    redness_score: float
    texture_score: float
    oiliness_score: float
    skin_health_score: float
    raw_analysis_json: dict[str, Any]
