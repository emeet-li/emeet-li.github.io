import { parseCSV, inspectData, buildPrEmbedding } from "./pipeline.js";
import { createPrPlot } from "./plot.js";

const SAMPLE_URL = "sample_data/ethereum_pr_sample.csv";

const state = {
  data: null,
  result: null,
};

const els = {
  csvFile: document.getElementById("csv-file"),
  loadSample: document.getElementById("load-sample"),
  githubPr: document.getElementById("github-pr"),
  entityCol: document.getElementById("entity-col"),
  patternCol: document.getElementById("pattern-col"),
  direction: document.getElementById("direction"),
  distanceMode: document.getElementById("distance-mode"),
  colorMode: document.getElementById("color-mode"),
  colorLegend: document.getElementById("color-legend"),
  duration: document.getElementById("duration"),
  durationValue: document.getElementById("duration-value"),
  hideEnded: document.getElementById("hide-ended"),
  entityType: document.getElementById("entity-type"),
  aiFilter: document.getElementById("ai-filter"),
  viewMode: document.getElementById("view-mode"),
  landscapeControls: document.getElementById("landscape-controls"),
  landscapeShow: document.getElementById("landscape-show"),
  landscapeMetric: document.getElementById("m-landscape"),
  showAxes: document.getElementById("show-axes"),
  showTime: document.getElementById("show-time"),
  showAi: document.getElementById("show-ai"),
  autoRotate: document.getElementById("auto-rotate"),
  freqFilter: document.getElementById("freq-filter"),
  minFreq: document.getElementById("min-freq"),
  minFreqValue: document.getElementById("min-freq-value"),
  recurrent: document.getElementById("m-recurrent"),
  aiMarks: document.getElementById("m-ai"),
  play: document.getElementById("play"),
  stop: document.getElementById("stop"),
  reset: document.getElementById("reset"),
  timerValue: document.getElementById("timer-value"),
  timerSpan: document.getElementById("timer-span"),
  status: document.getElementById("status"),
  clock: document.getElementById("m-clock"),
  repo: document.getElementById("m-repo"),
  rows: document.getElementById("m-rows"),
  prs: document.getElementById("m-prs"),
  visible: document.getElementById("m-visible"),
  stress: document.getElementById("m-stress"),
  hover: document.getElementById("m-hover"),
  detail: document.getElementById("pr-detail"),
  detailId: document.getElementById("detail-id"),
  detailMeta: document.getElementById("detail-meta"),
  detailSeq: document.getElementById("detail-seq"),
  detailClose: document.getElementById("detail-close"),
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatMonth(ts) {
  if (!Number.isFinite(ts)) return "—";
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

function formatTimestamp(ts) {
  if (!Number.isFinite(ts)) return "—";
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC`;
}

function showPrDetail(pr) {
  if (!pr) {
    els.detail.hidden = true;
    els.detailId.textContent = "—";
    els.detailMeta.textContent = "";
    els.detailSeq.innerHTML = "";
    return;
  }
  const steps = pr.steps && pr.steps.length
    ? pr.steps
    : String(pr.sequence || "").split(" → ").filter(Boolean);
  els.detail.hidden = false;
  els.detailId.textContent = `PR #${pr.id}`;
  els.detailMeta.textContent = [
    pr.repo || "unknown repo",
    pr.isPullRequest ? "pull request" : "issue / not PR",
    pr.outcome,
    pr.aiAppearTs != null
      ? `AI ${pr.aiAgent || "agent"} @ ${formatTimestamp(pr.aiAppearTs)}`
      : null,
    pr.phase ? `${pr.phase} AI landscape` : null,
    pr.freq > 1 ? `process ×${pr.freq}` : null,
    `${pr.nEvents || (pr.sequence ? String(pr.sequence).split(" → ").length : 0)} events`,
    pr.freq > 1 && !pr.phase ? `process seen ${pr.freq} times` : (!pr.phase ? "unique process" : null),
    `${formatTimestamp(pr.startTs)} → ${formatTimestamp(pr.endTs)}`,
  ].filter(Boolean).join(" · ");
  els.detailSeq.innerHTML = steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const plot = createPrPlot(
  document.getElementById("plot"),
  (pr) => {
    if (!pr) {
      els.hover.textContent = "Click a point for PR ID and sequence";
      return;
    }
    const freqBit = pr.freq > 1 ? ` · ×${pr.freq}` : "";
    const aiBit = pr.aiAppearTs != null ? ` · AI ${pr.aiAgent || "agent"}` : "";
    els.hover.textContent = `${pr.repo ? pr.repo + " · " : ""}PR #${pr.id}${freqBit}${aiBit} · click to open sequence`;
  },
  showPrDetail
);

function fillSelect(el, values, selected) {
  el.innerHTML = (values || []).map((v) => {
    const sel = v === selected ? " selected" : "";
    return `<option value="${v}"${sel}>${v}</option>`;
  }).join("");
}

function setStatus(text) {
  els.status.textContent = text;
}

function canResume() {
  if (!state.result) return false;
  if (currentViewMode() === "ai_landscape") return false;
  if (plot.isPlaying()) return false;
  const now = plot.getNow();
  return now != null && now >= state.result.tMin && now < state.result.tMax;
}

function syncPlayButtons() {
  const has = !!state.result;
  const playing = plot.isPlaying();
  els.play.disabled = !has || playing;
  els.stop.disabled = !has || !playing;
  els.reset.disabled = !has;
  els.play.textContent = canResume() ? "Continue" : "Start";
}

function setPlayEnabled(on) {
  if (!on) {
    els.play.disabled = true;
    els.stop.disabled = true;
    els.reset.disabled = true;
    els.play.textContent = "Start";
    return;
  }
  syncPlayButtons();
}

function currentMinFreq() {
  if (els.hideEnded && els.hideEnded.checked) return 1;
  return Number(els.minFreq && els.minFreq.value) || 1;
}

function currentEntityType() {
  return (els.entityType && els.entityType.value) || "both";
}

function currentAiFilter() {
  return (els.aiFilter && els.aiFilter.value) || "all";
}

function currentViewMode() {
  return (els.viewMode && els.viewMode.value) || "traces";
}

function currentLandscapeShow() {
  return (els.landscapeShow && els.landscapeShow.value) || "both";
}

function entityViewLabel() {
  const t = currentEntityType();
  if (t === "pull_request") return "Pull request only";
  if (t === "issue") return "Issue only";
  return "PR + issue";
}

function syncViewTitle() {
  const el = document.getElementById("view-title");
  if (!el) return;
  const landscape = currentViewMode() === "ai_landscape";
  const scope = entityViewLabel();
  if (landscape) {
    el.hidden = false;
    el.textContent = `Landscape: ${scope}`;
    return;
  }
  // In traces view, highlight when filtered away from "both"
  if (currentEntityType() !== "both") {
    el.hidden = false;
    el.textContent = scope;
    return;
  }
  el.hidden = true;
  el.textContent = "";
}

function syncLandscapeControls() {
  const on = currentViewMode() === "ai_landscape";
  if (els.landscapeControls) els.landscapeControls.hidden = !on;
  const hud = document.getElementById("landscape-hud");
  const before = document.getElementById("land-hud-before");
  const after = document.getElementById("land-hud-after");
  if (hud) hud.hidden = !on;
  syncViewTitle();
  if (!on) return;
  const show = currentLandscapeShow();
  if (before) before.hidden = !(show === "both" || show === "before");
  if (after) after.hidden = !(show === "both" || show === "after");
}

function visibleCount(result, now) {
  if (!result || now == null) return 0;
  const hideEnded = els.hideEnded && els.hideEnded.checked;
  const minFreq = currentMinFreq();
  const entityType = currentEntityType();
  const aiFilter = currentAiFilter();
  return result.traces.filter((t) => {
    if (now < t.startTs) return false;
    if (hideEnded && t.outcome !== "open" && now >= t.endTs) return false;
    if (!hideEnded && (t.freq || 1) < minFreq) return false;
    if (entityType === "pull_request" && !t.isPullRequest) return false;
    if (entityType === "issue" && t.isPullRequest) return false;
    const hasAi = t.aiAppearTs != null;
    if (aiFilter === "ai" && !hasAi) return false;
    if (aiFilter === "no_ai" && hasAi) return false;
    return true;
  }).length;
}

function syncFreqFilter() {
  const show = !(els.hideEnded && els.hideEnded.checked);
  if (els.freqFilter) els.freqFilter.hidden = !show;
  const min = currentMinFreq();
  if (els.minFreqValue) {
    els.minFreqValue.textContent = min <= 1 ? "1+ all" : `${min}+ recurrent`;
  }
}

function renderMetrics() {
  if (!state.result) {
    els.prs.textContent = "—";
    els.visible.textContent = "—";
    els.stress.textContent = "—";
    els.clock.textContent = "—";
    if (els.timerValue) els.timerValue.textContent = "—";
    if (els.timerSpan) els.timerSpan.textContent = "";
    if (els.repo) els.repo.textContent = "—";
    if (els.recurrent) els.recurrent.textContent = "—";
    if (els.aiMarks) els.aiMarks.textContent = "—";
    if (els.landscapeMetric) els.landscapeMetric.textContent = "—";
    return;
  }
  const { nPrs, tMin, tMax, stress, meanAbsError, repos } = state.result;
  if (els.repo) {
    els.repo.textContent = !repos || !repos.length
      ? "—"
      : repos.length === 1
        ? repos[0]
        : `${repos.length} repos · ${repos.slice(0, 3).join(", ")}${repos.length > 3 ? "…" : ""}`;
  }
  const now = plot.getNow();
  els.prs.textContent = String(nPrs);
  els.visible.textContent = String(visibleCount(state.result, now));
  if (els.recurrent) {
    const maxF = state.result.maxFreq || 1;
    const nProc = state.result.nRecurrentProcesses || 0;
    const nPrsR = state.result.nRecurrentPrs || 0;
    els.recurrent.textContent = nProc
      ? `${nProc} processes · ${nPrsR} PRs · max ×${maxF}`
      : `none · max ×${maxF}`;
  }
  if (els.aiMarks) {
    els.aiMarks.textContent = String(state.result.nAiPrs || 0);
  }
  if (els.landscapeMetric) {
    const lands = (plot.getActiveLandscapes && plot.getActiveLandscapes()) || state.result.landscapes;
    if (!lands) els.landscapeMetric.textContent = "—";
    else {
      const nb = (lands.before && lands.before.points && lands.before.points.length) || 0;
      const na = (lands.after && lands.after.points && lands.after.points.length) || 0;
      const fb = (lands.before && lands.before.maxFreq) || 1;
      const fa = (lands.after && lands.after.maxFreq) || 1;
      const scope = currentEntityType() === "pull_request"
        ? "PR only"
        : currentEntityType() === "issue"
          ? "issue only"
          : "PR+issue";
      els.landscapeMetric.textContent = `${scope} · before ${nb} pts · after ${na} pts · max ×${Math.max(fb, fa)}`;
    }
  }
  els.stress.textContent = `${(stress * 100).toFixed(1)}%  ·  mean |Δ| ${(meanAbsError || 0).toFixed(3)}`;
  const stamp = now == null || now < tMin ? "before start" : formatTimestamp(now);
  els.clock.textContent = stamp;
  if (els.timerValue) els.timerValue.textContent = stamp;
  if (els.timerSpan) els.timerSpan.textContent = `${formatTimestamp(tMin)} → ${formatTimestamp(tMax)}`;
  syncPlayButtons();
}

function applyInspect(info, filename) {
  state.data = info;
  fillSelect(els.entityCol, info.entityChoices, info.entityCol);
  fillSelect(els.patternCol, info.patternChoices, info.patternCol);
  els.githubPr.checked = info.githubPr;
  els.rows.textContent = String(info.records.length);
  const repoLabel = info.repos && info.repos.length
    ? (info.repos.length === 1 ? info.repos[0] : `${info.repos.length} repos`)
    : "";
  if (els.repo) els.repo.textContent = repoLabel || "—";
  setStatus(
    filename
      ? `Loaded ${filename}${repoLabel ? " · " + repoLabel : ""}`
      : `Loaded ${info.records.length} rows${repoLabel ? " · " + repoLabel : ""}`
  );
}

async function loadText(text, filename) {
  const parsed = parseCSV(text);
  if (!parsed.records.length) throw new Error("The CSV has no data rows.");
  applyInspect(inspectData(parsed), filename);
}

async function loadSample() {
  setStatus("Loading sample");
  const res = await fetch(SAMPLE_URL);
  if (!res.ok) throw new Error("Could not load sample CSV");
  await loadText(await res.text(), "ethereum_pr_sample.csv");
}

async function embedNow() {
  if (!state.data) return;
  setStatus("Computing process layout…");
  setPlayEnabled(false);
  await new Promise((resolve) => setTimeout(resolve, 40));
  try {
    state.result = buildPrEmbedding(state.data.records, state.data.headers, {
      timeCol: state.data.timeCol,
      entityCol: els.entityCol.value || null,
      patternCol: els.patternCol.value,
      directed: els.direction.value === "directed",
      githubPr: els.githubPr.checked,
      distanceMode: els.distanceMode.value,
      repoCol: state.data.repoCol,
      isPrCol: state.data.isPrCol,
    });
    if (els.minFreq) {
      const maxF = Math.max(state.result.maxFreq || 1, 1);
      els.minFreq.max = String(maxF);
      if (Number(els.minFreq.value) > maxF) els.minFreq.value = String(maxF);
    }
    syncFreqFilter();
    plot.render(state.result, {
      colorMode: els.colorMode.value,
      durationSec: Number(els.duration.value),
      hideEnded: els.hideEnded.checked,
      minFreq: currentMinFreq(),
      entityType: currentEntityType(),
      aiFilter: currentAiFilter(),
      viewMode: currentViewMode(),
      landscapeShow: currentLandscapeShow(),
      showAxes: !els.showAxes || els.showAxes.checked,
      showTime: !els.showTime || els.showTime.checked,
      showAiMarks: !!(els.showAi && els.showAi.checked),
      autoRotate: !els.autoRotate || els.autoRotate.checked,
    });
    setPlayEnabled(true);
    renderMetrics();
    const repoBit = state.result.repos && state.result.repos.length === 1
      ? `${state.result.repos[0]} · `
      : "";
    const aiBit = state.result.nAiPrs
      ? ` · ${state.result.nAiPrs} AI marks`
      : "";
    const land = state.result.landscapes;
    const landBit = land && (land.before.nodes.length || land.after.nodes.length)
      ? ` · landscapes ready`
      : "";
    setStatus(`${repoBit}${state.result.nPrs} PRs embedded${aiBit}${landBit} · traces shown · Start replays`);
  } catch (err) {
    state.result = null;
    plot.render(null);
    setPlayEnabled(false);
    renderMetrics();
    setStatus(err.message || String(err));
  }
}

els.csvFile.addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    await loadText(await file.text(), file.name);
    embedNow();
  } catch (err) {
    setStatus(err.message || String(err));
  }
});

els.loadSample.addEventListener("click", async () => {
  try {
    await loadSample();
    embedNow();
  } catch (err) {
    setStatus(err.message || String(err));
  }
});

els.play.addEventListener("click", () => {
  plot.setOptions({ durationSec: Number(els.duration.value) });
  if (currentViewMode() === "ai_landscape") {
    plot.play();
    setStatus("Deforming · dots drop and push the manifold");
  } else if (canResume()) {
    plot.resume();
    setStatus("Continuing traces");
  } else {
    plot.play();
    setStatus("Playing traces");
  }
  syncPlayButtons();
});
els.stop.addEventListener("click", () => {
  plot.stop();
  syncPlayButtons();
  setStatus(currentViewMode() === "ai_landscape" ? "Paused deform · press Start" : "Paused · press Continue");
});
els.reset.addEventListener("click", () => {
  plot.reset();
  syncPlayButtons();
  renderMetrics();
  setStatus(currentViewMode() === "ai_landscape" ? "Reset landscape · press Start" : "Reset · press Start");
});

els.duration.addEventListener("input", () => {
  els.durationValue.textContent = `${els.duration.value}s`;
  plot.setOptions({ durationSec: Number(els.duration.value) });
});
function syncColorLegend() {
  if (!els.colorLegend) return;
  const mode = els.colorMode.value;
  const show = mode === "outcome" || mode === "pull_request";
  els.colorLegend.hidden = !show;
  const outcome = els.colorLegend.querySelector(".legend-outcome");
  const pr = els.colorLegend.querySelector(".legend-pr");
  if (outcome) outcome.hidden = mode !== "outcome";
  if (pr) pr.hidden = mode !== "pull_request";
}

els.colorMode.addEventListener("change", () => {
  plot.setOptions({ colorMode: els.colorMode.value });
  syncColorLegend();
});
syncColorLegend();
function syncAxesHud() {
  const on = !els.showAxes || els.showAxes.checked;
  const hud = document.getElementById("labels-hud");
  if (hud) hud.hidden = !on;
}

els.showAxes.addEventListener("change", () => {
  const on = els.showAxes.checked;
  plot.setOptions({ showAxes: on });
  syncAxesHud();
});
syncAxesHud();
els.showTime.addEventListener("change", () => {
  plot.setOptions({ showTime: els.showTime.checked });
});
plot.setOptions({ showTime: !els.showTime || els.showTime.checked });
function syncAiLegend() {
  const legend = document.querySelector(".ai-legend");
  if (legend) legend.hidden = !(els.showAi && els.showAi.checked);
}

els.showAi.addEventListener("change", () => {
  plot.setOptions({ showAiMarks: els.showAi.checked });
  syncAiLegend();
});
syncAiLegend();
plot.setOptions({ showAiMarks: !!(els.showAi && els.showAi.checked) });
els.autoRotate.addEventListener("change", () => {
  plot.setOptions({ autoRotate: els.autoRotate.checked });
});
plot.setOptions({ autoRotate: !els.autoRotate || els.autoRotate.checked });
els.hideEnded.addEventListener("change", () => {
  syncFreqFilter();
  plot.setOptions({ hideEnded: els.hideEnded.checked, minFreq: currentMinFreq() });
  renderMetrics();
});
els.entityType.addEventListener("change", () => {
  plot.setOptions({ entityType: currentEntityType() });
  syncViewTitle();
  renderMetrics();
});
els.aiFilter.addEventListener("change", () => {
  plot.setOptions({ aiFilter: currentAiFilter() });
  renderMetrics();
});
els.viewMode.addEventListener("change", () => {
  syncLandscapeControls();
  plot.setOptions({ viewMode: currentViewMode(), landscapeShow: currentLandscapeShow() });
  renderMetrics();
  setStatus(
    currentViewMode() === "ai_landscape"
      ? "Deforming landscapes · dots drop and push valleys deeper · Start replays"
      : "PR traces view"
  );
});
els.landscapeShow.addEventListener("change", () => {
  plot.setOptions({ landscapeShow: currentLandscapeShow() });
  syncLandscapeControls();
});
syncLandscapeControls();
els.minFreq.addEventListener("input", () => {
  syncFreqFilter();
  plot.setOptions({ minFreq: currentMinFreq() });
  renderMetrics();
});
syncFreqFilter();
els.detailClose.addEventListener("click", () => {
  plot.clearSelection();
});

for (const el of [els.githubPr, els.entityCol, els.patternCol, els.direction, els.distanceMode]) {
  el.addEventListener("change", () => {
    if (state.data) embedNow();
  });
}

setInterval(renderMetrics, 250);
renderMetrics();
