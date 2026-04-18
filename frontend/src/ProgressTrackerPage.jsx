import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import "./styles.css";
import "./progress-tracker.css";

const API_BASE =
  import.meta.env.VITE_API_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:8080";
const DISCLAIMER = "This is an AI-assisted skin assessment, not a medical diagnosis.";

const CONCERN_OPTIONS = [
  "acne",
  "pigmentation",
  "redness",
  "texture",
  "oiliness",
  "scarring",
];

const MORNING_ROUTINE_OPTIONS = [
  "gentle_cleanser",
  "niacinamide_or_serum",
  "moisturizer",
  "sunscreen_spf30_plus",
];

const NIGHT_ROUTINE_OPTIONS = [
  "cleanser",
  "treatment_active",
  "barrier_moisturizer",
  "spot_treatment",
];

function toTitle(text) {
  return text
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function assetUrl(path) {
  if (!path) return "";
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${API_BASE}${path}`;
}

function detailToMessage(detail) {
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.msg) return item.msg;
        return "";
      })
      .filter(Boolean);
    return parts.join("; ");
  }
  if (typeof detail === "object") {
    if (typeof detail.message === "string") return detail.message;
    return JSON.stringify(detail);
  }
  return String(detail);
}

function RingMeter({ value }) {
  const clamped = Math.max(0, Math.min(100, Number(value || 0)));
  const radius = 58;
  const perimeter = 2 * Math.PI * radius;
  const offset = perimeter - (clamped / 100) * perimeter;
  return (
    <svg viewBox="0 0 150 150" className="tracker-ring-svg" aria-label="Skin Recovery Progress">
      <circle cx="75" cy="75" r={radius} className="tracker-ring-track" />
      <circle
        cx="75"
        cy="75"
        r={radius}
        className="tracker-ring-fill"
        strokeDasharray={perimeter}
        strokeDashoffset={offset}
      />
      <text x="75" y="72" textAnchor="middle" className="tracker-ring-value">
        {clamped.toFixed(1)}%
      </text>
      <text x="75" y="92" textAnchor="middle" className="tracker-ring-label">
        Recovery
      </text>
    </svg>
  );
}

function Stat({ label, value, sub }) {
  return (
    <article className="tracker-stat">
      <p className="tracker-stat-label">{label}</p>
      <p className="tracker-stat-value">{value}</p>
      {sub ? <p className="tracker-stat-sub">{sub}</p> : null}
    </article>
  );
}

function CompareSlider({ beforeSrc, afterSrc, slider }) {
  if (!beforeSrc || !afterSrc) {
    return <div className="tracker-empty">Upload baseline and progress images to compare.</div>;
  }

  return (
    <div className="tracker-compare-stage">
      <img src={beforeSrc} alt="Baseline" className="tracker-compare-image" />
      <div className="tracker-compare-overlay" style={{ width: `${slider}%` }}>
        <img src={afterSrc} alt="Latest" className="tracker-compare-image" />
      </div>
      <div className="tracker-compare-handle" style={{ left: `${slider}%` }} />
      <div className="tracker-compare-label tracker-compare-label-left">Baseline</div>
      <div className="tracker-compare-label tracker-compare-label-right">Latest</div>
    </div>
  );
}

function TrackerInitForm({
  userId,
  concerns,
  durationDays,
  baselineFile,
  autoDelete,
  onUserId,
  onConcern,
  onDuration,
  onBaseline,
  onAutoDelete,
  onSubmit,
  loading,
  error,
  onBackToAnalyzer,
  signedInUser,
  signedInUserId,
}) {
  const signedInName =
    String(signedInUser?.name || "").trim() ||
    String(signedInUser?.email || "").split("@")[0] ||
    "";

  return (
    <section className="tracker-shell">
      <div className="card tracker-card tracker-init-card">
        <header className="tracker-header tracker-header-inline">
          <div>
            <p className="tracker-kicker">Skin Progress Tracking</p>
            <h1>Initialize Your Plan</h1>
            <p>
              Start with a baseline image, choose concerns, and set your timeline (7/14/30/60 or
              custom days).
            </p>
          </div>
          {onBackToAnalyzer ? (
            <button type="button" className="btn-secondary tracker-inline-btn" onClick={onBackToAnalyzer}>
              Back to Analyzer
            </button>
          ) : null}
        </header>

        {signedInUser ? (
          <p className="tracker-auth-note">
            Signed in as <strong>{signedInName || "User"}</strong>
            {signedInUser?.email ? ` (${signedInUser.email})` : ""}. Recovery user ID is prefilled as
            <strong> {signedInUserId || "not available"}</strong>.
          </p>
        ) : null}

        <form className="tracker-init-grid" onSubmit={onSubmit}>
          <label className="tracker-field">
            <span>User ID</span>
            <input
              type="text"
              value={userId}
              onChange={(event) => onUserId(event.target.value)}
              placeholder="e.g. user_arnav_01"
            />
          </label>

          <label className="tracker-field">
            <span>Duration (days)</span>
            <input
              type="number"
              min="1"
              max="365"
              value={durationDays}
              onChange={(event) => onDuration(event.target.value)}
            />
          </label>

          <label className="tracker-field tracker-field-file">
            <span>Baseline Image</span>
            <input
              type="file"
              accept="image/*"
              onChange={(event) => onBaseline(event.target.files?.[0] ?? null)}
            />
            {baselineFile ? <small>{baselineFile.name}</small> : <small>No image selected.</small>}
          </label>

          <label className="tracker-field tracker-field-toggle">
            <input
              type="checkbox"
              checked={autoDelete}
              onChange={(event) => onAutoDelete(event.target.checked)}
            />
            <span>Enable auto-delete for old progress images</span>
          </label>

          <fieldset className="tracker-concern-fieldset">
            <legend>Concern Types</legend>
            <div className="tracker-chip-grid">
              {CONCERN_OPTIONS.map((option) => {
                const active = concerns.includes(option);
                return (
                  <button
                    key={option}
                    type="button"
                    className={`tracker-chip ${active ? "tracker-chip-active" : ""}`}
                    onClick={() => onConcern(option)}
                  >
                    {toTitle(option)}
                  </button>
                );
              })}
            </div>
          </fieldset>

          {error ? <div className="tracker-error">{error}</div> : null}

          <button type="submit" className="btn-primary tracker-primary-btn" disabled={loading}>
            {loading ? "Initializing..." : "Start Tracker"}
          </button>
        </form>

        <p className="tracker-disclaimer">{DISCLAIMER}</p>
      </div>
    </section>
  );
}

export default function ProgressTrackerPage({
  embedded = false,
  onBackToAnalyzer,
  signedInUser,
  signedInUserId,
}) {
  const [userId, setUserId] = useState(signedInUserId || "");
  const [concerns, setConcerns] = useState(["acne", "pigmentation"]);
  const [durationDays, setDurationDays] = useState("30");
  const [baselineFile, setBaselineFile] = useState(null);
  const [autoDeleteImages, setAutoDeleteImages] = useState(false);

  const [trackerId, setTrackerId] = useState("");
  const [overview, setOverview] = useState(null);

  const [initLoading, setInitLoading] = useState(false);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);

  const [initError, setInitError] = useState("");
  const [overviewError, setOverviewError] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [reportError, setReportError] = useState("");

  const [progressFile, setProgressFile] = useState(null);
  const [overlayMode, setOverlayMode] = useState("lesions");
  const [sliderValue, setSliderValue] = useState(50);

  const [routineDate, setRoutineDate] = useState(new Date().toISOString().slice(0, 10));
  const [morningRoutine, setMorningRoutine] = useState({
    gentle_cleanser: true,
    niacinamide_or_serum: false,
    moisturizer: true,
    sunscreen_spf30_plus: true,
  });
  const [nightRoutine, setNightRoutine] = useState({
    cleanser: true,
    treatment_active: false,
    barrier_moisturizer: true,
    spot_treatment: false,
  });
  const [routineNotice, setRoutineNotice] = useState("");

  const [reportResult, setReportResult] = useState(null);

  const concernLabel = useMemo(() => concerns.map(toTitle).join(", "), [concerns]);

  const timeline = overview?.timeline ?? [];
  const baselinePoint = useMemo(
    () => timeline.find((point) => point.is_baseline) ?? timeline[0] ?? null,
    [timeline],
  );
  const latestPoint = timeline.length ? timeline[timeline.length - 1] : null;

  const chartData = useMemo(
    () =>
      timeline.map((item) => ({
        day: `Day ${item.day_index}`,
        skin_health: item.metrics.skin_health_score,
        acne_count: item.metrics.acne_count,
        pigmentation: item.metrics.pigmentation_score,
      })),
    [timeline],
  );

  const beforeOverlay = useMemo(() => {
    if (!baselinePoint) return "";
    return overlayMode === "pigmentation"
      ? assetUrl(baselinePoint.pigmentation_overlay_url)
      : assetUrl(baselinePoint.lesion_overlay_url);
  }, [baselinePoint, overlayMode]);

  const afterOverlay = useMemo(() => {
    if (!latestPoint) return "";
    return overlayMode === "pigmentation"
      ? assetUrl(latestPoint.pigmentation_overlay_url)
      : assetUrl(latestPoint.lesion_overlay_url);
  }, [latestPoint, overlayMode]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const existingTrackerId = params.get("tracker_id");
    if (existingTrackerId) {
      setTrackerId(existingTrackerId);
    }
  }, []);

  useEffect(() => {
    if (!trackerId && signedInUserId) {
      setUserId((previous) => (previous.trim() ? previous : signedInUserId));
    }
  }, [signedInUserId, trackerId]);

  useEffect(() => {
    if (!trackerId) return;

    const loadOverview = async () => {
      setOverviewLoading(true);
      setOverviewError("");
      try {
        const response = await fetch(`${API_BASE}/tracker/${trackerId}`);
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.detail || `Server error ${response.status}`);
        }
        setOverview(await response.json());
      } catch (error) {
        setOverviewError(error.message || "Unable to load tracker dashboard.");
      } finally {
        setOverviewLoading(false);
      }
    };

    loadOverview();
  }, [trackerId]);

  const toggleConcern = (concern) => {
    setConcerns((previous) => {
      if (previous.includes(concern)) {
        return previous.filter((item) => item !== concern);
      }
      return [...previous, concern];
    });
  };

  const updateTrackerInUrl = (id) => {
    const url = new URL(window.location.href);
    url.searchParams.set("tracker_id", id);
    window.history.replaceState({}, "", url.toString());
  };

  const refreshOverview = async (id) => {
    const response = await fetch(`${API_BASE}/tracker/${id}`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(detailToMessage(payload.detail) || `Server error ${response.status}`);
    }
    const data = await response.json();
    setOverview(data);
    return data;
  };

  const onResetTracker = () => {
    setTrackerId("");
    setOverview(null);
    setReportResult(null);
    setProgressFile(null);
    setUserId(signedInUserId || "");
    setReportError("");
    setOverviewError("");
    setUploadError("");
    setRoutineNotice("");

    const url = new URL(window.location.href);
    url.searchParams.delete("tracker_id");
    window.history.replaceState({}, "", url.toString());
  };

  const onInitTracker = async (event) => {
    event.preventDefault();
    setInitError("");

    const effectiveUserId = userId.trim() || String(signedInUserId || "").trim();
    if (!effectiveUserId) {
      setInitError("Please provide user ID.");
      return;
    }
    if (!baselineFile) {
      setInitError("Please upload a baseline image.");
      return;
    }
    if (concerns.length === 0) {
      setInitError("Select at least one skin concern.");
      return;
    }

    const days = Number(durationDays);
    if (!Number.isFinite(days) || days <= 0 || days > 365) {
      setInitError("Duration must be between 1 and 365 days.");
      return;
    }

    setInitLoading(true);
    try {
      const formData = new FormData();
      formData.append("user_id", effectiveUserId);
      formData.append("concern_types", JSON.stringify(concerns));
      formData.append("duration_days", String(days));
      formData.append("baseline_image", baselineFile);
      formData.append("auto_delete_images", String(autoDeleteImages));

      const response = await fetch(`${API_BASE}/tracker/init`, {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(detailToMessage(payload.detail) || `Server error ${response.status}`);
      }

      const data = await response.json();
      if (effectiveUserId !== userId) {
        setUserId(effectiveUserId);
      }
      setTrackerId(data.tracker_id);
      updateTrackerInUrl(data.tracker_id);
      await refreshOverview(data.tracker_id);
    } catch (error) {
      setInitError(error.message || "Could not initialize tracker.");
    } finally {
      setInitLoading(false);
    }
  };

  const onUploadProgress = async () => {
    setUploadError("");
    if (!trackerId) {
      setUploadError("Initialize tracker first.");
      return;
    }
    if (!progressFile) {
      setUploadError("Select a progress image first.");
      return;
    }

    setUploadLoading(true);
    try {
      const formData = new FormData();
      formData.append("tracker_id", trackerId);
      formData.append("image", progressFile);
      formData.append("timestamp", new Date().toISOString());

      const response = await fetch(`${API_BASE}/tracker/upload`, {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(detailToMessage(payload.detail) || `Server error ${response.status}`);
      }

      await response.json();
      await refreshOverview(trackerId);
      setProgressFile(null);
    } catch (error) {
      setUploadError(error.message || "Progress upload failed.");
    } finally {
      setUploadLoading(false);
    }
  };

  const onGenerateReport = async () => {
    setReportError("");
    if (!trackerId) return;

    setReportLoading(true);
    try {
      const response = await fetch(`${API_BASE}/tracker/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tracker_id: trackerId }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(detailToMessage(payload.detail) || `Server error ${response.status}`);
      }
      setReportResult(await response.json());
    } catch (error) {
      setReportError(error.message || "Report generation failed.");
    } finally {
      setReportLoading(false);
    }
  };

  const onToggleRoutine = (setFn, key) => {
    setFn((previous) => ({ ...previous, [key]: !previous[key] }));
  };

  const onSaveRoutine = async () => {
    if (!trackerId) return;

    setRoutineNotice("");
    try {
      const response = await fetch(`${API_BASE}/tracker/routine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tracker_id: trackerId,
          date: routineDate,
          morning_routine: morningRoutine,
          night_routine: nightRoutine,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(detailToMessage(payload.detail) || `Server error ${response.status}`);
      }
      const payload = await response.json();
      setRoutineNotice(`Routine saved. Adherence ${payload.adherence_score.toFixed(1)}%.`);
      await refreshOverview(trackerId);
    } catch (error) {
      setRoutineNotice(error.message || "Routine logging failed.");
    }
  };

  if (!trackerId) {
    return (
      <TrackerInitForm
        userId={userId}
        concerns={concerns}
        durationDays={durationDays}
        baselineFile={baselineFile}
        autoDelete={autoDeleteImages}
        onUserId={setUserId}
        onConcern={toggleConcern}
        onDuration={setDurationDays}
        onBaseline={setBaselineFile}
        onAutoDelete={setAutoDeleteImages}
        onSubmit={onInitTracker}
        loading={initLoading}
        error={initError}
        onBackToAnalyzer={onBackToAnalyzer}
        signedInUser={signedInUser}
        signedInUserId={signedInUserId}
      />
    );
  }

  return (
    <main className={`tracker-shell ${embedded ? "tracker-shell-embedded" : ""}`}>
      <header className="card tracker-card tracker-header tracker-header-inline">
        <div>
          <p className="tracker-kicker">Skin Progress Tracking Module</p>
          <h1>Progress Dashboard</h1>
          <p>
            Concerns: <strong>{concernLabel || "Not selected"}</strong>. Tracker ID: <strong>{trackerId}</strong>
          </p>
          {signedInUser ? (
            <p className="tracker-auth-mini">
              Signed-in profile: <strong>{signedInUser.email || signedInUser.name || "User"}</strong>
            </p>
          ) : null}
        </div>
        <div className="tracker-header-actions">
          {onBackToAnalyzer ? (
            <button type="button" className="btn-secondary tracker-inline-btn" onClick={onBackToAnalyzer}>
              Back to Analyzer
            </button>
          ) : null}
          <button type="button" className="btn-secondary tracker-inline-btn" onClick={onResetTracker}>
            New Tracker
          </button>
        </div>
      </header>

      {overviewLoading ? <div className="tracker-empty">Loading tracker dashboard...</div> : null}
      {overviewError ? <div className="tracker-error">{overviewError}</div> : null}

      {overview ? (
        <>
          <section className="tracker-grid-three">
            <article className="card tracker-card tracker-card-ring">
              <p className="tracker-card-title">Skin Recovery Progress</p>
              <RingMeter value={overview.recovery_percent} />
              <p className="tracker-sub">Goal aligned with acne reduction + skin health trend.</p>
            </article>

            <article className="card tracker-card">
              <p className="tracker-card-title">Current Skin Score</p>
              <p className="tracker-main-metric">
                {overview.latest_metrics.skin_health_score.toFixed(1)} <span>/ 100</span>
              </p>
              <div className="tracker-stat-row">
                <Stat
                  label="Acne Count"
                  value={overview.latest_metrics.acne_count}
                  sub="latest capture"
                />
                <Stat
                  label="Pigmentation"
                  value={`${overview.latest_metrics.pigmentation_score.toFixed(1)}%`}
                  sub="coverage"
                />
              </div>
            </article>

            <article className="card tracker-card">
              <p className="tracker-card-title">Latest Insights</p>
              <p className="tracker-insight">{overview.latest_insights}</p>
              <p className="tracker-prediction">{overview.prediction.narrative}</p>
              <p className="tracker-adherence">
                Routine adherence: <strong>{overview.adherence_percent.toFixed(1)}%</strong>
              </p>
            </article>
          </section>

          <section className="card tracker-card">
            <div className="tracker-section-head">
              <h2>Before / After Comparison</h2>
              <div className="tracker-toggle-group">
                <button
                  type="button"
                  className={overlayMode === "lesions" ? "tracker-toggle-active" : ""}
                  onClick={() => setOverlayMode("lesions")}
                >
                  Lesion Overlay
                </button>
                <button
                  type="button"
                  className={overlayMode === "pigmentation" ? "tracker-toggle-active" : ""}
                  onClick={() => setOverlayMode("pigmentation")}
                >
                  Pigmentation Overlay
                </button>
              </div>
            </div>

            <CompareSlider beforeSrc={beforeOverlay} afterSrc={afterOverlay} slider={sliderValue} />
            <input
              className="tracker-slider"
              type="range"
              min="0"
              max="100"
              value={sliderValue}
              onChange={(event) => setSliderValue(Number(event.target.value))}
            />
          </section>

          <section className="tracker-grid-two">
            <article className="tracker-card">
              <h2>Skin Health Score vs Time</h2>
              <div className="tracker-chart-wrap">
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={chartData}>
                    <CartesianGrid stroke="#E5E9F0" strokeDasharray="3 3" />
                    <XAxis dataKey="day" stroke="#64748B" />
                    <YAxis domain={[0, 100]} stroke="#64748B" />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="skin_health" stroke="#00A8C8" strokeWidth={2.5} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </article>

            <article className="card tracker-card">
              <h2>Acne and Pigmentation Trends</h2>
              <div className="tracker-chart-wrap">
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={chartData}>
                    <CartesianGrid stroke="#E5E9F0" strokeDasharray="3 3" />
                    <XAxis dataKey="day" stroke="#64748B" />
                    <YAxis stroke="#64748B" />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="acne_count" stroke="#FF6B00" strokeWidth={2.2} />
                    <Line type="monotone" dataKey="pigmentation" stroke="#00C9A0" strokeWidth={2.2} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </article>
          </section>

          <section className="tracker-grid-two">
            <article className="card tracker-card">
              <div className="tracker-section-head">
                <h2>Timeline View</h2>
                <span>{timeline.length} snapshots</span>
              </div>
              <div className="tracker-timeline-list">
                {timeline.map((point) => {
                  const pointStatusClass =
                    point.image_id === latestPoint?.image_id
                      ? "tracker-timeline-item-current"
                      : "tracker-timeline-item-completed";

                  return (
                  <div
                    key={point.image_id}
                    className={`tracker-timeline-item ${pointStatusClass}`}
                  >
                    <div className="tracker-timeline-day">
                      Day {point.day_index} {point.is_baseline ? "- Baseline" : "- Progress"}
                    </div>
                    <div className="tracker-timeline-stats">
                      <span>Skin: {point.metrics.skin_health_score.toFixed(1)}</span>
                      <span>Acne: {point.metrics.acne_count}</span>
                      <span>Pigment: {point.metrics.pigmentation_score.toFixed(1)}%</span>
                    </div>
                  </div>
                  );
                })}
              </div>
            </article>

            <article className="card tracker-card">
              <h2>Upload Progress Image</h2>
              <label className="tracker-field tracker-field-file">
                <span>Progress Image</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(event) => setProgressFile(event.target.files?.[0] ?? null)}
                />
                {progressFile ? <small>{progressFile.name}</small> : <small>No file selected.</small>}
              </label>
              {uploadError ? <div className="tracker-error">{uploadError}</div> : null}
              <button className="btn-primary tracker-primary-btn" type="button" onClick={onUploadProgress} disabled={uploadLoading}>
                {uploadLoading ? "Uploading..." : "Upload & Compare"}
              </button>
            </article>
          </section>

          <section className="tracker-grid-two">
            <article className="card tracker-card">
              <h2>Routine Tracker</h2>
              <label className="tracker-field">
                <span>Date</span>
                <input type="date" value={routineDate} onChange={(event) => setRoutineDate(event.target.value)} />
              </label>

              <div className="tracker-checklist-group">
                <h3>Morning Routine</h3>
                {MORNING_ROUTINE_OPTIONS.map((step) => (
                  <label key={step} className="tracker-checkline">
                    <input
                      type="checkbox"
                      checked={Boolean(morningRoutine[step])}
                      onChange={() => onToggleRoutine(setMorningRoutine, step)}
                    />
                    <span>{toTitle(step)}</span>
                  </label>
                ))}
              </div>

              <div className="tracker-checklist-group">
                <h3>Night Routine</h3>
                {NIGHT_ROUTINE_OPTIONS.map((step) => (
                  <label key={step} className="tracker-checkline">
                    <input
                      type="checkbox"
                      checked={Boolean(nightRoutine[step])}
                      onChange={() => onToggleRoutine(setNightRoutine, step)}
                    />
                    <span>{toTitle(step)}</span>
                  </label>
                ))}
              </div>

              <button className="btn-secondary tracker-secondary-btn" type="button" onClick={onSaveRoutine}>
                Save Routine Log
              </button>
              {routineNotice ? <p className="tracker-note">{routineNotice}</p> : null}
            </article>

            <article className="card tracker-card">
              <h2>AI Insights Layer (Claude API)</h2>
              <p className="tracker-sub">
                Generate context-aware guidance from current and baseline progress metrics.
              </p>
              <button className="btn-secondary tracker-secondary-btn" type="button" onClick={onGenerateReport} disabled={reportLoading}>
                {reportLoading ? "Generating..." : "Generate Tracker Report"}
              </button>
              {reportError ? <div className="tracker-error">{reportError}</div> : null}
              {reportResult ? (
                <div className="tracker-report-box">
                  <p className="tracker-report-meta">
                    Generated by {reportResult.generated_by} ({reportResult.model})
                  </p>
                  <pre>{reportResult.summary}</pre>
                </div>
              ) : null}
            </article>
          </section>

          <p className="tracker-disclaimer">{overview.disclaimer || DISCLAIMER}</p>
        </>
      ) : null}
    </main>
  );
}
