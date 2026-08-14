const TIME_UNITS = {
  day: { label: "daily" },
  week: { label: "weekly" },
  month: { label: "monthly" },
  year: { label: "yearly" },
};

const TERMINAL_EVENTS = new Set(["closed", "merged", "head_ref_deleted"]);

const TIME_NAME_HINTS = [
  "event_timestamp", "timestamp", "created_at", "datetime", "date", "time",
];
const ENTITY_NAME_HINTS = [
  "pr_number", "issue_number", "thread_id", "conversation_id", "entity_id", "id", "seq_id",
];
const PATTERN_NAME_HINTS = [
  "event", "events", "action", "type", "username", "user", "actor",
];
const REPO_NAME_HINTS = [
  "repo_fullname", "repo", "repository", "repo_name", "full_name",
];
const IS_PR_HINTS = [
  "is_pull_request", "is_pr", "pull_request", "isPullRequest",
];
const AI_PARTICIPATION_HINTS = [
  "ai_agent_participation", "ai_participation", "has_ai_agent",
];
const AI_AGENT_HINTS = [
  "ai_agent", "agent", "ai_agent_name",
];
const USERNAME_HINTS = [
  "username", "user", "actor", "author", "login",
];
const USERTYPE_HINTS = [
  "usertype", "user_type", "author_type",
];
const AI_USER_PATTERNS = [
  "devin-ai",
  "devin-ai-integration",
  "cursor[bot]",
  "copilot",
  "swe-agent",
  "openhands",
  "aider",
  "claude",
  "chatgpt",
  "codex",
  "gemini-code",
  "anthropic",
];
const PR_SIGNAL_EVENTS = new Set([
  "merged",
  "review_requested",
  "reviewed",
  "review_dismissed",
  "review_request_removed",
  "ready_for_review",
  "convert_to_draft",
  "head_ref_deleted",
  "head_ref_force_pushed",
  "head_ref_restored",
  "base_ref_changed",
  "base_ref_force_pushed",
]);

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const src = String(text).replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      if (row.some((c) => c.length)) rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((c) => c.length)) rows.push(row);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((vals) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = vals[i] == null ? "" : String(vals[i]).trim();
    });
    return obj;
  });
  return { headers, records };
}

function looksLikeTime(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return true;
  const s = String(value).trim();
  if (!s) return false;
  return Number.isFinite(Date.parse(s));
}

function parseTime(value) {
  if (value instanceof Date) return value;
  const s = String(value).trim();
  if (!s) return null;
  const iso = Date.parse(s);
  return Number.isFinite(iso) ? new Date(iso) : null;
}

function columnLooksLikeTime(records, name, sample = 24) {
  const vals = records.map((r) => r[name]).filter((v) => v !== "" && v != null).slice(0, sample);
  if (!vals.length) return false;
  return vals.filter(looksLikeTime).length / vals.length >= 0.8;
}

function detectTimeColumn(headers, records) {
  for (const hint of TIME_NAME_HINTS) {
    if (headers.includes(hint) && columnLooksLikeTime(records, hint)) return hint;
  }
  return headers.find((h) => columnLooksLikeTime(records, h)) || null;
}

function detectEntityColumn(headers, githubPr = false) {
  if (githubPr && headers.includes("pr_number")) return "pr_number";
  return ENTITY_NAME_HINTS.find((h) => headers.includes(h)) || null;
}

function detectPatternColumn(headers, timeCol) {
  const nms = headers.filter((h) => h !== timeCol);
  return PATTERN_NAME_HINTS.find((h) => nms.includes(h)) || nms[0] || null;
}

function detectRepoColumn(headers) {
  return REPO_NAME_HINTS.find((h) => headers.includes(h)) || null;
}

function detectIsPrColumn(headers) {
  return IS_PR_HINTS.find((h) => headers.includes(h)) || null;
}

function detectColumn(headers, hints) {
  return hints.find((h) => headers.includes(h)) || null;
}

function looksLikeAiUsername(username, agentName) {
  const u = String(username || "").trim().toLowerCase();
  if (!u) return false;
  if (agentName) {
    const a = String(agentName).trim().toLowerCase();
    if (a && u.includes(a)) return true;
  }
  return AI_USER_PATTERNS.some((p) => u.includes(p));
}

function inferAiAppearance(rows) {
  const agentName = rows.map((r) => r.aiAgent).find((v) => v) || "";
  const flagged = rows.some((r) => r.aiParticipation === true) || Boolean(agentName);
  if (!flagged && !rows.some((r) => looksLikeAiUsername(r.username, agentName))) {
    return { aiAgent: "", aiAppearTs: null };
  }
  const hit = rows.find((r) => looksLikeAiUsername(r.username, agentName));
  if (hit) {
    return {
      aiAgent: agentName || hit.username,
      aiAppearTs: hit.ts.getTime(),
    };
  }
  // Fallback: first bot-typed event on an AI-flagged PR
  if (flagged) {
    const bot = rows.find((r) => String(r.userType || "").toLowerCase() === "bot");
    if (bot) {
      return { aiAgent: agentName || bot.username || "AI agent", aiAppearTs: bot.ts.getTime() };
    }
  }
  return { aiAgent: agentName || "", aiAppearTs: null };
}

function parseBoolish(value) {
  if (typeof value === "boolean") return value;
  const s = String(value ?? "").trim().toLowerCase();
  if (!s || s === "na" || s === "nan" || s === "null" || s === "none") return null;
  if (["1", "true", "t", "yes", "y"].includes(s)) return true;
  if (["0", "false", "f", "no", "n"].includes(s)) return false;
  return null;
}

function inferIsPullRequest(rows) {
  const flagged = rows.map((r) => r.isPullRequest).filter((v) => v != null);
  if (flagged.length) return flagged.some(Boolean);
  return rows.some((r) => PR_SIGNAL_EVENTS.has(r.event || r.pattern));
}

function looksLikeGithubPr(headers, records) {
  return headers.includes("pr_number") &&
    Boolean(headers.includes("event") || headers.includes("events")) &&
    Boolean(detectTimeColumn(headers, records));
}

function githubEventColumn(headers) {
  if (headers.includes("event")) return "event";
  if (headers.includes("events")) return "events";
  return null;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function toISODate(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function floorTime(date, unit) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const day = date.getUTCDate();
  if (unit === "year") return toISODate(new Date(Date.UTC(y, 0, 1)));
  if (unit === "month") return toISODate(new Date(Date.UTC(y, m, 1)));
  if (unit === "day") return toISODate(new Date(Date.UTC(y, m, day)));
  const utc = Date.UTC(y, m, day);
  const weekday = new Date(utc).getUTCDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  return toISODate(new Date(utc + mondayOffset * 86400000));
}

function inspectData(parsed) {
  const { headers, records } = parsed;
  const timeCol = detectTimeColumn(headers, records);
  const githubPr = looksLikeGithubPr(headers, records);
  const entityCol = detectEntityColumn(headers, githubPr);
  const patternCol = detectPatternColumn(headers, timeCol);
  const repoCol = detectRepoColumn(headers);
  const isPrCol = detectIsPrColumn(headers);
  const aiParticipationCol = detectColumn(headers, AI_PARTICIPATION_HINTS);
  const aiAgentCol = detectColumn(headers, AI_AGENT_HINTS);
  const usernameCol = detectColumn(headers, USERNAME_HINTS);
  const userTypeCol = detectColumn(headers, USERTYPE_HINTS);
  const patternChoices = headers.filter((h) => h !== timeCol);
  const repos = new Set();
  if (repoCol) {
    for (const row of records) {
      const name = String(row[repoCol] ?? "").trim();
      if (name) repos.add(name);
    }
  }
  return {
    headers,
    records,
    timeCol,
    githubPr,
    entityCol,
    patternCol,
    repoCol,
    isPrCol,
    aiParticipationCol,
    aiAgentCol,
    repos: [...repos],
    patternChoices,
    entityChoices: headers.filter((h) => h !== timeCol),
  };
}

function parseEventRows(records, headers, options) {
  const timeCol = options.timeCol || detectTimeColumn(headers, records);
  const entityCol = options.entityCol || detectEntityColumn(headers, options.githubPr);
  const patternCol = options.patternCol;
  const repoCol = options.repoCol || detectRepoColumn(headers);
  const isPrCol = options.isPrCol || detectIsPrColumn(headers);
  const aiParticipationCol = options.aiParticipationCol || detectColumn(headers, AI_PARTICIPATION_HINTS);
  const aiAgentCol = options.aiAgentCol || detectColumn(headers, AI_AGENT_HINTS);
  const usernameCol = options.usernameCol || detectColumn(headers, USERNAME_HINTS);
  const userTypeCol = options.userTypeCol || detectColumn(headers, USERTYPE_HINTS);
  if (!timeCol) throw new Error("No date/time column found in the CSV.");
  if (!patternCol) throw new Error("Choose an event / pattern column.");

  const parsed = [];
  for (const row of records) {
    const ts = parseTime(row[timeCol]);
    const pattern = String(row[patternCol] ?? "").trim();
    if (!ts || !pattern) continue;
    const entity = entityCol && row[entityCol] !== "" && row[entityCol] != null
      ? String(row[entityCol])
      : "__all__";
    const agentRaw = aiAgentCol ? String(row[aiAgentCol] ?? "").trim() : "";
    const agent = !agentRaw || ["na", "nan", "null", "none", "false", "0"].includes(agentRaw.toLowerCase())
      ? ""
      : agentRaw;
    parsed.push({
      ts,
      entity,
      pattern,
      repo: repoCol ? String(row[repoCol] ?? "").trim() : "",
      event: githubEventColumn(headers) ? String(row[githubEventColumn(headers)] ?? "") : "",
      isPullRequest: isPrCol ? parseBoolish(row[isPrCol]) : null,
      aiParticipation: aiParticipationCol ? parseBoolish(row[aiParticipationCol]) : null,
      aiAgent: agent,
      username: usernameCol ? String(row[usernameCol] ?? "").trim() : "",
      userType: userTypeCol ? String(row[userTypeCol] ?? "").trim() : "",
    });
  }
  if (!parsed.length) {
    throw new Error("No valid rows after parsing timestamps and event values.");
  }
  parsed.sort((a, b) => a.entity.localeCompare(b.entity) || a.ts - b.ts);

  const byEntity = new Map();
  for (const row of parsed) {
    if (!byEntity.has(row.entity)) byEntity.set(row.entity, []);
    byEntity.get(row.entity).push(row);
  }

  if (options.githubPr) {
    const eventCol = githubEventColumn(headers);
    if (!eventCol) {
      throw new Error("GitHub PR mode needs an event column to truncate at closed / merged / head_ref_deleted.");
    }
    for (const [entity, rows] of byEntity) {
      const terminalTs = rows.filter((r) => TERMINAL_EVENTS.has(r.event)).map((r) => r.ts.getTime());
      const end = terminalTs.length
        ? Math.max(...terminalTs)
        : Math.max(...rows.map((r) => r.ts.getTime()));
      byEntity.set(entity, rows.filter((r) => r.ts.getTime() <= end));
    }
  }

  return { parsed, byEntity, timeCol, entityCol, patternCol, repoCol, isPrCol };
}

function prOutcome(rows) {
  const events = rows.map((r) => r.event || r.pattern);
  if (events.includes("merged")) return "merged";
  if (events.includes("closed")) return "closed";
  if (events.includes("head_ref_deleted")) return "deleted";
  return "open";
}

function countEventsAndTransitions(rows, directed) {
  const eventCounts = new Map();
  const transCounts = new Map();
  for (const row of rows) {
    eventCounts.set(row.pattern, (eventCounts.get(row.pattern) || 0) + 1);
  }
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i].pattern;
    const b = rows[i + 1].pattern;
    if (a === b) continue;
    const key = edgeKey(a, b, directed);
    transCounts.set(key, (transCounts.get(key) || 0) + 1);
  }
  return { eventCounts, transCounts };
}

function aggregateProcessNodes(items, events, transitions, distanceMode) {
  const byKey = new Map();
  for (const item of items) {
    if (!item.sequence.length) continue;
    const key = item.sequence.join(" → ");
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        sequence: item.sequence.slice(),
        eventCounts: new Map(item.eventCounts),
        transCounts: new Map(item.transCounts),
        freq: 0,
        ids: [],
      });
    }
    const node = byKey.get(key);
    node.freq += 1;
    node.ids.push(item.id);
  }
  const nodes = [...byKey.values()];
  if (!nodes.length) {
    return { nodes: [], maxFreq: 1 };
  }
  for (const node of nodes) {
    node.profile = [
      ...events.map((e) => node.eventCounts.get(e) || 0),
      ...transitions.map((e) => node.transCounts.get(e) || 0),
    ];
  }
  let coords;
  if (nodes.length === 1) {
    coords = [[0, 0]];
  } else if (nodes.length <= 280) {
    const distances = pairwiseProcessDistances(
      nodes.map((n) => ({ sequence: n.sequence, profile: n.profile })),
      distanceMode
    );
    coords = classicalMds(distances);
  } else {
    coords = embedProfiles2D(nodes.map((n) => n.profile));
  }
  const maxFreq = nodes.reduce((m, n) => Math.max(m, n.freq), 1);
  const nodeByKey = new Map(nodes.map((node, i) => [node.key, {
    key: node.key,
    sequence: node.sequence.join(" → "),
    freq: node.freq,
    ids: node.ids,
    x: coords[i][0] || 0,
    y: coords[i][1] || 0,
  }]));
  const points = [];
  for (const item of items) {
    if (!item.sequence.length) continue;
    const key = item.sequence.join(" → ");
    const node = nodeByKey.get(key);
    if (!node) continue;
    points.push({
      id: item.id,
      repo: item.repo || "",
      outcome: item.outcome || "open",
      isPullRequest: item.isPullRequest !== false,
      startTs: item.startTs,
      endTs: item.endTs,
      aiAgent: item.aiAgent || "",
      aiAppearTs: item.aiAppearTs,
      processKey: key,
      sequence: node.sequence,
      freq: node.freq,
      x: node.x,
      y: node.y,
    });
  }
  return {
    nodes: [...nodeByKey.values()],
    points,
    maxFreq,
  };
}

function countsFromSequence(seq, directed) {
  const eventCounts = new Map();
  const transCounts = new Map();
  for (const step of seq) {
    eventCounts.set(step, (eventCounts.get(step) || 0) + 1);
  }
  for (let i = 0; i < seq.length - 1; i++) {
    const a = seq[i];
    const b = seq[i + 1];
    if (a === b) continue;
    const key = edgeKey(a, b, directed);
    transCounts.set(key, (transCounts.get(key) || 0) + 1);
  }
  return { eventCounts, transCounts };
}

function vocabFromItems(items, directed) {
  const eventSet = new Set();
  const transSet = new Set();
  for (const item of items) {
    const seq = item.sequence || [];
    for (const step of seq) eventSet.add(step);
    for (let i = 0; i < seq.length - 1; i++) {
      if (seq[i] === seq[i + 1]) continue;
      transSet.add(edgeKey(seq[i], seq[i + 1], directed));
    }
  }
  return {
    events: [...eventSet].sort(),
    transitions: [...transSet].sort(),
  };
}

function buildAiLandscapes(usedPrs, _events, _transitions, distanceMode, directed = true) {
  const beforeItems = [];
  const afterItems = [];
  for (const pr of usedPrs) {
    if (pr.aiAppearTs == null) continue;
    const beforeSeq = pr.beforeSequence || pr.beforeSteps || [];
    const afterSeq = pr.afterSequence || pr.afterSteps || [];
    const beforeCounts = pr.beforeEventCounts
      ? { eventCounts: pr.beforeEventCounts, transCounts: pr.beforeTransCounts || new Map() }
      : countsFromSequence(beforeSeq, directed);
    const afterCounts = pr.afterEventCounts
      ? { eventCounts: pr.afterEventCounts, transCounts: pr.afterTransCounts || new Map() }
      : countsFromSequence(afterSeq, directed);
    beforeItems.push({
      id: pr.id,
      repo: pr.repo,
      outcome: pr.outcome,
      isPullRequest: pr.isPullRequest,
      startTs: pr.startTs,
      endTs: pr.endTs,
      aiAgent: pr.aiAgent,
      aiAppearTs: pr.aiAppearTs,
      sequence: beforeSeq,
      eventCounts: beforeCounts.eventCounts,
      transCounts: beforeCounts.transCounts,
    });
    afterItems.push({
      id: pr.id,
      repo: pr.repo,
      outcome: pr.outcome,
      isPullRequest: pr.isPullRequest,
      startTs: pr.startTs,
      endTs: pr.endTs,
      aiAgent: pr.aiAgent,
      aiAppearTs: pr.aiAppearTs,
      sequence: afterSeq,
      eventCounts: afterCounts.eventCounts,
      transCounts: afterCounts.transCounts,
    });
  }
  const beforeVocab = vocabFromItems(beforeItems, directed);
  const afterVocab = vocabFromItems(afterItems, directed);
  const before = aggregateProcessNodes(beforeItems, beforeVocab.events, beforeVocab.transitions, distanceMode);
  const after = aggregateProcessNodes(afterItems, afterVocab.events, afterVocab.transitions, distanceMode);
  return {
    before,
    after,
    nAiSplit: beforeItems.length,
  };
}

function filterTracesForLandscape(traces, entityType = "both") {
  return (traces || []).filter((t) => {
    if (t.aiAppearTs == null) return false;
    if (entityType === "pull_request" && !t.isPullRequest) return false;
    if (entityType === "issue" && t.isPullRequest) return false;
    return true;
  });
}

function buildAiLandscapesForTraces(traces, options = {}) {
  const directed = options.directed !== false;
  const distanceMode = options.distanceMode || "both";
  const entityType = options.entityType || "both";
  const filtered = filterTracesForLandscape(traces, entityType).map((t) => ({
    id: t.id,
    repo: t.repo,
    outcome: t.outcome,
    isPullRequest: t.isPullRequest,
    startTs: t.startTs,
    endTs: t.endTs,
    aiAgent: t.aiAgent,
    aiAppearTs: t.aiAppearTs,
    beforeSequence: t.beforeSteps || [],
    afterSequence: t.afterSteps || [],
  }));
  return buildAiLandscapes(filtered, null, null, distanceMode, directed);
}

function edgeKey(a, b, directed) {
  if (directed) return `${a}->${b}`;
  return [a, b].sort().join("--");
}

function collapseRuns(seq) {
  const out = [];
  for (const step of seq) {
    if (!out.length || out[out.length - 1] !== step) out.push(step);
  }
  return out;
}

function levenshteinNorm(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return 0;
  if (!n || !m) return 1;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const curr = new Array(m + 1);
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[m] / Math.max(n, m);
}

function cosineDistance(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 && nb === 0) return 0;
  if (na === 0 || nb === 0) return 1;
  const sim = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return 1 - Math.max(-1, Math.min(1, sim));
}

function euclid2(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function processDistance(prA, prB, mode) {
  const lev = levenshteinNorm(prA.sequence, prB.sequence);
  const cos = cosineDistance(prA.profile, prB.profile);
  if (mode === "sequence") return lev;
  if (mode === "transition") return cos;
  return 0.7 * lev + 0.3 * cos;
}

function pairwiseProcessDistances(prs, mode) {
  const n = prs.length;
  const D = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = processDistance(prs[i], prs[j], mode);
      D[i][j] = D[j][i] = d;
    }
  }
  return D;
}

function matVec(A, v) {
  const n = A.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const row = A[i];
    for (let j = 0; j < n; j++) s += row[j] * v[j];
    out[i] = s;
  }
  return out;
}

function vecNorm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s) || 1;
}

function vecDot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function powerEigen(A, exclude, iters = 36) {
  const n = A.length;
  let v = Array.from({ length: n }, () => Math.random() - 0.5);
  const project = (x) => {
    if (!exclude) return x;
    const d = vecDot(x, exclude);
    return x.map((val, i) => val - d * exclude[i]);
  };
  v = project(v);
  let inv = 1 / vecNorm(v);
  v = v.map((val) => val * inv);
  let lambda = 0;
  for (let k = 0; k < iters; k++) {
    let w = project(matVec(A, v));
    lambda = vecDot(v, w);
    inv = 1 / vecNorm(w);
    v = w.map((val) => val * inv);
  }
  return { value: lambda, vector: v };
}

function classicalMds(D) {
  const n = D.length;
  const D2 = D.map((row) => row.map((d) => d * d));
  const rowMean = D2.map((row) => row.reduce((s, v) => s + v, 0) / n);
  let grand = 0;
  for (let i = 0; i < n; i++) grand += rowMean[i];
  grand /= n;
  const B = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => -0.5 * (D2[i][j] - rowMean[i] - rowMean[j] + grand))
  );
  const e1 = powerEigen(B, null);
  const e2 = powerEigen(B, e1.vector);
  const s1 = Math.sqrt(Math.max(e1.value, 0));
  const s2 = Math.sqrt(Math.max(e2.value, 0));
  return Array.from({ length: n }, (_, i) => [
    e1.vector[i] * s1,
    e2.vector[i] * s2,
  ]);
}

function embedProfiles2D(matrix) {
  const normalized = l2RowNormalize(matrix);
  const centered = columnCenter(normalized);
  const n = centered.length;
  const p = centered[0].length;
  if (n <= p) {
    const gram = multiply(centered, transpose(centered));
    const e1 = powerEigen(gram, null);
    const e2 = powerEigen(gram, e1.vector);
    const s1 = Math.sqrt(Math.max(e1.value, 0));
    const s2 = Math.sqrt(Math.max(e2.value, 0));
    return centered.map((_, i) => [e1.vector[i] * s1, e2.vector[i] * s2]);
  }
  const gram = multiply(transpose(centered), centered);
  const e1 = powerEigen(gram, null);
  const e2 = powerEigen(gram, e1.vector);
  return centered.map((row) => [vecDot(row, e1.vector), vecDot(row, e2.vector)]);
}

function mdsStress(coords, D) {
  let num = 0;
  let den = 0;
  let nPairs = 0;
  let absErr = 0;
  for (let i = 0; i < D.length; i++) {
    for (let j = i + 1; j < D.length; j++) {
      const delta = euclid2(coords[i], coords[j]);
      const err = D[i][j] - delta;
      num += err * err;
      den += D[i][j] * D[i][j];
      absErr += Math.abs(err);
      nPairs += 1;
    }
  }
  return {
    stress: den > 0 ? Math.sqrt(num / den) : 0,
    meanAbsError: nPairs ? absErr / nPairs : 0,
  };
}

function buildPrEmbedding(records, headers, options) {
  const directed = options.directed !== false;
  const distanceMode = options.distanceMode || "both";
  const { byEntity, entityCol, patternCol } = parseEventRows(records, headers, options);
  if (byEntity.size < 2) {
    throw new Error("Need at least two sequences (e.g. pull requests) to embed in 2D.");
  }

  const eventSet = new Set();
  const transSet = new Set();
  const prs = [];
  let nTransitions = 0;

  for (const [id, rows] of byEntity) {
    if (!rows.length) continue;
    const eventCounts = new Map();
    const transCounts = new Map();
    const rawSeq = rows.map((row) => row.pattern);
    for (const row of rows) {
      eventSet.add(row.pattern);
      eventCounts.set(row.pattern, (eventCounts.get(row.pattern) || 0) + 1);
    }
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i].pattern;
      const b = rows[i + 1].pattern;
      if (a === b) continue;
      const key = edgeKey(a, b, directed);
      transSet.add(key);
      transCounts.set(key, (transCounts.get(key) || 0) + 1);
      nTransitions += 1;
    }
    const startTs = rows[0].ts.getTime();
    const terminal = rows.filter((r) => TERMINAL_EVENTS.has(r.event || r.pattern));
    const endTs = terminal.length
      ? Math.max(...terminal.map((r) => r.ts.getTime()))
      : rows[rows.length - 1].ts.getTime();
    const repo = rows.find((r) => r.repo)?.repo || "";
    const ai = inferAiAppearance(rows);
    let beforeSequence = [];
    let afterSequence = [];
    let beforeCounts = { eventCounts: new Map(), transCounts: new Map() };
    let afterCounts = { eventCounts: new Map(), transCounts: new Map() };
    if (ai.aiAppearTs != null) {
      const beforeRows = rows.filter((r) => r.ts.getTime() < ai.aiAppearTs);
      const afterRows = rows.filter((r) => r.ts.getTime() >= ai.aiAppearTs);
      beforeSequence = collapseRuns(beforeRows.map((r) => r.pattern)).slice(0, 80);
      afterSequence = collapseRuns(afterRows.map((r) => r.pattern)).slice(0, 80);
      beforeCounts = countEventsAndTransitions(beforeRows, directed);
      afterCounts = countEventsAndTransitions(afterRows, directed);
    }
    prs.push({
      id,
      repo,
      startTs,
      endTs,
      nEvents: rows.length,
      outcome: prOutcome(rows),
      isPullRequest: inferIsPullRequest(rows),
      aiAgent: ai.aiAgent,
      aiAppearTs: ai.aiAppearTs,
      eventCounts,
      transCounts,
      sequence: collapseRuns(rawSeq).slice(0, 80),
      beforeSequence,
      afterSequence,
      beforeEventCounts: beforeCounts.eventCounts,
      beforeTransCounts: beforeCounts.transCounts,
      afterEventCounts: afterCounts.eventCounts,
      afterTransCounts: afterCounts.transCounts,
    });
  }

  if (prs.length < 2) throw new Error("Need at least two sequences after filtering.");
  const usedPrs = prs;

  const events = [...eventSet].sort();
  const transitions = [...transSet].sort();
  const featureNames = [
    ...events.map((e) => `event:${e}`),
    ...transitions.map((e) => `trans:${e}`),
  ];
  for (const pr of usedPrs) {
    pr.profile = [
      ...events.map((e) => pr.eventCounts.get(e) || 0),
      ...transitions.map((e) => pr.transCounts.get(e) || 0),
    ];
  }
  const featureSum = usedPrs.reduce((s, pr) => s + pr.profile.reduce((a, b) => a + b, 0), 0);
  if (featureSum === 0) {
    throw new Error("Sequences have no event counts to embed.");
  }

  const matrix = usedPrs.map((pr) => pr.profile);
  let coords;
  let quality;
  if (usedPrs.length <= 280) {
    const distances = pairwiseProcessDistances(usedPrs, distanceMode);
    coords = classicalMds(distances);
    quality = mdsStress(coords, distances);
  } else {
    coords = embedProfiles2D(matrix);
    quality = { stress: 0, meanAbsError: 0 };
  }

  const traces = usedPrs.map((pr, i) => ({
    id: pr.id,
    repo: pr.repo,
    x: coords[i][0] || 0,
    y: coords[i][1] || 0,
    startTs: pr.startTs,
    endTs: Math.max(pr.endTs, pr.startTs),
    nEvents: pr.nEvents,
    outcome: pr.outcome,
    isPullRequest: pr.isPullRequest,
    aiAgent: pr.aiAgent || "",
    aiAppearTs: pr.aiAppearTs,
    beforeSteps: (pr.beforeSequence || []).slice(),
    afterSteps: (pr.afterSequence || []).slice(),
    sequence: pr.sequence.join(" → "),
    steps: pr.sequence.slice(),
    processKey: pr.sequence.join(" → "),
  }));
  const freqBySeq = new Map();
  for (const t of traces) {
    freqBySeq.set(t.processKey, (freqBySeq.get(t.processKey) || 0) + 1);
  }
  for (const t of traces) {
    t.freq = freqBySeq.get(t.processKey) || 1;
  }
  const maxFreq = traces.reduce((m, t) => Math.max(m, t.freq), 1);
  const nRecurrentProcesses = [...freqBySeq.values()].filter((f) => f >= 2).length;
  const nRecurrentPrs = traces.filter((t) => t.freq >= 2).length;
  const nAiPrs = traces.filter((t) => t.aiAppearTs != null).length;
  const landscapes = buildAiLandscapes(usedPrs, events, transitions, distanceMode, directed);

  const tMin = Math.min(...traces.map((t) => t.startTs));
  const tMax = Math.max(...traces.map((t) => t.endTs));

  return {
    traces,
    landscapes,
    featureNames,
    directed,
    distanceMode,
    patternCol,
    entityCol,
    nRows: records.length,
    nPrs: traces.length,
    nPrsTotal: traces.length,
    sampled: false,
    repos: [...new Set(traces.map((t) => t.repo).filter(Boolean))],
    nEvents: events.length,
    nTransitions,
    tMin,
    tMax,
    maxFreq,
    nRecurrentProcesses,
    nRecurrentPrs,
    nAiPrs,
    stress: quality.stress,
    meanAbsError: quality.meanAbsError,
    embedding: {
      k: 2,
      kept: 1 - quality.stress,
      explained: [1 - quality.stress, quality.stress],
    },
  };
}

function l2RowNormalize(matrix) {
  return matrix.map((row) => {
    let n = 0;
    for (const v of row) n += v * v;
    n = Math.sqrt(n);
    if (n === 0) return row.map(() => 0);
    return row.map((v) => v / n);
  });
}

function columnCenter(matrix) {
  const n = matrix.length;
  const p = matrix[0].length;
  const means = Array(p).fill(0);
  for (const row of matrix) {
    for (let j = 0; j < p; j++) means[j] += row[j];
  }
  for (let j = 0; j < p; j++) means[j] /= n;
  return matrix.map((row) => row.map((v, j) => v - means[j]));
}

function transpose(M) {
  const n = M.length;
  const p = M[0].length;
  const T = Array.from({ length: p }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) T[j][i] = M[i][j];
  }
  return T;
}

function multiply(A, B) {
  const n = A.length;
  const k = A[0].length;
  const p = B[0].length;
  const out = Array.from({ length: n }, () => Array(p).fill(0));
  for (let i = 0; i < n; i++) {
    for (let t = 0; t < k; t++) {
      const a = A[i][t];
      if (a === 0) continue;
      for (let j = 0; j < p; j++) out[i][j] += a * B[t][j];
    }
  }
  return out;
}

function jacobiEigen(A, maxSweeps = 80) {
  const n = A.length;
  const M = A.map((row) => row.slice());
  const V = Array.from({ length: n }, (_, i) => {
    const row = Array(n).fill(0);
    row[i] = 1;
    return row;
  });
  const eps = 1e-12;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) off += M[i][j] * M[i][j];
    }
    if (Math.sqrt(off) < eps) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = M[p][q];
        if (Math.abs(apq) < eps) continue;
        const app = M[p][p];
        const aqq = M[q][q];
        const tau = (aqq - app) / (2 * apq);
        const t = tau === 0 ? 1 : Math.sign(tau) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;
        M[p][p] = app - t * apq;
        M[q][q] = aqq + t * apq;
        M[p][q] = 0;
        M[q][p] = 0;
        for (let k = 0; k < n; k++) {
          if (k === p || k === q) continue;
          const akp = M[k][p];
          const akq = M[k][q];
          M[k][p] = M[p][k] = c * akp - s * akq;
          M[k][q] = M[q][k] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p];
          const vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const values = Array.from({ length: n }, (_, i) => M[i][i]);
  const order = values.map((v, i) => i).sort((a, b) => values[b] - values[a]);
  return {
    values: order.map((i) => Math.max(0, values[i])),
    vectors: order.map((j) => V.map((row) => row[j])),
  };
}

function embedMatrix(matrix, varianceThreshold = 0.9) {
  if (varianceThreshold <= 0 || varianceThreshold > 1) {
    throw new Error("PCA variance must be between 0 and 100%.");
  }
  if (!matrix.length || !matrix[0].length) {
    throw new Error("Event feature matrix is empty.");
  }
  const normalized = l2RowNormalize(matrix);
  const centered = columnCenter(normalized);
  const n = centered.length;
  const p = centered[0].length;
  let embeddings;
  let eigenvalues;

  if (n <= p) {
    const gram = multiply(centered, transpose(centered));
    const eig = jacobiEigen(gram);
    eigenvalues = eig.values;
    const total = eigenvalues.reduce((s, v) => s + v, 0) || 1;
    let cum = 0;
    let k = eigenvalues.length;
    for (let i = 0; i < eigenvalues.length; i++) {
      cum += eigenvalues[i] / total;
      if (cum >= varianceThreshold) {
        k = i + 1;
        break;
      }
    }
    k = Math.max(2, Math.max(1, k));
    k = Math.min(k, eigenvalues.length);
    embeddings = centered.map((_, i) =>
      eig.vectors.slice(0, k).map((vec, j) => vec[i] * Math.sqrt(eigenvalues[j]))
    );
    const explained = eigenvalues.map((v) => v / total);
    const kept = explained.slice(0, k).reduce((s, v) => s + v, 0);
    return { embeddings, k, kept, explained, nFeatures: p, nRows: n };
  }

  const gram = multiply(transpose(centered), centered);
  const eig = jacobiEigen(gram);
  eigenvalues = eig.values;
  const total = eigenvalues.reduce((s, v) => s + v, 0) || 1;
  let cum = 0;
  let k = eigenvalues.length;
  for (let i = 0; i < eigenvalues.length; i++) {
    cum += eigenvalues[i] / total;
    if (cum >= varianceThreshold) {
      k = i + 1;
      break;
    }
  }
  k = Math.max(2, Math.max(1, k));
  k = Math.min(k, eigenvalues.length);
  const Vk = transpose(eig.vectors.slice(0, k));
  embeddings = multiply(centered, Vk);
  const explained = eigenvalues.map((v) => v / total);
  const kept = explained.slice(0, k).reduce((s, v) => s + v, 0);
  return { embeddings, k, kept, explained, nFeatures: p, nRows: n };
}

export {
  TIME_UNITS,
  parseCSV,
  inspectData,
  buildPrEmbedding,
  buildAiLandscapesForTraces,
};
