import { useEffect, useState, useMemo } from "react";
import { jsPDF } from "jspdf";
import ProgressTrackerPage from "./ProgressTrackerPage";
import "./styles.css";

const API_BASE = import.meta.env.VITE_API_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:8080";
const AUTH_STORAGE_KEY = "skinsight_auth_session_v1";

function authErrorMessage(detail, statusCode) {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const first = detail.find((item) => typeof item?.msg === "string")?.msg;
    if (first) return first;
  }
  if (detail && typeof detail === "object" && typeof detail.message === "string") {
    return detail.message;
  }
  return `Authentication failed (${statusCode})`;
}

function normalizeAuthUser(user) {
  if (!user || typeof user !== "object") return null;
  const id = String(user.id || "").trim();
  const name = String(user.name || "").trim();
  const email = String(user.email || "").trim().toLowerCase();
  const createdAt = String(user.created_at || "").trim();
  if (!id || !email) return null;
  return {
    id,
    name,
    email,
    created_at: createdAt,
  };
}

function readStoredAuthSession() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const token = String(parsed?.token || "").trim();
    const user = normalizeAuthUser(parsed?.user);
    if (!token || !user) return null;
    return { token, user };
  } catch {
    return null;
  }
}

function writeStoredAuthSession(token, user) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ token, user }),
  );
}

function clearStoredAuthSession() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(AUTH_STORAGE_KEY);
}

function buildRecoveryUserId(profile) {
  if (!profile) return "";
  const source = String(profile.email || profile.name || "")
    .trim()
    .toLowerCase();
  if (!source) return "";

  const normalized = source
    .replace(/@/g, "_at_")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);

  return normalized ? `user_${normalized}` : "";
}

function profileDisplayName(profile) {
  if (!profile) return "";
  const name = String(profile.name || "").trim();
  if (name) return name;
  const email = String(profile.email || "").trim();
  if (!email) return "";
  return email.split("@")[0] || email;
}

const ZONE_LABELS = {
  forehead: "Forehead",
  left_cheek: "Left Cheek",
  right_cheek: "Right Cheek",
  nose: "Nose",
  chin_jawline: "Chin / Jawline",
};

const SEVERITY_CONFIG = {
  Clear: { color: "#00A8C8", bg: "rgba(0,168,200,0.14)", label: "Clear" },
  Mild: { color: "#00C9A0", bg: "rgba(0,201,160,0.14)", label: "Mild" },
  Moderate: {
    color: "#00A8C8",
    bg: "rgba(0,168,200,0.2)",
    label: "Moderate",
  },
  Severe: { color: "#FF6B00", bg: "rgba(255,107,0,0.16)", label: "Severe" },
  "Very Severe": {
    color: "#FF6B00",
    bg: "rgba(255,107,0,0.24)",
    label: "Very Severe",
  },
};

function getSeverityConfig(s) {
  const key = s && SEVERITY_CONFIG[s] ? s : "Clear";
  return SEVERITY_CONFIG[key];
}

function Spinner() {
  return (
    <svg className="spinner" viewBox="0 0 24 24" fill="none">
      <circle className="spinner-ring" cx="12" cy="12" r="10" strokeWidth="3" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg
      className="upload-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
      />
    </svg>
  );
}

function CircularProgress({ percent, color }) {
  const r = 36;
  const circ = 2 * Math.PI * r;
  const offset = circ - (Math.min(percent, 100) / 100) * circ;
  return (
    <svg className="circ-progress" viewBox="0 0 88 88">
      <circle className="circ-track" cx="44" cy="44" r={r} />
      <circle
        className="circ-fill"
        cx="44"
        cy="44"
        r={r}
        stroke={color}
        strokeDasharray={circ}
        strokeDashoffset={offset}
      />
      <text
        className="circ-label"
        x="44"
        y="44"
        textAnchor="middle"
        dominantBaseline="middle"
      >
        {percent.toFixed(1)}%
      </text>
    </svg>
  );
}

function ZoneBar({ label, count, max }) {
  const pct = max > 0 ? (count / max) * 100 : 0;
  return (
    <div className="zone-row">
      <span className="zone-name">{label}</span>
      <div className="zone-track">
        <div className="zone-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="zone-count">{count}</span>
    </div>
  );
}

function DropZone({ file, previewUrl, onFile }) {
  const [dragging, setDragging] = useState(false);
  const ref = { current: null };
  return (
    <div
      className={`drop-zone ${dragging ? "drag-over" : ""} ${file ? "has-file" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer?.files?.[0];
        if (f && f.type.startsWith("image/")) onFile(f);
      }}
      onClick={() => ref.current?.click()}
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && ref.current?.click()}
    >
      <input
        ref={ref}
        type="file"
        accept="image/*"
        className="hidden-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
      {file && previewUrl ? (
        <div className="drop-preview">
          <img src={previewUrl} alt="preview" className="preview-img" />
          <div className="drop-overlay">
            <UploadIcon />
            <span>Change photo</span>
          </div>
        </div>
      ) : (
        <div className="drop-placeholder">
          <UploadIcon />
          <p className="drop-title">
            Drag &amp; drop or <span className="drop-link">browse</span>
          </p>
          <p className="drop-hint">
            JPG, PNG, WebP &mdash; front-facing selfie
          </p>
        </div>
      )}
    </div>
  );
}

function MiniDrop({ label, file, previewUrl, onFile }) {
  const ref = { current: null };
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={`mini-drop ${dragging ? "drag-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer?.files?.[0];
        if (f && f.type.startsWith("image/")) onFile(f);
      }}
      onClick={() => ref.current?.click()}
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && ref.current?.click()}
    >
      <input
        ref={ref}
        type="file"
        accept="image/*"
        className="hidden-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
      {file && previewUrl ? (
        <div className="mini-preview">
          <img src={previewUrl} alt={label} />
          <span className="mini-change">Tap to change</span>
        </div>
      ) : (
        <div className="mini-placeholder">
          <UploadIcon />
          <span>{label}</span>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, sub, accent }) {
  return (
    <div className="stat-card" style={{ "--accent": accent }}>
      <span className="stat-icon">{icon}</span>
      <div className="stat-body">
        <span className="stat-label">{label}</span>
        <span className="stat-value">{value}</span>
        {sub && <span className="stat-sub">{sub}</span>}
      </div>
    </div>
  );
}

const REPORT_QUOTES = [
  "Healthy skin is a reflection of overall wellness.",
  "Consistency beats intensity in skincare routines.",
  "Gentle care today prevents irritation tomorrow.",
  "Progress photos tell the story better than memory.",
];

function AuthGate({ onSuccess }) {
  const [mode, setMode] = useState("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError("");
    const cleanEmail = String(email).trim().toLowerCase();
    const cleanName = String(name).trim();
    if (!cleanEmail || !password || (mode === "register" && !cleanName)) {
      setError("Please fill all required fields.");
      return;
    }
    if (mode === "register" && password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    const endpoint = mode === "login" ? "/auth/login" : "/auth/register";
    const payload = mode === "login"
      ? { email: cleanEmail, password }
      : { name: cleanName, email: cleanEmail, password };

    setSubmitting(true);
    try {
      const response = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const responsePayload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(authErrorMessage(responsePayload?.detail, response.status));
      }

      const token = String(responsePayload?.access_token || "").trim();
      const user = normalizeAuthUser(responsePayload?.user);
      if (!token || !user) {
        throw new Error("Invalid authentication response from server");
      }

      onSuccess({ token, user, mode });
      setPassword("");
      setConfirm("");
    } catch (requestError) {
      setError(requestError.message || "Authentication failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-wave auth-wave-a" />
      <div className="auth-wave auth-wave-b" />
      <div className="auth-panel">
        <p className="auth-kicker">SkinSight Access</p>
        <h1 className="auth-title">{mode === "login" ? "Welcome Back" : "Create Account"}</h1>
        <p className="auth-sub">
          {mode === "login"
            ? "Sign in to continue to your skin analysis dashboard."
            : "Register to save your tracking timeline and reports."}
        </p>

        <form onSubmit={onSubmit} className="auth-form">
          {mode === "register" && (
            <label className="auth-field">
              <span>Full Name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
              />
            </label>
          )}
          <label className="auth-field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
            />
          </label>
          <label className="auth-field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </label>
          {mode === "register" && (
            <label className="auth-field">
              <span>Confirm Password</span>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
              />
            </label>
          )}

          {error && <div className="auth-error">{error}</div>}

          <button type="submit" className="landing-btn auth-submit" disabled={submitting}>
            {submitting ? "Please wait..." : mode === "login" ? "Login" : "Register"}
          </button>
        </form>

        <button
          className="auth-switch"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError("");
          }}
        >
          {mode === "login"
            ? "New here? Create an account"
            : "Already have an account? Login"}
        </button>
      </div>
    </div>
  );
}

function ProfilePanel({ user, recoveryUserId, onClose, onLogout }) {
  if (!user) return null;

  return (
    <div className="profile-backdrop" onClick={onClose}>
      <section className="profile-panel card" onClick={(event) => event.stopPropagation()}>
        <header className="profile-header">
          <h3 className="card-title">Profile</h3>
          <button type="button" className="profile-close" onClick={onClose} aria-label="Close profile panel">
            ×
          </button>
        </header>

        <div className="profile-row">
          <span>Name</span>
          <strong>{profileDisplayName(user) || "-"}</strong>
        </div>
        <div className="profile-row">
          <span>Email</span>
          <strong>{user.email || "-"}</strong>
        </div>
        <div className="profile-row">
          <span>Recovery User ID</span>
          <strong>{recoveryUserId || "Not available"}</strong>
        </div>

        <p className="profile-note">
          This ID is auto-used as default in Recovery Dashboard initialization.
        </p>

        <div className="profile-actions">
          <button type="button" className="btn-secondary profile-btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn-primary profile-btn" onClick={onLogout}>
            Sign Out
          </button>
        </div>
      </section>
    </div>
  );
}

/* ══════════════════════════════════════════════
   ANALYZE TAB
══════════════════════════════════════════════ */
function AnalyzeTab({ forcedView = "annotated" }) {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [detailedReport, setDetailedReport] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [reportQuoteIndex, setReportQuoteIndex] = useState(0);
  const [imageSubView, setImageSubView] = useState("annotated");
  const [showResults, setShowResults] = useState(false);
  const [heatmapOpen, setHeatmapOpen] = useState(false);
  const [heatmapZoom, setHeatmapZoom] = useState(1);

  const previewUrl = useMemo(
    () => (file ? URL.createObjectURL(file) : null),
    [file],
  );

  const normalizedReportText = useMemo(() => {
    const raw = detailedReport?.report ?? "";
    return raw
      .replace(/^\s*\*\*([^*]+)\*\*\s*$/gm, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/^\s*\*\s+/gm, "- ")
      .replace(/\r\n/g, "\n")
      .trim();
  }, [detailedReport]);

  const summaryText = useMemo(() => {
    const raw = String(result?.summary || "").trim().replace(/^['"]+|['"]+$/g, "");
    if (!raw) return "Analysis complete.";
    const sentence = raw.split(/(?<=[.!?])\s+/)[0] || raw;
    return sentence.length > 180 ? `${sentence.slice(0, 177)}...` : sentence;
  }, [result]);

  const lesionCount = result?.lesions?.length ?? 0;
  const topZone = useMemo(() => {
    const entries = Object.entries(result?.zone_counts ?? {});
    if (!entries.length) return "N/A";
    return entries.sort((a, b) => b[1] - a[1])[0][0];
  }, [result]);

  const closeHeatmapModal = () => {
    setHeatmapOpen(false);
    setHeatmapZoom(1);
  };

  const adjustHeatmapZoom = (delta) => {
    setHeatmapZoom((z) => Math.min(3, Math.max(0.7, +(z + delta).toFixed(2))));
  };

  const resetHeatmapZoom = () => setHeatmapZoom(1);

  const exportReportPdf = () => {
    if (!detailedReport?.report) return;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 42;
    const usableWidth = pageWidth - margin * 2;
    let y = margin;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text("SkinSight AI Report", margin, y);
    y += 22;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text(`Model: ${detailedReport.model}`, margin, y);
    doc.text(`Source: ${detailedReport.generated_by}`, pageWidth - margin, y, {
      align: "right",
    });
    y += 18;

    doc.setDrawColor(190);
    doc.line(margin, y, pageWidth - margin, y);
    y += 16;

    doc.setFontSize(11);
    const lines = doc.splitTextToSize(normalizedReportText, usableWidth);
    for (const line of lines) {
      if (y > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }
      doc.text(line, margin, y);
      y += 16;
    }

    const safeStamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    doc.save(`skinsight-report-${safeStamp}.pdf`);
    setActionMessage("Report exported as PDF.");
  };

  const copyReportText = async () => {
    if (!normalizedReportText) return;
    await navigator.clipboard.writeText(normalizedReportText);
    setActionMessage("Report copied to clipboard.");
  };

  const copySummaryText = async () => {
    if (!result) return;
    const lines = [
      `Severity: ${result.acne_severity}`,
      `Lesions: ${lesionCount}`,
      `Top zone: ${topZone}`,
      `Hyperpigmentation: ${Number(result.hyperpigmentation?.coverage_percent ?? 0).toFixed(1)}% (${result.hyperpigmentation?.severity ?? "N/A"})`,
      `Summary: ${summaryText}`,
    ];
    await navigator.clipboard.writeText(lines.join("\n"));
    setActionMessage("Summary copied to clipboard.");
  };

  const downloadAnalysisJson = () => {
    if (!result) return;
    const payload = {
      analysis: result,
      report: detailedReport ?? null,
      exported_at: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "skinsight-analysis.json";
    a.click();
    URL.revokeObjectURL(url);
    setActionMessage("Analysis JSON downloaded.");
  };

  const downloadHeatmapImage = () => {
    if (!result?.heatmap_image_base64) return;
    const a = document.createElement("a");
    a.href = `data:image/jpeg;base64,${result.heatmap_image_base64}`;
    a.download = `skinsight-heatmap-${Date.now()}.jpg`;
    a.click();
    setActionMessage("Heatmap image downloaded.");
  };

  useEffect(() => {
    setImageSubView(forcedView);
  }, [forcedView]);

  useEffect(() => {
    if (!reportLoading) return undefined;
    const quoteTimer = setInterval(() => {
      setReportQuoteIndex((i) => (i + 1) % REPORT_QUOTES.length);
    }, 2400);
    return () => clearInterval(quoteTimer);
  }, [reportLoading]);

  useEffect(() => {
    if (!heatmapOpen) return undefined;
    const onKeyDown = (evt) => {
      if (evt.key === "Escape") closeHeatmapModal();
    };
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = oldOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [heatmapOpen]);

  const onAnalyze = async (e) => {
    e.preventDefault();
    if (!file) {
      setError("Please upload a selfie first.");
      return;
    }
    setLoading(true);
    setError("");
    setResult(null);
    setDetailedReport(null);
    setReportError("");
    setImageSubView(forcedView || "annotated");
    setReportQuoteIndex(0);
    setShowResults(false);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API_BASE}/analyze`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const p = await res.json().catch(() => ({}));
        throw new Error(p.detail || `Server error ${res.status}`);
      }
      const data = await res.json();
      setResult(data);

      setReportLoading(true);
      try {
        const reportRes = await fetch(`${API_BASE}/report`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ analysis: data }),
        });
        if (!reportRes.ok) {
          const p = await reportRes.json().catch(() => ({}));
          throw new Error(p.detail || `Server error ${reportRes.status}`);
        }
        setDetailedReport(await reportRes.json());
      } catch (reportErr) {
        setReportError(reportErr.message || "Detailed report generation failed.");
      } finally {
        setReportLoading(false);
      }

      setTimeout(() => setShowResults(true), 50);
    } catch (err) {
      const isNetworkError =
        err instanceof TypeError &&
        String(err.message || "").toLowerCase().includes("fetch");
      setError(
        isNetworkError
          ? "Cannot connect to backend API on port 8080. Start backend and try again."
          : err.message || "Unexpected error — please try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  const sevConfig = result ? getSeverityConfig(result.acne_severity) : null;
  const zoneCounts = result?.zone_counts ?? {};
  const maxZone = Math.max(0, ...Object.values(zoneCounts));
  const hyper = result?.hyperpigmentation ?? {};
  const hyperPct = parseFloat(hyper.coverage_percent ?? 0);
  // acne_score is [0..1]; display as percentage
  const acneScorePct = ((result?.acne_score ?? 0) * 100).toFixed(1);

  return (
    <div className="tab-content">
      {/* ── Upload + Annotated side-by-side ── */}
      <div className="analyze-top-row">
        <section className="card upload-card">
          <div className="card-header">
            <h2 className="card-title">Upload Your Photo</h2>
            <p className="card-sub">
              Well-lit, front-facing selfie for best results
            </p>
          </div>
          <form onSubmit={onAnalyze}>
            <DropZone file={file} previewUrl={previewUrl} onFile={setFile} />
            {error && (
              <div className="alert alert-error" role="alert">
                <svg
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="alert-icon"
                >
                  <path
                    fillRule="evenodd"
                    d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 5Zm0 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
                    clipRule="evenodd"
                  />
                </svg>
                {error}
              </div>
            )}
            <button
              type="submit"
              className="btn-primary btn-large"
              disabled={loading || !file}
            >
              {loading ? (
                <>
                  <Spinner /> Analyzing&hellip;
                </>
              ) : (
                <>
                  <svg
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="btn-icon"
                  >
                    <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
                    <path
                      fillRule="evenodd"
                      d="M.664 10.59a1.651 1.651 0 0 1 0-1.186A10.004 10.004 0 0 1 10 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0 1 10 17c-4.257 0-7.893-2.66-9.336-6.41ZM14 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z"
                      clipRule="evenodd"
                    />
                  </svg>
                  Analyze Skin
                </>
              )}
            </button>
          </form>
        </section>

        {result && (
          <div
            className={`card annotated-side-card ${showResults ? "results-visible" : ""}`}
          >
            <div className="card-header">
              <h2 className="card-title">AI Annotated</h2>
              <div className="image-subtabs">
                <button
                  className={`image-subtab ${imageSubView === "annotated" ? "image-subtab-active" : ""}`}
                  onClick={() => setImageSubView("annotated")}
                  type="button"
                >
                  Annotated
                </button>
                <button
                  className={`image-subtab ${imageSubView === "heatmap" ? "image-subtab-active" : ""}`}
                  onClick={() => setImageSubView("heatmap")}
                  type="button"
                >
                  Heatmap
                </button>
                <button
                  className={`image-subtab ${imageSubView === "original" ? "image-subtab-active" : ""}`}
                  onClick={() => setImageSubView("original")}
                  type="button"
                >
                  Original
                </button>
              </div>
            </div>
            <div className="image-frame annotated-frame annotated-side-frame">
              {(imageSubView === "annotated" && result.annotated_image_base64) ||
              (imageSubView === "heatmap" && result.heatmap_image_base64) ||
              (imageSubView === "original" && previewUrl) ? (
                <>
                  {imageSubView === "heatmap" && result.heatmap_image_base64 && (
                    <button
                      className="image-popout-btn"
                      type="button"
                      onClick={() => setHeatmapOpen(true)}
                    >
                      Expand
                    </button>
                  )}
                  <img
                    src={
                      imageSubView === "heatmap"
                        ? `data:image/jpeg;base64,${result.heatmap_image_base64}`
                        : imageSubView === "original"
                          ? previewUrl
                          : `data:image/jpeg;base64,${result.annotated_image_base64}`
                    }
                    alt={
                      imageSubView === "heatmap"
                        ? "Lesion heatmap"
                        : imageSubView === "original"
                          ? "Original upload"
                          : "Annotated"
                    }
                  />
                </>
              ) : (
                <div className="img-placeholder">Processing&hellip;</div>
              )}
            </div>
          </div>
        )}

        {heatmapOpen && result?.heatmap_image_base64 && (
          <div className="heatmap-modal" role="dialog" aria-modal="true" aria-label="Lesion heatmap preview">
            <button className="heatmap-modal-backdrop" type="button" onClick={closeHeatmapModal} />
            <div className="heatmap-modal-panel">
              <div className="heatmap-modal-header">
                <div>
                  <p className="report-doc-kicker">Lesion Heatmap</p>
                  <h4>Full-size focus view</h4>
                </div>
                <div className="heatmap-toolbar">
                  <button className="report-action-btn" type="button" onClick={() => adjustHeatmapZoom(-0.15)}>
                    -
                  </button>
                  <span className="heatmap-zoom-label">{Math.round(heatmapZoom * 100)}%</span>
                  <button className="report-action-btn" type="button" onClick={() => adjustHeatmapZoom(0.15)}>
                    +
                  </button>
                  <button className="report-action-btn" type="button" onClick={resetHeatmapZoom}>
                    Reset
                  </button>
                  <button className="report-action-btn" type="button" onClick={downloadHeatmapImage}>
                    Download
                  </button>
                  <button className="report-action-btn" type="button" onClick={closeHeatmapModal}>
                    Close
                  </button>
                </div>
              </div>
              <div className="heatmap-modal-frame">
                <img
                  className="heatmap-modal-image"
                  style={{ transform: `scale(${heatmapZoom})` }}
                  src={`data:image/jpeg;base64,${result.heatmap_image_base64}`}
                  alt="Enlarged lesion heatmap"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Results ── */}
      {result && (
        <div
          className={`results-wrapper ${showResults ? "results-visible" : ""}`}
        >
          {/* Severity Banner */}
          <div
            className="severity-banner"
            style={{ "--sev-color": sevConfig.color, "--sev-bg": sevConfig.bg }}
          >
            <div className="sev-left">
              <span
                className="sev-badge"
                style={{
                  color: sevConfig.color,
                  background: sevConfig.bg,
                  borderColor: sevConfig.color,
                }}
              >
                <span
                  className="sev-dot"
                  style={{ background: sevConfig.color }}
                />
                {sevConfig.label}
              </span>
              <div>
                <p className="sev-title">Analysis Complete</p>
                <p className="sev-sub">
                  Acne score: <strong>{acneScorePct}%</strong>
                </p>
              </div>
            </div>
            {/* ring uses acne_score * 360 — score is [0,1] */}
            <div
              className="sev-score-ring"
              style={{
                background: `conic-gradient(${sevConfig.color} ${(result.acne_score ?? 0) * 360}deg, #1e1e2e 0deg)`,
              }}
            >
              <span>{acneScorePct}%</span>
            </div>
          </div>

          {/* 4-col Stat Cards */}
          <div className="stats-row">
            <StatCard
              icon="AS"
              label="GAGS Severity"
              value={result.acne_severity ?? "—"}
              accent={sevConfig.color}
            />
            <StatCard
              icon="LC"
              label="Lesion Count"
              value={result.lesions?.length ?? 0}
              sub="detected lesions"
              accent="#FF6B00"
            />
            <StatCard
              icon="HP"
              label="Hyperpigmentation"
              value={`${hyperPct.toFixed(1)}%`}
              sub={hyper.severity ?? ""}
              accent="#00C9A0"
            />
            <StatCard
              icon="MZ"
              label="Most Affected Zone"
              accent="#00A8C8"
              value={
                Object.entries(zoneCounts).sort((a, b) => b[1] - a[1])[0]
                  ? ZONE_LABELS[
                      Object.entries(zoneCounts).sort(
                        (a, b) => b[1] - a[1],
                      )[0][0]
                    ] ||
                    Object.entries(zoneCounts).sort((a, b) => b[1] - a[1])[0][0]
                  : "—"
              }
            />
          </div>

          {/* Zone breakdown + Hyperpigmentation */}
          <div className="detail-row">
            <div className="card detail-card">
              <h3 className="detail-title">
                <svg
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="detail-icon"
                >
                  <path d="M15.5 2A1.5 1.5 0 0 0 14 3.5v13a1.5 1.5 0 0 0 3 0v-13A1.5 1.5 0 0 0 15.5 2ZM9.5 6A1.5 1.5 0 0 0 8 7.5v9a1.5 1.5 0 0 0 3 0v-9A1.5 1.5 0 0 0 9.5 6ZM3.5 10A1.5 1.5 0 0 0 2 11.5v5a1.5 1.5 0 0 0 3 0v-5A1.5 1.5 0 0 0 3.5 10Z" />
                </svg>
                Zone Breakdown
              </h3>
              <div className="zones">
                {Object.entries(ZONE_LABELS).map(([key, label]) => (
                  <ZoneBar
                    key={key}
                    label={label}
                    count={zoneCounts[key] ?? 0}
                    max={maxZone}
                  />
                ))}
              </div>
            </div>

            <div className="card detail-card hyper-card">
              <h3 className="detail-title">
                <svg
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="detail-icon"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-11.25a.75.75 0 0 0-1.5 0v2.5h-2.5a.75.75 0 0 0 0 1.5h2.5v2.5a.75.75 0 0 0 1.5 0v-2.5h2.5a.75.75 0 0 0 0-1.5h-2.5v-2.5Z"
                    clipRule="evenodd"
                  />
                </svg>
                Hyperpigmentation
              </h3>
              <div className="hyper-body">
                <CircularProgress
                  percent={hyperPct}
                  color={
                    hyperPct > 20
                      ? "#FF6B00"
                      : hyperPct > 10
                        ? "#00C9A0"
                        : "#00A8C8"
                  }
                />
                <div className="hyper-info">
                  <div className="hyper-stat">
                    <span className="hyper-stat-label">Coverage</span>
                    <span className="hyper-stat-val">
                      {hyperPct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="hyper-stat">
                    <span className="hyper-stat-label">Severity</span>
                    <span className="hyper-stat-val">
                      {hyper.severity ?? "—"}
                    </span>
                  </div>
                  <div className="hyper-gauge-row">
                    {["Low", "Moderate", "High"].map((l, i) => (
                      <div
                        key={l}
                        className={`hyper-gauge-seg ${i === 0 ? "seg-green" : i === 1 ? "seg-amber" : "seg-red"}`}
                      >
                        <span>{l}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Acne Type Breakdown — per zone grid */}
          {result.acne_type_breakdown && Object.keys(result.acne_type_breakdown).length > 0 && (
            <div className="card detail-card acne-type-card">
              <h3 className="detail-title">
                <svg viewBox="0 0 20 20" fill="currentColor" className="detail-icon">
                  <path fillRule="evenodd" d="M3.5 2A1.5 1.5 0 0 0 2 3.5v13A1.5 1.5 0 0 0 3.5 18h13a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 16.5 2h-13Zm6.75 3.25a.75.75 0 0 0-1.5 0v6.5a.75.75 0 0 0 1.5 0v-6.5Zm3.25 2.5a.75.75 0 0 0-1.5 0v4a.75.75 0 0 0 1.5 0v-4Zm-6.5 2a.75.75 0 0 0-1.5 0v2a.75.75 0 0 0 1.5 0v-2Z" clipRule="evenodd" />
                </svg>
                Acne Type Breakdown <span className="gags-badge">GAGS Score: {result.gags_score ?? 0}</span>
              </h3>
              <div className="acne-type-grid">
                {Object.entries(result.acne_type_breakdown).map(([zone, types]) => {
                  const total = Object.values(types).reduce((a, b) => a + b, 0);
                  if (total === 0) return null;
                  return (
                    <div key={zone} className="acne-type-zone">
                      <div className="acne-type-zone-label">{ZONE_LABELS[zone] ?? zone}</div>
                      <div className="acne-type-pills">
                        {Object.entries(types).map(([t, n]) =>
                          n > 0 ? (
                            <span key={t} className={`acne-pill acne-pill-${t}`}>
                              {n} {t.replace("_", "/")}
                            </span>
                          ) : null
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="acne-type-legend">
                {[["comedone","Comedone","#00C9A0"],["papule","Papule","#00A8C8"],["pustule","Pustule","#FF6B00"],["nodule_cyst","Nodule/Cyst","#FF6B00"]].map(([t, label, col]) => (
                  <span key={t} className="acne-legend-item">
                    <span className="acne-legend-dot" style={{background: col}} />
                    {label}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Summary */}
          {result.summary && (
            <div className="card summary-card">
              <h3 className="detail-title">
                <svg
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="detail-icon"
                >
                  <path
                    fillRule="evenodd"
                    d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM9 9a.75.75 0 0 0 0 1.5h.253a.25.25 0 0 1 .244.304l-.459 2.066A1.75 1.75 0 0 0 10.747 15H11a.75.75 0 0 0 0-1.5h-.253a.25.25 0 0 1-.244-.304l.459-2.066A1.75 1.75 0 0 0 9.253 9H9Z"
                    clipRule="evenodd"
                  />
                </svg>
                AI Summary
              </h3>
              <p className="summary-lead">{summaryText}</p>
              <div className="summary-facts">
                <span className="summary-fact">GAGS: {result.gags_score ?? 0} ({result.gags_severity ?? result.acne_severity})</span>
                <span className="summary-fact">Lesions: {lesionCount}</span>
                <span className="summary-fact">Top zone: {topZone}</span>
                <span className="summary-fact">
                  Hyperpig: {Number(result.hyperpigmentation?.coverage_percent ?? 0).toFixed(1)}% / {result.hyperpigmentation?.severity || "N/A"}
                </span>
              </div>
              <div className="summary-actions">
                <button className="report-action-btn" type="button" onClick={copySummaryText}>
                  Copy Summary
                </button>
                <button
                  className="report-action-btn"
                  type="button"
                  onClick={() => setHeatmapOpen(true)}
                  disabled={!result.heatmap_image_base64}
                >
                  Maximize Heatmap
                </button>
              </div>
              <div className="disclaimer">
                <svg
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className="disclaimer-icon"
                >
                  <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 11a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Zm.75-3.75a.75.75 0 0 1-1.5 0V5.75a.75.75 0 0 1 1.5 0v2.5Z" />
                </svg>
                This analysis is for informational purposes only and does not
                constitute medical advice. Consult a dermatologist for clinical
                diagnosis.
              </div>
            </div>
          )}

          <div className="card summary-card">
            <h3 className="detail-title">
              <svg
                viewBox="0 0 20 20"
                fill="currentColor"
                className="detail-icon"
              >
                <path
                  fillRule="evenodd"
                  d="M4.25 3A2.25 2.25 0 0 0 2 5.25v9.5A2.25 2.25 0 0 0 4.25 17h11.5A2.25 2.25 0 0 0 18 14.75v-9.5A2.25 2.25 0 0 0 15.75 3H4.25ZM5.5 6.75a.75.75 0 0 1 .75-.75h7.5a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1-.75-.75Zm0 3a.75.75 0 0 1 .75-.75h7.5a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1-.75-.75Zm0 3a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75Z"
                  clipRule="evenodd"
                />
              </svg>
              Detailed AI Report
            </h3>
            {reportLoading && (
              <div className="report-skeleton">
                <div className="report-loading-row">
                  <Spinner />
                  <span>Preparing your dermatology-style report document...</span>
                </div>
                <blockquote className="report-quote">
                  "{REPORT_QUOTES[reportQuoteIndex]}"
                </blockquote>
                <div className="report-shimmer-line" />
                <div className="report-shimmer-line" />
                <div className="report-shimmer-line short" />
              </div>
            )}
            {!reportLoading && reportError && (
              <div className="alert alert-error" role="alert">
                <svg
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="alert-icon"
                >
                  <path
                    fillRule="evenodd"
                    d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 5Zm0 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
                    clipRule="evenodd"
                  />
                </svg>
                {reportError}
              </div>
            )}
            {!reportLoading && detailedReport?.report && (
              <article className="report-document">
                <header className="report-doc-header">
                  <div>
                    <p className="report-doc-kicker">SkinSight Report Document</p>
                    <h4>AI Skin Condition Guidance</h4>
                  </div>
                  <div className="report-doc-meta">
                    <span>Model: {detailedReport.model}</span>
                    <span>Source: {detailedReport.generated_by}</span>
                  </div>
                </header>
                <div className="report-actions">
                  <button className="report-action-btn" type="button" onClick={exportReportPdf}>
                    Export PDF
                  </button>
                  <button className="report-action-btn" type="button" onClick={copyReportText}>
                    Copy Text
                  </button>
                  <button className="report-action-btn" type="button" onClick={downloadAnalysisJson}>
                    Download JSON
                  </button>
                </div>
                {!!actionMessage && <p className="report-action-note">{actionMessage}</p>}
                <pre className="detailed-report-text">{normalizedReportText}</pre>
                <div className="disclaimer">{detailedReport.disclaimer}</div>
              </article>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════
   PROGRESS TRACKING TAB
══════════════════════════════════════════════ */
function TrackTab() {
  const [beforeFile, setBeforeFile] = useState(null);
  const [afterFile, setAfterFile] = useState(null);
  const [comparing, setComparing] = useState(false);
  const [compareResult, setCompareResult] = useState(null);
  const [compareError, setCompareError] = useState("");

  const beforeUrl = useMemo(
    () => (beforeFile ? URL.createObjectURL(beforeFile) : null),
    [beforeFile],
  );
  const afterUrl = useMemo(
    () => (afterFile ? URL.createObjectURL(afterFile) : null),
    [afterFile],
  );

  const onCompare = async () => {
    if (!beforeFile || !afterFile) {
      setCompareError("Upload both scans first.");
      return;
    }
    setComparing(true);
    setCompareError("");
    setCompareResult(null);
    try {
      const fd = new FormData();
      fd.append("baseline", beforeFile); // BEFORE = acne skin
      fd.append("followup", afterFile); // AFTER  = clearer skin
      const res = await fetch(`${API_BASE}/track`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const p = await res.json().catch(() => ({}));
        throw new Error(p.detail || `Server error ${res.status}`);
      }
      setCompareResult(await res.json());
    } catch (err) {
      setCompareError(err.message || "Comparison failed.");
    } finally {
      setComparing(false);
    }
  };

  const improvement = compareResult?.improvement_percent ?? 0;
  const improved = improvement > 0;
  const stageOrder = ["now", "short_term", "long_term"];
  const currentStageKey =
    compareResult?.timeline === "long_term"
      ? "long_term"
      : compareResult?.timeline === "short_term"
        ? "short_term"
        : "now";
  const currentStageIndex = Math.max(0, stageOrder.indexOf(currentStageKey));

  return (
    <div className="tab-content">
      <div className="card track-card-full">
        <div className="card-header">
          <h2 className="card-title">Progress Tracking</h2>
          <p className="card-sub">
            Upload a <strong>before</strong> photo (with acne) on the left and
            an <strong>after</strong> photo (clearer skin) on the right to
            measure your improvement
          </p>
        </div>

        {/* Before ──→ After upload row */}
        <div className="track-uploads">
          {/* BEFORE */}
          <div className="track-upload-slot">
            <p className="slot-label">
              <span className="slot-num before-num">BEFORE</span>
              Skin with Acne
            </p>
            <MiniDrop
              label="Upload Before Photo"
              file={beforeFile}
              previewUrl={beforeUrl}
              onFile={setBeforeFile}
            />
            {compareResult && (
              <div className="slot-count">
                <span className="slot-count-num bad">
                  {compareResult.baseline_lesions}
                </span>
                <span className="slot-count-label">lesions</span>
              </div>
            )}
          </div>

          {/* Arrow */}
          <div className="track-arrow">
            <svg viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M3 10a.75.75 0 0 1 .75-.75h10.638L10.23 5.29a.75.75 0 1 1 1.04-1.08l5.5 5.25a.75.75 0 0 1 0 1.08l-5.5 5.25a.75.75 0 1 1-1.04-1.08l4.158-3.96H3.75A.75.75 0 0 1 3 10Z"
                clipRule="evenodd"
              />
            </svg>
            <span className="track-arrow-label">Progress</span>
          </div>

          {/* AFTER */}
          <div className="track-upload-slot">
            <p className="slot-label">
              <span className="slot-num after-num">AFTER</span>
              Clearer Skin
            </p>
            <MiniDrop
              label="Upload After Photo"
              file={afterFile}
              previewUrl={afterUrl}
              onFile={setAfterFile}
            />
            {compareResult && (
              <div className="slot-count">
                <span className={`slot-count-num ${improved ? "good" : "bad"}`}>
                  {compareResult.followup_lesions}
                </span>
                <span className="slot-count-label">lesions</span>
              </div>
            )}
          </div>
        </div>

        {compareError && (
          <div className="alert alert-error">
            <svg viewBox="0 0 20 20" fill="currentColor" className="alert-icon">
              <path
                fillRule="evenodd"
                d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 5Zm0 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
                clipRule="evenodd"
              />
            </svg>
            {compareError}
          </div>
        )}

        <button
          className="btn-primary"
          onClick={onCompare}
          disabled={comparing || !beforeFile || !afterFile}
        >
          {comparing ? (
            <>
              <Spinner /> Comparing&hellip;
            </>
          ) : (
            "Compare Progress"
          )}
        </button>

        {compareResult && (
          <div className="compare-results">
            {/* 4-col metrics */}
            <div className="compare-metrics">
              <div className="compare-metric">
                <span className="cm-label">Before Lesions</span>
                <span className="cm-value accent-red">
                  {compareResult.baseline_lesions}
                </span>
              </div>
              <div className="compare-metric">
                <span className="cm-label">After Lesions</span>
                <span
                  className={`cm-value ${improved ? "accent-green" : "accent-red"}`}
                >
                  {compareResult.followup_lesions}
                </span>
              </div>
              <div className="compare-metric">
                <span className="cm-label">Improvement</span>
                <span
                  className={`cm-value ${improved ? "accent-green" : "accent-red"}`}
                >
                  {improvement > 0 ? "+" : ""}
                  {improvement.toFixed(1)}%
                </span>
              </div>
              <div className="compare-metric">
                <span className="cm-label">Image Similarity</span>
                <span className="cm-value accent-purple">
                  {(compareResult.similarity * 100).toFixed(1)}%
                </span>
              </div>
            </div>

            {/* Trend bar */}
            <div className="trend-bar-wrap">
              <div className="trend-bar-track">
                <div
                  className={`trend-bar-fill ${improved ? "trend-good" : "trend-bad"}`}
                  style={{ width: `${Math.min(Math.abs(improvement), 100)}%` }}
                />
              </div>
              <span
                className={`trend-label ${improved ? "accent-green" : "accent-red"}`}
              >
                {improvement > 10
                  ? `${improvement.toFixed(1)}% improvement`
                  : improvement < -10
                    ? `${Math.abs(improvement).toFixed(1)}% worsening`
                    : "Stable — minimal change"}
              </span>
            </div>

            {compareResult.summary && (
              <div className="compare-summary">{compareResult.summary}</div>
            )}

            {Array.isArray(compareResult.stages) && compareResult.stages.length > 0 && (
              <div className="progress-stages">
                {compareResult.stages.map((stage, idx) => {
                  const stageStatus =
                    idx < currentStageIndex
                      ? "progress-stage-completed"
                      : idx === currentStageIndex
                        ? "progress-stage-current"
                        : "progress-stage-future";

                  return (
                    <div key={stage.key} className={`progress-stage-card ${stageStatus}`}>
                    <h4>{stage.title}</h4>
                    <ul>
                      {stage.bullets.map((item, idx) => (
                        <li key={`${stage.key}-${idx}`}>{item}</li>
                      ))}
                    </ul>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   ROOT APP
══════════════════════════════════════════════ */
export default function App() {
  const restoredAuth = useMemo(() => readStoredAuthSession(), []);
  const initialPath = (window.location.pathname || "/").replace(/\/$/, "") || "/";
  const [activeTab, setActiveTab] = useState(
    initialPath === "/progress-tracker" ? "recovery" : "analyze",
  );
  const [analyzeViewPreset, setAnalyzeViewPreset] = useState("annotated");
  const [isAuthenticated, setIsAuthenticated] = useState(Boolean(restoredAuth?.token));
  const [showProduct, setShowProduct] = useState(false);
  const [authUser, setAuthUser] = useState(restoredAuth?.user ?? null);
  const [authToken, setAuthToken] = useState(restoredAuth?.token ?? "");
  const [authReady, setAuthReady] = useState(!restoredAuth?.token);
  const [showProfile, setShowProfile] = useState(false);

  const recoveryUserId = useMemo(() => buildRecoveryUserId(authUser), [authUser]);

  const switchTab = (tab, preset) => {
    if (preset) {
      setAnalyzeViewPreset(preset);
    }
    setActiveTab(tab);

    const url = new URL(window.location.href);
    if (tab === "recovery") {
      url.pathname = "/progress-tracker";
    } else {
      url.pathname = "/";
      url.search = "";
    }
    window.history.replaceState({}, "", url.toString());
  };

  useEffect(() => {
    const onPopState = () => {
      const pathname = (window.location.pathname || "/").replace(/\/$/, "") || "/";
      if (pathname === "/progress-tracker") {
        setActiveTab("recovery");
      } else {
        setActiveTab("analyze");
      }
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!restoredAuth?.token) {
      setAuthReady(true);
      return undefined;
    }

    let cancelled = false;

    const verifySession = async () => {
      try {
        const response = await fetch(`${API_BASE}/auth/me`, {
          headers: {
            Authorization: `Bearer ${restoredAuth.token}`,
          },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(authErrorMessage(payload?.detail, response.status));
        }

        const serverUser = normalizeAuthUser(payload);
        if (!serverUser) {
          throw new Error("Invalid session payload");
        }

        if (!cancelled) {
          setAuthUser(serverUser);
          setIsAuthenticated(true);
          writeStoredAuthSession(restoredAuth.token, serverUser);
        }
      } catch {
        if (!cancelled) {
          clearStoredAuthSession();
          setAuthToken("");
          setAuthUser(null);
          setIsAuthenticated(false);
          setShowProduct(false);
        }
      } finally {
        if (!cancelled) {
          setAuthReady(true);
        }
      }
    };

    verifySession();
    return () => {
      cancelled = true;
    };
  }, [restoredAuth]);

  useEffect(() => {
    if (!isAuthenticated) {
      setShowProduct(false);
      setShowProfile(false);
      return undefined;
    }
    const timer = setTimeout(() => setShowProduct(true), 1800);
    return () => clearTimeout(timer);
  }, [isAuthenticated]);

  const onLogout = () => {
    setIsAuthenticated(false);
    setShowProduct(false);
    setShowProfile(false);
    setAuthUser(null);
    setAuthToken("");
    clearStoredAuthSession();
    setActiveTab("analyze");
    setAnalyzeViewPreset("annotated");

    const url = new URL(window.location.href);
    url.pathname = "/";
    url.search = "";
    window.history.replaceState({}, "", url.toString());
  };

  if (!authReady) {
    return (
      <div className="auth-page">
        <div className="auth-wave auth-wave-a" />
        <div className="auth-wave auth-wave-b" />
        <div className="auth-panel">
          <p className="auth-kicker">SkinSight Access</p>
          <h1 className="auth-title">Restoring Session</h1>
          <p className="auth-sub">Checking your saved sign-in details...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <AuthGate
        onSuccess={({ token, user }) => {
          const normalizedUser = normalizeAuthUser(user);
          if (!normalizedUser) {
            return;
          }
          setAuthUser(normalizedUser);
          setAuthToken(token);
          writeStoredAuthSession(token, normalizedUser);
          setIsAuthenticated(true);
        }}
      />
    );
  }

  if (!showProduct) {
    return (
      <div className="landing-page">
        <div className="landing-panel">
          <p className="landing-kicker">AI Facial Screening</p>
          <h1 className="landing-title">SkinSight</h1>
          <p className="landing-sub">
            Clinical-style visual analysis with acne grading, lesion mapping,
            and detailed AI guidance.
          </p>
          <button className="landing-btn" onClick={() => setShowProduct(true)}>
            Enter Product
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="orb orb-1" />
      <div className="orb orb-2" />
      <div className="orb orb-3" />

      <div className="container">
        <nav className="top-nav">
          <div className="top-nav-brand">SkinSight</div>
          <div className="top-nav-actions">
            <button
              className={`top-nav-btn ${activeTab === "analyze" && analyzeViewPreset !== "heatmap" ? "top-nav-btn-active" : ""}`}
              onClick={() => {
                switchTab("analyze", "annotated");
              }}
            >
              Skin Analysis
            </button>
            <button
              className={`top-nav-btn ${activeTab === "track" ? "top-nav-btn-active" : ""}`}
              onClick={() => switchTab("track")}
            >
              Quick Compare
            </button>
            <button
              className={`top-nav-btn ${activeTab === "analyze" && analyzeViewPreset === "heatmap" ? "top-nav-btn-active" : ""}`}
              onClick={() => {
                switchTab("analyze", "heatmap");
              }}
            >
              Lesion Heatmap
            </button>
            <button
              className={`top-nav-btn ${activeTab === "recovery" ? "top-nav-btn-active" : ""}`}
              onClick={() => switchTab("recovery")}
            >
              Recovery Dashboard
            </button>
            <button
              className={`top-nav-btn ${showProfile ? "top-nav-btn-active" : ""}`}
              onClick={() => setShowProfile(true)}
            >
              Show Profile
            </button>
          </div>
        </nav>

        {/* Hero */}
        <header className="hero">
          <div className="hero-layout">
            <div className="hero-main">
              <div className="hero-badge">
                <span className="badge-dot" />
                AI-Powered Analysis
              </div>
              <h1 className="hero-title">
                <span className="gradient-text">SkinSight</span>
                <span className="hero-title-white"> AI</span>
              </h1>
              <p className="hero-sub">
                Dermatological-grade skin analysis in seconds
              </p>
              <div className="hero-features">
                {[
                  "Acne Detection",
                  "Zone Mapping",
                  "Hyperpigmentation",
                  "Progress Tracking",
                ].map((f) => (
                  <span key={f} className="feature-pill">
                    {f}
                  </span>
                ))}
              </div>
            </div>

            <aside className="hero-side-cards">
              <div className="hero-side-card">
                <p>AI Report</p>
                <strong>Structured + Exportable</strong>
              </div>
              <div className="hero-side-card">
                <p>Image Views</p>
                <strong>Annotated / Heatmap / Original</strong>
              </div>
              <div className="hero-side-card">
                <p>Tracking</p>
                <strong>Now, Short Term, Long Term</strong>
              </div>
            </aside>
          </div>
        </header>

        {/* Active tab */}
        <div className="tab-screen" key={activeTab}>
          {activeTab === "analyze" ? (
            <AnalyzeTab forcedView={analyzeViewPreset} />
          ) : activeTab === "track" ? (
            <TrackTab />
          ) : (
            <ProgressTrackerPage
              embedded
              onBackToAnalyzer={() => switchTab("analyze", "annotated")}
              signedInUser={authUser}
              signedInUserId={recoveryUserId}
            />
          )}
        </div>

        {showProfile ? (
          <ProfilePanel
            user={authUser}
            recoveryUserId={recoveryUserId}
            onClose={() => setShowProfile(false)}
            onLogout={onLogout}
          />
        ) : null}

        <footer className="footer">
          <p>
            SkinSight AI &mdash; Hackathon Build &mdash; Not for clinical use
          </p>
        </footer>

        <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
          <button
            type="button"
            className={`mobile-nav-btn ${activeTab === "analyze" ? "mobile-nav-btn-active" : ""}`}
            onClick={() => switchTab("analyze", "annotated")}
            aria-current={activeTab === "analyze" ? "page" : undefined}
          >
            <svg viewBox="0 0 24 24" className="mobile-nav-icon" fill="none" stroke="currentColor" strokeWidth="1.9">
              <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z" />
            </svg>
            <span className="mobile-nav-label">Analyze</span>
          </button>

          <button
            type="button"
            className={`mobile-nav-btn ${activeTab === "track" ? "mobile-nav-btn-active" : ""}`}
            onClick={() => switchTab("track")}
            aria-current={activeTab === "track" ? "page" : undefined}
          >
            <svg viewBox="0 0 24 24" className="mobile-nav-icon" fill="none" stroke="currentColor" strokeWidth="1.9">
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 3h9A1.5 1.5 0 0 1 18 4.5v15A1.5 1.5 0 0 1 16.5 21h-9A1.5 1.5 0 0 1 6 19.5v-15A1.5 1.5 0 0 1 7.5 3Zm2.25 4.5h4.5m-4.5 4.5h4.5m-4.5 4.5h2.25" />
            </svg>
            <span className="mobile-nav-label">Compare</span>
          </button>

          <button
            type="button"
            className={`mobile-nav-btn ${activeTab === "recovery" ? "mobile-nav-btn-active" : ""}`}
            onClick={() => switchTab("recovery")}
            aria-current={activeTab === "recovery" ? "page" : undefined}
          >
            <svg viewBox="0 0 24 24" className="mobile-nav-icon" fill="none" stroke="currentColor" strokeWidth="1.9">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 19.5h15M7.5 16.5v-3m4.5 3V9m4.5 7.5V6" />
            </svg>
            <span className="mobile-nav-label">Recovery</span>
          </button>

          <button
            type="button"
            className={`mobile-nav-btn ${showProfile ? "mobile-nav-btn-active" : ""}`}
            onClick={() => setShowProfile(true)}
            aria-current={showProfile ? "page" : undefined}
          >
            <svg viewBox="0 0 24 24" className="mobile-nav-icon" fill="none" stroke="currentColor" strokeWidth="1.9">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 7.5a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.5 20.25a7.5 7.5 0 0 1 15 0" />
            </svg>
            <span className="mobile-nav-label">Profile</span>
          </button>
        </nav>
      </div>
    </div>
  );
}
