// @ts-check
/* Poker Ledger — client for /api/poker. Plain ES module, no build step. */

/**
 * @typedef {Object} AuthStatus
 * @property {boolean} group
 * @property {boolean} admin
 * @property {{id: string, name: string}|null} viewer
 * @property {number} authVersion
 */

/**
 * @typedef {Object} Member
 * @property {string} id
 * @property {string} name
 */

/**
 * @typedef {Object} Participant
 * @property {string} memberId
 * @property {string} name
 * @property {number} amountCents
 */

/**
 * @typedef {Object} SessionSummary
 * @property {string} id
 * @property {string} playedAt
 * @property {string|null} title
 * @property {string} status
 * @property {number} version
 * @property {{id: string, name: string}|null} recordedBy
 * @property {Participant[]} participants
 */

/**
 * @typedef {SessionSummary & {notes: string|null, totalCents: number}} SessionDetail
 */

/**
 * @typedef {Object} LedgerRow
 * @property {string} memberId
 * @property {string} name
 * @property {number} netCents
 * @property {number} sessionsPlayed
 * @property {string|null} lastPlayedAt
 * @property {boolean} isViewer
 */

/**
 * @typedef {Object} LedgerData
 * @property {number} totalCents
 * @property {LedgerRow[]} rows
 */

/**
 * @typedef {Object} JoinRequest
 * @property {string} id
 * @property {string} displayName
 * @property {string} email
 * @property {string|null} note
 * @property {string} status
 * @property {string} requestedAt
 */

/**
 * @typedef {Object} DisputeSession
 * @property {string} id
 * @property {string} playedAt
 * @property {string|null} title
 * @property {string} status
 * @property {number} version
 */

/**
 * @typedef {Object} DisputeInfo
 * @property {string} id
 * @property {string} sessionId
 * @property {string} memberId
 * @property {string} memberName
 * @property {string} reason
 * @property {string} status
 * @property {string|null} resolutionNote
 * @property {string} createdAt
 * @property {DisputeSession} session
 */

/**
 * @typedef {Object} ApiError
 * @property {number} status
 * @property {string} code
 * @property {string} message
 * @property {Record<string, string[]>|undefined} fieldErrors
 */

/* ── Constants ─────────────────────────────────────────────── */

const MAX_AMOUNT_CENTS = 100_000_000; // $1,000,000 — mirrors server/domain/money.ts
const CENTS_RE = /^([+-]?)(\d*)(?:\.(\d{1,2}))?$/; // mirrors server
const SESSION_PAGE_LIMIT = 8;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

/* ── State ─────────────────────────────────────────────────── */

/**
 * @type {{
 *   status: AuthStatus|null,
 *   members: Member[],
 *   ledger: LedgerData|null,
 *   sessions: SessionSummary[],
 *   nextCursor: string|null,
 *   token: string|null,
 *   adminRequests: JoinRequest[]|null,
 *   adminDisputes: DisputeInfo[]|null,
 *   createdSessionId: string|null,
 *   pendingDeliveryShortfall: number|null,
 *   live: any|null,
 * }}
 */
const state = {
  status: null,
  members: [],
  ledger: null,
  sessions: [],
  nextCursor: null,
  token: null,
  adminRequests: null,
  adminDisputes: null,
  createdSessionId: null,
  pendingDeliveryShortfall: null,
  live: null,
};

/* ── DOM helpers ───────────────────────────────────────────── */

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node;
}

/**
 * @param {string} id
 * @returns {HTMLInputElement}
 */
function field(id) {
  return /** @type {HTMLInputElement} */ (el(id));
}

/**
 * @param {HTMLElement} root
 * @param {string} selector
 * @returns {HTMLElement}
 */
function q(root, selector) {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`Missing element ${selector}`);
  return /** @type {HTMLElement} */ (node);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ── Money (mirrors server/domain/money.ts) ────────────────── */

/**
 * Parse a user-entered dollar string into cents. Returns null when invalid.
 * @param {string} input
 * @returns {number|null}
 */
function parseDollarsToCents(input) {
  const cleaned = String(input).replace(/,/g, "").trim();
  const m = CENTS_RE.exec(cleaned);
  if (!m || (m[2] === "" && m[3] === undefined)) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const dollars = m[2] === "" ? 0 : Number(m[2]);
  const frac = m[3] ?? "";
  const cents = sign * (dollars * 100 + Number(frac.padEnd(2, "0")));
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_AMOUNT_CENTS) return null;
  return cents;
}

/**
 * Format cents as "$1,234.56" / "+$12.50" / "-$12.50" / "$0.00". Mirrors server.
 * @param {number} cents
 * @returns {string}
 */
function formatCents(cents) {
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  const grouped = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = cents < 0 ? "-" : cents > 0 ? "+" : "";
  return `${sign}$${grouped}.${frac}`;
}

/**
 * Signed dollar value for prefilling an amount input ("+100.00" / "-40.00").
 * @param {number} cents
 * @returns {string}
 */
function toDollarsInput(cents) {
  const abs = Math.abs(cents);
  const sign = cents < 0 ? "-" : "+";
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * @param {number} cents
 * @returns {string}
 */
function moneyClass(cents) {
  return cents > 0 ? "pos" : cents < 0 ? "neg" : "";
}

/* ── Dates ─────────────────────────────────────────────────── */

/**
 * @param {Date} date
 * @returns {string}
 */
function toLocalInputValue(date) {
  /** @param {number} n @returns {string} */
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * @param {string} value
 * @returns {string|null} ISO string or null when invalid
 */
function localInputToISO(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * @param {string|null|undefined} iso
 * @returns {string}
 */
function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Compact month/day label used by the recent sessions list. */
function formatRecentDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * @param {string|null|undefined} iso
 * @returns {string}
 */
function formatDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/**
 * @param {string} status
 * @returns {string}
 */
function statusLabel(status) {
  switch (status) {
    case "live": return "Live";
    case "disputed": return "Included pending review";
    case "resolved": return "Resolved";
    case "voided": return "Voided";
    default: return "Included";
  }
}

/**
 * @param {string} status
 * @returns {string}
 */
function disputeStatusLabel(status) {
  if (status === "resolved") return "Resolved";
  if (status === "dismissed") return "Dismissed";
  return "Open";
}

/* ── API ───────────────────────────────────────────────────── */

/**
 * @param {string} path
 * @param {{method?: string, body?: unknown}} [opts]
 * @returns {Promise<any>}
 */
async function api(path, opts = {}) {
  const method = opts.method ?? "GET";
  /** @type {RequestInit} */
  const init = { method, credentials: "same-origin" };
  if (opts.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  /** @type {Response} */
  let res;
  try {
    res = await fetch("/api/poker" + path, init);
  } catch {
    throw /** @type {ApiError} */ ({
      status: 0,
      code: "network",
      message: "Can't reach the server. Check your connection and try again.",
    });
  }
  /** @type {any} */
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    const err = data?.error ?? {};
    throw /** @type {ApiError} */ ({
      status: res.status,
      code: typeof err.code === "string" ? err.code : "unknown",
      message: typeof err.message === "string" ? err.message : `Request failed (${res.status}).`,
      fieldErrors: err.fieldErrors,
    });
  }
  return data;
}

/**
 * @param {ApiError} err
 * @param {string} fallback
 * @returns {string}
 */
function friendlyMessage(err, fallback) {
  if (err.code === "network") return err.message;
  if (err.code === "rate_limited") return "Too many attempts — please wait a moment and try again.";
  if (err.status === 404 && err.code === "not_found") {
    return "The poker server isn't ready yet — it may still be starting up. Try again in a moment.";
  }
  if (err.status === 405 && err.code === "method_not_allowed") {
    return "The poker server isn't ready yet — it may still be starting up. Try again in a moment.";
  }
  return err.message || fallback;
}

/* ── Banners ───────────────────────────────────────────────── */

/**
 * @param {{kind?: "error"|"info", message: string, retryLabel?: string, onRetry?: () => void}} opts
 */
function showBanner(opts) {
  const root = el("banner-root");
  const item = document.createElement("div");
  item.className = "banner" + (opts.kind === "error" ? " banner-error" : " banner-info");
  item.setAttribute("role", opts.kind === "error" ? "alert" : "status");
  const msg = document.createElement("span");
  msg.className = "banner-msg";
  msg.textContent = opts.message;
  item.appendChild(msg);
  const onRetry = opts.onRetry;
  if (onRetry) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = opts.retryLabel ?? "Try again";
    retry.addEventListener("click", () => {
      item.remove();
      onRetry();
    });
    item.appendChild(retry);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "banner-close";
  close.setAttribute("aria-label", "Dismiss message");
  close.textContent = "×";
  close.addEventListener("click", () => item.remove());
  item.appendChild(close);
  root.appendChild(item);
}

/** Remove an active banner with the exact message, if present. */
function dismissBanner(message) {
  for (const item of el("banner-root").querySelectorAll(".banner")) {
    const msg = item.querySelector(".banner-msg");
    if (msg?.textContent === message) item.remove();
  }
}

/* ── Modal ─────────────────────────────────────────────────── */

/** @type {{close: () => void}|null} */
let activeModal = null;

/**
 * @param {{title: string, body: HTMLElement, wide?: boolean}} opts
 * @returns {{close: () => void}}
 */
function openModal(opts) {
  closeModal();
  const root = el("modal-root");
  root.hidden = false;
  root.innerHTML = "";
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const dialog = document.createElement("div");
  dialog.className = "modal" + (opts.wide ? " modal-wide" : "");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", opts.title);
  const head = document.createElement("div");
  head.className = "modal-head";
  const h2 = document.createElement("h2");
  h2.textContent = opts.title;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "modal-close";
  closeBtn.setAttribute("aria-label", "Close dialog");
  closeBtn.textContent = "×";
  head.appendChild(h2);
  head.appendChild(closeBtn);
  dialog.appendChild(head);
  dialog.appendChild(opts.body);
  root.appendChild(backdrop);
  root.appendChild(dialog);

  const previousFocus = /** @type {HTMLElement|null} */ (document.activeElement);
  document.body.style.overflow = "hidden";

  const close = () => {
    if (activeModal === null && root.hidden) return;
    root.hidden = true;
    root.innerHTML = "";
    document.body.style.overflow = "";
    if (previousFocus && previousFocus.isConnected) previousFocus.focus();
    activeModal = null;
  };
  activeModal = { close };

  closeBtn.addEventListener("click", close);

  dialog.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
      return;
    }
    if (ev.key === "Tab") {
      const focusables = Array.from(
        dialog.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')
      ).filter((n) => {
        const h = /** @type {HTMLElement} */ (n);
        return !h.hasAttribute("disabled") && !h.hidden;
      });
      if (focusables.length === 0) return;
      const first = /** @type {HTMLElement} */ (focusables[0]);
      const last = /** @type {HTMLElement} */ (focusables[focusables.length - 1]);
      const active = /** @type {HTMLElement|null} */ (document.activeElement);
      if (ev.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          ev.preventDefault();
          last.focus();
        }
      } else if (active === last || !dialog.contains(active)) {
        ev.preventDefault();
        first.focus();
      }
    }
  });

  window.setTimeout(() => {
    const first = dialog.querySelector("input, select, textarea, button:not(.modal-close)");
    if (first && !first.hasAttribute("disabled")) {
      /** @type {HTMLElement} */ (first).focus();
    } else {
      closeBtn.focus();
    }
  }, 0);

  return { close };
}

function closeModal() {
  if (activeModal) {
    const m = activeModal;
    activeModal = null;
    m.close();
  }
}

/* ── Views ─────────────────────────────────────────────────── */

const VIEW_IDS = ["view-gate", "view-dashboard", "view-detail", "view-dispute"];

/**
 * @param {"gate"|"dashboard"|"detail"|"dispute"} name
 */
function showView(name) {
  for (const id of VIEW_IDS) el(id).hidden = id !== "view-" + name;
  window.scrollTo({ top: 0 });
}

/**
 * @param {HTMLElement} container
 * @param {string} message
 * @param {() => void} onRetry
 */
function renderErrorBox(container, message, onRetry) {
  container.innerHTML = "";
  const box = document.createElement("div");
  box.className = "empty-state";
  const p = document.createElement("p");
  p.textContent = message;
  box.appendChild(p);
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "btn btn-small";
  retry.textContent = "Try again";
  retry.addEventListener("click", () => {
    container.innerHTML = `<div class="spinner" aria-hidden="true"></div><p class="loading-text">Loading…</p>`;
    onRetry();
  });
  box.appendChild(retry);
  container.appendChild(box);
}

/* ── Auth ──────────────────────────────────────────────────── */

/**
 * @returns {Promise<AuthStatus>}
 */
async function refreshStatus() {
  const data = await api("/auth/status");
  state.status = {
    group: data.group === true,
    admin: data.admin === true,
    viewer: data.viewer ?? null,
    authVersion: typeof data.authVersion === "number" ? data.authVersion : 0,
  };
  return state.status;
}

function clearTokenFromUrl() {
  try {
    history.replaceState(null, "", location.pathname);
  } catch {
    /* ignore */
  }
}

function route() {
  const token = new URLSearchParams(location.search).get("token");
  state.token = token && token.length > 0 ? token : null;
  if (!state.status || !state.status.group) {
    el("topbar-controls").hidden = true;
    renderGate();
    return;
  }
  el("topbar-controls").hidden = false;
  if (state.token) {
    renderDisputeView();
  } else {
    renderDashboard();
  }
}

/* ── Gate ──────────────────────────────────────────────────── */

function renderGate() {
  showView("gate");
  el("gate-sub").textContent = state.token
    ? "Enter the group password to view your receipt and dispute it."
    : "A private ledger for our poker group. Enter the group password to continue.";
  field("gate-password").focus();
}

/**
 * @param {SubmitEvent} ev
 */
async function onGateUnlock(ev) {
  ev.preventDefault();
  const err = el("gate-error");
  err.hidden = true;
  const btn = /** @type {HTMLButtonElement} */ (el("gate-unlock"));
  const password = field("gate-password").value;
  if (!password.trim()) {
    err.textContent = "Enter the group password.";
    err.hidden = false;
    return;
  }
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Unlocking…";
  try {
    await api("/auth/login", { method: "POST", body: { password } });
    field("gate-password").value = "";
    await refreshStatus();
    route();
  } catch (e) {
    const errObj = /** @type {ApiError} */ (e);
    err.textContent = friendlyMessage(errObj, "Couldn't unlock. Check the password and try again.");
    err.hidden = false;
    field("gate-password").select();
  } finally {
    btn.disabled = false;
    btn.textContent = label ?? "Unlock";
  }
}

/**
 * @param {SubmitEvent} ev
 */
async function onRequestSubmit(ev) {
  ev.preventDefault();
  const noteEl = el("gate-request-note");
  noteEl.hidden = true;
  const btn = /** @type {HTMLButtonElement} */ (el("gate-req-submit"));
  const name = field("gate-req-name").value.trim();
  const email = field("gate-req-email").value.trim();
  const note = field("gate-req-note").value.trim();
  if (!name || !EMAIL_RE.test(email)) {
    noteEl.textContent = "Enter your name and a valid email address.";
    noteEl.hidden = false;
    return;
  }
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Sending…";
  try {
    const data = await api("/join-requests", {
      method: "POST",
      body: { displayName: name, email, note: note || undefined },
    });
    noteEl.textContent = data?.message ?? "Request received — you'll hear back soon.";
    field("gate-req-name").value = "";
    field("gate-req-email").value = "";
    field("gate-req-note").value = "";
  } catch (e) {
    const errObj = /** @type {ApiError} */ (e);
    noteEl.textContent = friendlyMessage(errObj, "Request received — you'll hear back soon.");
  } finally {
    noteEl.hidden = false;
    btn.disabled = false;
    btn.textContent = label ?? "Send request";
  }
}

/**
 * @param {SubmitEvent} ev
 */
async function onAdminUnlock(ev) {
  ev.preventDefault();
  const err = el("gate-admin-error");
  const btn = /** @type {HTMLButtonElement} */ (el("gate-admin-unlock"));
  const ok = await submitAdminPin(field("gate-admin-pin"), err, btn);
  if (ok) {
    field("gate-admin-pin").value = "";
    await refreshStatus();
    route();
  }
}

/**
 * Shared admin-unlock submit. Returns true on success.
 * @param {HTMLInputElement} pinEl
 * @param {HTMLElement} errEl
 * @param {HTMLButtonElement} btn
 * @returns {Promise<boolean>}
 */
async function submitAdminPin(pinEl, errEl, btn) {
  errEl.hidden = true;
  const pin = pinEl.value.trim();
  if (!pin) {
    errEl.textContent = "Enter the admin PIN.";
    errEl.hidden = false;
    return false;
  }
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Unlocking…";
  try {
    await api("/admin/unlock", { method: "POST", body: { password: pin } });
    return true;
  } catch (e) {
    const errObj = /** @type {ApiError} */ (e);
    if (errObj.code === "unauthorized" || errObj.status === 401) {
      errEl.textContent = "Unlock the group first with the group password, then try the admin PIN.";
    } else {
      errEl.textContent = friendlyMessage(errObj, "That admin PIN isn't right. Try again.");
    }
    errEl.hidden = false;
    return false;
  } finally {
    btn.disabled = false;
    btn.textContent = label ?? "Unlock admin";
  }
}

/**
 * @param {SubmitEvent} ev
 */
async function onDashAdminUnlock(ev) {
  ev.preventDefault();
  const err = el("dash-admin-error");
  const btn = /** @type {HTMLButtonElement} */ (el("dash-admin-unlock"));
  const ok = await submitAdminPin(field("dash-admin-pin"), err, btn);
  if (ok) {
    field("dash-admin-pin").value = "";
    await refreshStatus();
    route();
  }
}

/**
 * @param {string} triggerId
 * @param {string} formId
 */
function wireCollapsible(triggerId, formId) {
  const trigger = /** @type {HTMLButtonElement} */ (el(triggerId));
  const form = el(formId);
  trigger.addEventListener("click", () => {
    const willOpen = form.hidden;
    form.hidden = !willOpen;
    trigger.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) {
      const first = form.querySelector("input, textarea");
      if (first) /** @type {HTMLElement} */ (first).focus();
    }
  });
}

/* ── Dashboard ─────────────────────────────────────────────── */

async function renderDashboard() {
  showView("dashboard");
  if (state.status?.admin) {
    el("admin-badges").hidden = false;
    el("dash-admin-toggle").hidden = true;
    el("dash-admin-form").hidden = true;
    el("dash-admin-toggle").setAttribute("aria-expanded", "false");
    loadBadgeCounts();
  } else {
    el("admin-badges").hidden = true;
    el("dash-admin-toggle").hidden = false;
  }
  fillViewerSelect();
  el("ledger-body").innerHTML = `<div class="skel skel-row"></div><div class="skel skel-row"></div><div class="skel skel-row"></div>`;
  el("sessions-body").innerHTML = `<div class="skel skel-block"></div><div class="skel skel-block"></div>`;
  const membersOk = await loadMembers();
  if (!membersOk) {
    showBanner({
      kind: "error",
      message: "Couldn't load the member list.",
      retryLabel: "Retry",
      onRetry: renderDashboard,
    });
  }
  await Promise.allSettled([loadLedger(), loadSessions(true), loadLive()]);
  if (state.status && !state.status.viewer) {
    showBanner({
      kind: "info",
      message: "Pick your name in the top bar so the sessions you record are marked as yours.",
    });
  }
}

/**
 * @returns {Promise<boolean>}
 */
async function loadMembers() {
  try {
    const data = await api("/members");
    state.members = data.members ?? [];
    fillViewerSelect();
    return true;
  } catch {
    return false;
  }
}

function fillViewerSelect() {
  const sel = /** @type {HTMLSelectElement} */ (el("viewer-select"));
  sel.innerHTML = "";
  const viewer = state.status?.viewer ?? null;
  const activeIds = new Set(state.members.map((m) => m.id));
  const stillActive = viewer !== null && activeIds.has(viewer.id);
  if (!stillActive) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = viewer ? "(your name is no longer an active member)" : "Select your name…";
    sel.appendChild(opt);
  }
  for (const m of state.members) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name;
    sel.appendChild(opt);
  }
  sel.value = stillActive ? viewer.id : "";
}

async function loadLedger() {
  const body = el("ledger-body");
  try {
    const data = await api("/ledger");
    state.ledger = { totalCents: data.totalCents ?? 0, rows: data.rows ?? [] };
    renderLedger();
  } catch (e) {
    renderErrorBox(body, friendlyMessage(/** @type {ApiError} */ (e), "Couldn't load the ledger."), () => {
      body.innerHTML = `<div class="skel skel-row"></div><div class="skel skel-row"></div>`;
      loadLedger();
    });
  }
}

function renderLedger() {
  const body = el("ledger-body");
  const rows = state.ledger?.rows ?? [];
  const head = `<div class="ledger-head"><span>Player</span><span class="num lh-net">Net</span></div>`;
  const total = `<div class="ledger-total"><span>Total</span><span class="money">${formatCents(0)}</span></div>`;
  if (rows.length === 0) {
    body.innerHTML =
      head +
      `<p class="empty-state">No sessions yet — add the first one to start the ledger.</p>` +
      total;
    return;
  }
  const html = rows
    .map((r) => {
      const played = `${r.sessionsPlayed} ${r.sessionsPlayed === 1 ? "session" : "sessions"}`;
      const last = r.lastPlayedAt ? formatDate(r.lastPlayedAt) : "never";
      return `<div class="ledger-row">
        <div class="lr-name">${esc(r.name)}${r.isViewer ? '<span class="you-tag">you</span>' : ""}</div>
        <div class="lr-net money ${moneyClass(r.netCents)}">${esc(formatCents(r.netCents))}</div>
        <div class="lr-meta">${esc(played)} · last played ${esc(last)}</div>
      </div>`;
    })
    .join("");
  body.innerHTML = head + html + total;
}

/**
 * @param {boolean} reset
 * @returns {Promise<void>}
 */
async function loadSessions(reset) {
  const body = el("sessions-body");
  try {
    let path = "/sessions?limit=" + SESSION_PAGE_LIMIT;
    if (!reset && state.nextCursor) path += "&cursor=" + encodeURIComponent(state.nextCursor);
    const data = await api(path);
    const incoming = data.sessions ?? [];
    state.sessions = reset ? incoming : state.sessions.concat(incoming);
    state.nextCursor = typeof data.nextCursor === "string" && data.nextCursor ? data.nextCursor : null;
    renderSessions();
  } catch (e) {
    if (state.sessions.length > 0) return; // keep what we have
    renderErrorBox(body, friendlyMessage(/** @type {ApiError} */ (e), "Couldn't load sessions."), () => {
      loadSessions(true);
    });
  }
}

async function loadLive() {
  const banner = el("live-banner");
  try {
    const data = await api("/live");
    state.live = data?.session ? data : null;
    banner.hidden = !state.live;
    if (state.live) el("live-banner-title").textContent = state.live.session.title || "Join Live Session";
  } catch {
    state.live = null;
    banner.hidden = true;
  }
}

function moneyInputValue(cents) { return cents == null ? "" : toDollarsInput(cents); }

function openStartLiveModal() {
  const body = document.createElement("div");
  body.className = "stack";
  body.innerHTML = `<div class="form-grid"><div><label class="field" for="live-title">Session name (optional)</label><input id="live-title" class="input" maxlength="120" placeholder="Friday night game"></div><div><label class="field" for="live-notes">Notes (optional)</label><input id="live-notes" class="input" maxlength="2000"></div></div><fieldset class="part-fieldset"><legend class="field">Players and starting buy-in</legend><div id="live-start-members"></div></fieldset><p class="form-hint">You can add rebuys and update cash-outs while the session is live.</p><div class="modal-actions"><button type="button" class="btn btn-ghost" id="live-start-cancel">Cancel</button><button type="button" class="btn btn-primary" id="live-start-submit">Start live session</button></div>`;
  openModal({ title: "Start live session", body });
  const membersEl = q(body, "#live-start-members");
  const rows = [];
  for (const m of state.members) {
    const row = document.createElement("div"); row.className = "part-row";
    row.innerHTML = `<input type="checkbox" class="part-check"><span class="part-name">${esc(m.name)}</span><input type="text" class="input part-amount money" inputmode="decimal" placeholder="$0.00" hidden>`;
    const check = /** @type {HTMLInputElement} */ (q(row, ".part-check"));
    const amount = /** @type {HTMLInputElement} */ (q(row, ".part-amount"));
    check.addEventListener("change", () => { amount.hidden = !check.checked; if (check.checked) amount.focus(); });
    rows.push({ memberId: m.id, check, amount }); membersEl.appendChild(row);
  }
  q(body, "#live-start-cancel").addEventListener("click", closeModal);
  q(body, "#live-start-submit").addEventListener("click", async () => {
    const players = rows.filter((r) => r.check.checked).map((r) => ({ memberId: r.memberId, amountCents: parseDollarsToCents(r.amount.value) })).filter((r) => r.amountCents !== null);
    if (players.length < 2) return showBanner({ kind: "error", message: "Select at least two players and enter each starting buy-in." });
    const submit = /** @type {HTMLButtonElement} */ (q(body, "#live-start-submit")); submit.disabled = true;
    try { await api("/live", { method: "POST", body: { requestKey: crypto.randomUUID(), title: field("live-title").value.trim() || undefined, notes: field("live-notes").value.trim() || undefined, players } }); closeModal(); await refreshStatus(); route(); } catch (e) { showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't start the live session.") }); submit.disabled = false; }
  });
}

function openLiveModal() {
  if (!state.live) return;
  const body = document.createElement("div"); body.className = "stack live-panel";
  const live = state.live;
  body.innerHTML = `<p class="form-hint">Update a player’s cash-out when they leave. Rebuys are added to the same player.</p><div class="live-player-list"></div><div class="modal-actions"><button type="button" class="btn btn-ghost" id="live-close">Close</button><button type="button" class="btn btn-primary" id="live-end">End session</button></div>`;
  const list = q(body, ".live-player-list");
  for (const p of live.participants) {
    const row = document.createElement("div"); row.className = "live-player-row";
    row.innerHTML = `<div class="live-player-main"><strong>${esc(p.name)}</strong><span class="form-hint">Bought in ${esc(formatCents(p.buyInCents))}</span></div><div class="live-player-actions"><button type="button" class="btn btn-ghost btn-small live-rebuy">+ Rebuy</button><input class="input live-cashout" type="text" inputmode="decimal" placeholder="Cash-out" value="${esc(moneyInputValue(p.cashOutCents))}"><button type="button" class="btn btn-small live-save-cashout">Save</button></div>`;
    const cash = /** @type {HTMLInputElement} */ (q(row, ".live-cashout"));
    q(row, ".live-rebuy").addEventListener("click", async () => { const raw = prompt(`Additional buy-in for ${p.name}`, ""); const cents = raw == null ? null : parseDollarsToCents(raw); if (cents == null || cents <= 0) return; try { await api(`/live/${encodeURIComponent(live.session.id)}/buyins`, { method: "POST", body: { memberId: p.memberId, amountCents: cents } }); closeModal(); await refreshStatus(); route(); } catch (e) { showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't add the rebuy.") }); } });
    q(row, ".live-save-cashout").addEventListener("click", async () => { const cents = parseDollarsToCents(cash.value); if (cents == null || cents < 0) return; try { await api(`/live/${encodeURIComponent(live.session.id)}/cashouts`, { method: "PATCH", body: { memberId: p.memberId, amountCents: cents } }); closeModal(); await refreshStatus(); route(); } catch (e) { showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't save the cash-out.") }); } });
    list.appendChild(row);
  }
  q(body, "#live-close").addEventListener("click", closeModal);
  q(body, "#live-end").addEventListener("click", async () => { try { await api(`/live/${encodeURIComponent(live.session.id)}/end`, { method: "POST", body: {} }); closeModal(); await refreshStatus(); route(); showBanner({ kind: "info", message: "Live session ended and added to the ledger." }); } catch (e) { showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't end the live session.") }); } });
  openModal({ title: live.session.title || "Live session", body, wide: true });
}

function renderSessions() {
  const body = el("sessions-body");
  if (state.sessions.length === 0) {
    body.innerHTML = `<p class="empty-state">No sessions yet.</p>`;
    return;
  }
  body.innerHTML = "";
  const list = document.createElement("div");
  list.className = "session-list";
  for (const s of state.sessions) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "session-card";
    const playerCount = s.participants?.length ?? 0;
    card.innerHTML = `
      <span class="sess-date">${esc(formatRecentDate(s.playedAt))}</span>
      <span class="sess-summary">
        <span class="sess-player-count"><strong>${playerCount} ${playerCount === 1 ? "player" : "players"}</strong></span>
        ${s.title ? `<span class="sess-title">${esc(s.title)}</span>` : ""}
      </span>
      <span class="chip chip-${esc(s.status)}">${esc(statusLabel(s.status))}</span>
      <span class="sess-chev" aria-hidden="true">›</span>`;
    card.addEventListener("click", () => showSessionDetail(s.id));
    list.appendChild(card);
  }
  body.appendChild(list);
  if (state.nextCursor) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "btn btn-ghost btn-small";
    more.textContent = "Load more sessions";
    more.addEventListener("click", () => {
      more.disabled = true;
      loadSessions(false).finally(() => {
        more.disabled = false;
      });
    });
    body.appendChild(more);
  }
}

async function loadBadgeCounts() {
  const [r, d] = await Promise.allSettled([api("/admin/join-requests"), api("/admin/disputes")]);
  state.adminRequests = r.status === "fulfilled" ? (r.value.requests ?? []) : null;
  state.adminDisputes = d.status === "fulfilled" ? (d.value.disputes ?? []) : null;
  updateBadges();
}

function updateBadges() {
  const pending = (state.adminRequests ?? []).filter((x) => x.status === "pending").length;
  const open = (state.adminDisputes ?? []).filter((x) => x.status === "open").length;
  const pr = el("badge-requests-count");
  pr.textContent = String(pending);
  pr.classList.toggle("badge-count-warn", pending > 0);
  const dd = el("badge-disputes-count");
  dd.textContent = String(open);
  dd.classList.toggle("badge-count-warn", open > 0);
}

/* ── Add / edit session ────────────────────────────────────── */

/**
 * @param {{editing: SessionDetail|null, onSaved: (session: any) => void}} opts
 */
function openSessionModal(opts) {
  const editing = opts.editing;
  const body = document.createElement("div");
  body.className = "stack";
  body.innerHTML = `
    <div class="form-grid">
      <div>
        <label class="field" for="sf-playedAt">Date and time</label>
        <input id="sf-playedAt" class="input" type="datetime-local" required>
      </div>
      <div>
        <label class="field" for="sf-title">Title (optional)</label>
        <input id="sf-title" class="input" type="text" maxlength="120" placeholder="Friday night game">
      </div>
    </div>
    <div>
      <label class="field" for="sf-notes">Notes (optional)</label>
      <textarea id="sf-notes" class="input" rows="3" maxlength="2000"></textarea>
    </div>
    <fieldset class="part-fieldset">
      <legend class="field">Participants</legend>
      <div id="sf-members"></div>
    </fieldset>
    <p class="remainder" id="sf-remainder" aria-live="polite">Remaining to balance: $0.00</p>
    <ul class="reasons" id="sf-reasons" hidden></ul>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" id="sf-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="sf-submit" disabled>${editing ? "Save changes" : "Save session"}</button>
    </div>`;

  openModal({ title: editing ? "Edit session" : "Add session", body });
  const membersEl = q(body, "#sf-members");
  const playedAtEl = field("sf-playedAt");
  const titleEl = field("sf-title");
  const notesEl = field("sf-notes");
  const remainderEl = el("sf-remainder");
  const reasonsEl = /** @type {HTMLUListElement} */ (el("sf-reasons"));
  const submitEl = /** @type {HTMLButtonElement} */ (el("sf-submit"));

  playedAtEl.value = editing ? toLocalInputValue(new Date(editing.playedAt)) : toLocalInputValue(new Date());

  /** @type {{id: string, row: HTMLElement, check: HTMLInputElement, amount: HTMLInputElement}[]} */
  const rows = [];
  const resultByMember = new Map((editing?.participants ?? []).map((p) => [p.memberId, p.amountCents]));
  const entries = [];
  const seen = new Set();
  for (const m of state.members) {
    entries.push({ id: m.id, name: m.name, active: true });
    seen.add(m.id);
  }
  for (const p of editing?.participants ?? []) {
    if (!seen.has(p.memberId)) entries.push({ id: p.memberId, name: p.name, active: false });
  }

  for (const e of entries) {
    const row = document.createElement("div");
    row.className = "part-row";
    const checkId = "sf-c-" + e.id;
    row.innerHTML = `
      <input type="checkbox" class="part-check" id="${esc(checkId)}">
      <label for="${esc(checkId)}" class="part-name">${esc(e.name)}${e.active ? "" : ' <span class="part-inactive">(inactive)</span>'}</label>
      <input type="text" inputmode="decimal" class="input part-amount money" data-id="${esc(e.id)}" aria-label="Amount for ${esc(e.name)}" placeholder="+0.00" autocomplete="off" hidden>`;
    const check = /** @type {HTMLInputElement} */ (q(row, ".part-check"));
    const amount = /** @type {HTMLInputElement} */ (q(row, ".part-amount"));
    if (resultByMember.has(e.id)) {
      check.checked = true;
      amount.value = toDollarsInput(/** @type {number} */ (resultByMember.get(e.id)));
      amount.hidden = false;
    }
    check.addEventListener("change", () => {
      amount.hidden = !check.checked;
      if (check.checked) amount.focus();
      recompute();
    });
    amount.addEventListener("input", recompute);
    membersEl.appendChild(row);
    rows.push({ id: e.id, row, check, amount });
  }

  function recompute() {
    let sum = 0;
    let checkedCount = 0;
    let missing = 0;
    let invalid = 0;
    for (const r of rows) {
      if (!r.check.checked) continue;
      checkedCount += 1;
      const v = parseDollarsToCents(r.amount.value);
      if (v === null) {
        r.row.classList.add("is-invalid");
        if (r.amount.value.trim() === "") missing += 1;
        else invalid += 1;
      } else {
        r.row.classList.remove("is-invalid");
        sum += v;
      }
    }
    const reasons = [];
    if (checkedCount < 2) reasons.push("Select at least two participants.");
    if (missing > 0) reasons.push("Enter an amount for every selected participant.");
    if (invalid > 0) reasons.push("Amounts must look like +12.50, -5 or 10000 (two decimals max).");
    if (reasons.length === 0 && sum !== 0) reasons.push("The amounts must balance to exactly $0.00.");
    remainderEl.textContent = "Remaining to balance: " + formatCents(-sum).replace(/^\+/, "");
    remainderEl.classList.toggle("remainder-ok", sum === 0);
    reasonsEl.innerHTML = reasons.map((r) => `<li>${esc(r)}</li>`).join("");
    reasonsEl.hidden = reasons.length === 0;
    submitEl.disabled = reasons.length > 0 || sum !== 0;
  }
  recompute();

  /** @type {HTMLButtonElement} */ (el("sf-cancel")).addEventListener("click", closeModal);

  submitEl.addEventListener("click", async () => {
    if (submitEl.disabled) return;
    const results = [];
    for (const r of rows) {
      if (!r.check.checked) continue;
      const v = parseDollarsToCents(r.amount.value);
      if (v === null) return; // safely unreachable while submit is enabled
      results.push({ memberId: r.id, amountCents: v });
    }
    const playedAt = localInputToISO(playedAtEl.value);
    if (!playedAt) {
      showBanner({ kind: "error", message: "Pick a date and time for the session." });
      return;
    }
    submitEl.disabled = true;
    const label = submitEl.textContent;
    submitEl.textContent = "Saving…";
    try {
      const data = editing
        ? await api(`/admin/sessions/${encodeURIComponent(editing.id)}`, {
            method: "PATCH",
            body: {
              version: editing.version,
              playedAt,
              title: titleEl.value.trim() || undefined,
              notes: notesEl.value.trim() || undefined,
              results,
            },
          })
        : await api("/sessions", {
            method: "POST",
            body: {
              requestKey: crypto.randomUUID(),
              playedAt,
              title: titleEl.value.trim() || undefined,
              notes: notesEl.value.trim() || undefined,
              results,
            },
          });
      const session = data?.session ?? null;
      closeModal();
      if (!editing && session) {
        const queued = typeof data?.receiptsQueued === "number" ? data.receiptsQueued : results.length;
        state.pendingDeliveryShortfall = Math.max(0, results.length - queued);
        state.createdSessionId = session.id;
      }
      opts.onSaved(session);
    } catch (e) {
      const errObj = /** @type {ApiError} */ (e);
      if (errObj.code === "conflict" || errObj.status === 409) {
        showBanner({
          kind: "error",
          message: "This session was changed by someone else. Reload the latest version and try again.",
        });
      } else {
        let extra = "";
        if (errObj.fieldErrors) {
          const msgs = Object.values(errObj.fieldErrors).flat().join(" ");
          if (msgs) extra = " " + msgs;
        }
        showBanner({ kind: "error", message: friendlyMessage(errObj, "Couldn't save the session.") + extra });
      }
      submitEl.disabled = false;
      submitEl.textContent = label ?? "Save session";
    }
  });
}

/* ── Session detail ────────────────────────────────────────── */

/**
 * @param {string} id
 */
function showSessionDetail(id) {
  showView("detail");
  const body = el("detail-body");
  body.innerHTML = `
    <button type="button" class="detail-back" id="detail-back">← Back to sessions</button>
    <div class="card card-narrow" id="detail-card">
      <div class="spinner" aria-hidden="true"></div>
      <p class="loading-text">Loading session…</p>
    </div>`;
  q(body, "#detail-back").addEventListener("click", () => renderDashboard());
  loadSessionDetail(id);
}

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
async function loadSessionDetail(id) {
  const card = el("detail-card");
  try {
    const data = await api("/sessions/" + encodeURIComponent(id));
    const session = data?.session ?? null;
    if (!session) throw new Error("empty");
    if (state.createdSessionId === id && state.pendingDeliveryShortfall !== null && state.pendingDeliveryShortfall > 0) {
      showBanner({
        kind: "info",
        message: `Session saved — ${state.pendingDeliveryShortfall} of ${session.participants.length} receipt emails are still pending delivery.`,
      });
    }
    state.createdSessionId = null;
    state.pendingDeliveryShortfall = null;
    renderDetail(session);
  } catch (e) {
    if (e instanceof Error && e.message === "empty") {
      renderErrorBox(card, "This session could not be found.", () => showSessionDetail(id));
      return;
    }
    const errObj = /** @type {ApiError} */ (e);
    renderErrorBox(card, friendlyMessage(errObj, "Couldn't load the session."), () => loadSessionDetail(id));
  }
}

/**
 * @param {SessionDetail} session
 */
function renderDetail(session) {
  const card = el("detail-card");
  const voided = session.status === "voided";
  const html = `
    <div class="detail-head">
      <h2>${esc(session.title || "Poker session")}</h2>
      <span class="chip chip-${esc(session.status)}">${esc(statusLabel(session.status))}</span>
    </div>
    <p class="detail-meta">${esc(formatDateTime(session.playedAt))} · version ${session.version}</p>
    <p class="detail-meta">Recorded by ${esc(session.recordedBy ? session.recordedBy.name : "—")}</p>
    ${session.notes ? `<div class="detail-notes">${esc(session.notes)}</div>` : ""}
    ${voided ? `<p class="detail-note">This session was voided and is excluded from the ledger.</p>` : ""}
    ${session.status === "disputed" ? `<p class="detail-note">A participant disputed this session. It stays in the ledger while an admin reviews it.</p>` : ""}
    <div data-slot="results"></div>`;
  card.innerHTML = html;
  q(card, '[data-slot="results"]').appendChild(buildResultsTable(session));

  if (!voided && state.status?.viewer) {
    const disputeBtn = document.createElement("button");
    disputeBtn.type = "button";
    disputeBtn.className = "btn btn-danger";
    disputeBtn.textContent = "Dispute session";
    disputeBtn.addEventListener("click", () => {
      const body = document.createElement("form");
      body.className = "stack";
      body.innerHTML = `<label class="field" for="direct-dispute-reason">What is incorrect?<textarea id="direct-dispute-reason" class="input" rows="4" maxlength="1000" required></textarea></label><button class="btn btn-primary" type="submit">Submit dispute</button>`;
      body.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const reason = /** @type {HTMLTextAreaElement} */ (body.querySelector("textarea")).value.trim();
        if (!reason) return;
        try { await api("/disputes/direct", { method: "POST", body: { sessionId: session.id, reason } }); closeModal(); showBanner({ kind: "info", message: "Dispute submitted for admin review." }); await loadSessionDetail(session.id); }
        catch (e) { showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't submit the dispute.") }); }
      });
      openModal({ title: "Dispute session", body });
    });
    card.appendChild(disputeBtn);
  }

  if (state.status?.admin && !voided) {
    const actions = document.createElement("div");
    actions.className = "detail-admin-actions";
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn";
    editBtn.textContent = "Edit session";
    editBtn.addEventListener("click", () => {
      openSessionModal({
        editing: session,
        onSaved: () => loadSessionDetail(session.id),
      });
    });
    const voidBtn = document.createElement("button");
    voidBtn.type = "button";
    voidBtn.className = "btn btn-danger";
    voidBtn.textContent = "Void session";
    let armed = false;
    let timer = 0;
    voidBtn.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        voidBtn.textContent = "Click again to confirm void";
        voidBtn.classList.add("btn-danger-solid");
        timer = window.setTimeout(() => {
          armed = false;
          voidBtn.textContent = "Void session";
          voidBtn.classList.remove("btn-danger-solid");
        }, 4000);
        return;
      }
      window.clearTimeout(timer);
      voidBtn.disabled = true;
      voidBtn.textContent = "Voiding…";
      api(`/admin/sessions/${encodeURIComponent(session.id)}/void`, { method: "POST" })
        .then(() => {
          showBanner({ kind: "info", message: "Session voided and excluded from the ledger." });
          return loadSessionDetail(session.id);
        })
        .catch((e) => {
          showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't void the session.") });
          voidBtn.disabled = false;
          voidBtn.textContent = "Void session";
        });
    });
    actions.appendChild(editBtn);
    actions.appendChild(voidBtn);
    card.appendChild(actions);
  }
}

/**
 * @param {{participants: Participant[]}} session
 * @param {string|null} [highlightMemberId]
 * @returns {HTMLTableElement}
 */
function buildResultsTable(session, highlightMemberId = null) {
  const table = document.createElement("table");
  table.className = "results-table";
  table.innerHTML = `
    <thead><tr><th scope="col">Player</th><th scope="col" class="num">Result</th></tr></thead>
    <tbody></tbody>
    <tfoot><tr><th scope="row">Total</th><td class="num money">${formatCents(0)}</td></tr></tfoot>`;
  const tbody = /** @type {HTMLTableSectionElement} */ (table.querySelector("tbody"));
  for (const p of session.participants ?? []) {
    const tr = document.createElement("tr");
    if (p.memberId === highlightMemberId) tr.className = "row-you";
    const nameTd = document.createElement("td");
    const nameSpan = document.createElement("span");
    nameSpan.textContent = p.name;
    nameTd.appendChild(nameSpan);
    if (p.memberId === highlightMemberId) {
      const you = document.createElement("span");
      you.className = "you-tag";
      you.textContent = "you";
      nameTd.appendChild(you);
    }
    const amtTd = document.createElement("td");
    amtTd.className = "num money " + moneyClass(p.amountCents);
    amtTd.textContent = formatCents(p.amountCents);
    tr.appendChild(nameTd);
    tr.appendChild(amtTd);
    tbody.appendChild(tr);
  }
  return table;
}

/* ── Dispute flow (?token=) ────────────────────────────────── */

function renderDisputeView() {
  showView("dispute");
  const body = el("dispute-body");
  body.innerHTML = `
    <div class="card card-narrow">
      <div class="spinner" aria-hidden="true"></div>
      <p class="loading-text">Checking your receipt…</p>
    </div>`;
  verifyDisputeToken(body);
}

/**
 * @param {HTMLElement} body
 * @returns {Promise<void>}
 */
async function verifyDisputeToken(body) {
  try {
    const data = await api("/disputes/verify-token", { method: "POST", body: { token: state.token } });
    renderDisputeReceipt(body, data?.token ?? null);
  } catch (e) {
    const errObj = /** @type {ApiError} */ (e);
    if (errObj.status === 404 && errObj.code === "token_invalid") {
      renderDisputeExpired(body);
      return;
    }
    // The group session expired (or was never established): send the visitor
    // back through the password gate. The token stays in the URL/state —
    // it is never persisted to localStorage.
    if (errObj.status === 401 || errObj.code === "unauthorized" || errObj.code === "viewer_required") {
      await refreshStatus();
      route();
      return;
    }
    body.innerHTML = "";
    showBanner({
      kind: "error",
      message: friendlyMessage(errObj, "We couldn't load your receipt."),
      retryLabel: "Retry",
      onRetry: () => {
        body.innerHTML = `<div class="spinner" aria-hidden="true"></div><p class="loading-text">Checking your receipt…</p>`;
        verifyDisputeToken(body);
      },
    });
    const card = document.createElement("div");
    card.className = "card card-narrow";
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = "Try again to load your receipt.";
    card.appendChild(p);
    body.appendChild(card);
  }
}

/**
 * @param {HTMLElement} body
 * @param {any} token
 */
function renderDisputeReceipt(body, token) {
  const session = token?.session ?? null;
  if (!session) {
    renderDisputeExpired(body);
    return;
  }
  body.innerHTML = "";
  const card = document.createElement("div");
  card.className = "card card-narrow";
  card.innerHTML = `
    <div class="detail-head">
      <h2>${esc(session.title || "Poker session")}</h2>
      <span class="chip chip-included">Receipt</span>
    </div>
    <p class="detail-meta">${esc(formatDateTime(session.playedAt))}</p>
    <p class="detail-meta">Recorded by ${esc(session.recordedBy ? session.recordedBy.name : "—")}</p>
    <div data-slot="results"></div>
    <hr class="gate-sep">
    <label class="field" for="dp-reason">Why are you disputing this? (required)</label>
    <textarea id="dp-reason" class="input" rows="4" maxlength="1000" placeholder="What looks wrong about this session?"></textarea>
    <p class="char-count" id="dp-count">0 / 1000</p>
    <div class="modal-actions">
      <button type="button" class="btn btn-primary" id="dp-submit">Submit dispute</button>
    </div>`;
  q(card, '[data-slot="results"]').appendChild(buildResultsTable(session, token.memberId));
  body.appendChild(card);

  const reasonEl = /** @type {HTMLTextAreaElement} */ (q(card, "#dp-reason"));
  const countEl = q(card, "#dp-count");
  reasonEl.addEventListener("input", () => {
    countEl.textContent = `${reasonEl.value.length} / 1000`;
  });
  const submitEl = /** @type {HTMLButtonElement} */ (q(card, "#dp-submit"));
  submitEl.addEventListener("click", async () => {
    const reason = reasonEl.value.trim();
    if (!reason) {
      showBanner({ kind: "error", message: "Write a short reason before submitting." });
      reasonEl.focus();
      return;
    }
    submitEl.disabled = true;
    submitEl.textContent = "Submitting…";
    try {
      await api("/disputes", { method: "POST", body: { token: state.token, reason } });
      clearTokenFromUrl();
      renderDisputeSuccess(body);
    } catch (e) {
      const errObj = /** @type {ApiError} */ (e);
      // Session expired mid-flow → back through the password gate (token kept).
      if (errObj.status === 401 || errObj.code === "unauthorized" || errObj.code === "viewer_required") {
        await refreshStatus();
        route();
        submitEl.disabled = false;
        return;
      }
      showBanner({ kind: "error", message: friendlyMessage(errObj, "Couldn't submit the dispute.") });
      submitEl.disabled = false;
      submitEl.textContent = "Submit dispute";
    }
  });
}

/**
 * @param {HTMLElement} body
 */
function renderDisputeSuccess(body) {
  body.innerHTML = `
    <div class="card card-narrow dispute-success">
      <div class="check-mark" aria-hidden="true">✓</div>
      <h2>Dispute submitted</h2>
      <p>Dispute submitted. The group admin will review it.</p>
      <p>The session stays on the ledger while it's reviewed.</p>
      <button type="button" class="btn btn-primary" id="dp-back">Back to Poker Ledger</button>
    </div>`;
  q(body, "#dp-back").addEventListener("click", () => route());
}

/**
 * @param {HTMLElement} body
 */
function renderDisputeExpired(body) {
  clearTokenFromUrl();
  body.innerHTML = `
    <div class="card card-narrow dispute-success">
      <h2>This link is no longer valid</h2>
      <p>This receipt link is invalid or has expired.</p>
      <p>If you still have questions about a session, ask the person who recorded it.</p>
      <button type="button" class="btn btn-primary" id="dp-back">Back to Poker Ledger</button>
    </div>`;
  q(body, "#dp-back").addEventListener("click", () => route());
}

/* ── Admin panels ──────────────────────────────────────────── */

function openRequestsPanel() {
  const body = document.createElement("div");
  body.innerHTML = `<div class="spinner" aria-hidden="true"></div><p class="loading-text">Loading requests…</p>`;
  openModal({ title: "Join requests", body, wide: true });
  refresh();
  async function refresh() {
    try {
      const data = await api("/admin/join-requests");
      state.adminRequests = data.requests ?? [];
      updateBadges();
      const list = state.adminRequests ?? [];
      body.innerHTML = "";
      if (list.length === 0) {
        body.innerHTML = `<p class="empty-state">No join requests.</p>`;
        return;
      }
      for (const rq of list) {
        body.appendChild(buildRequestItem(rq, refresh));
      }
    } catch (e) {
      renderErrorBox(body, friendlyMessage(/** @type {ApiError} */ (e), "Couldn't load requests."), refresh);
    }
  }
}

/**
 * @param {JoinRequest} rq
 * @param {() => Promise<void>} refresh
 * @returns {HTMLElement}
 */
function buildRequestItem(rq, refresh) {
  const item = document.createElement("article");
  item.className = "request-item";
  item.innerHTML = `
    <div class="request-head">
      <strong>${esc(rq.displayName)}</strong>
      <span class="chip chip-${esc(rq.status)}">${esc(rq.status)}</span>
    </div>
    <p class="request-meta">${esc(rq.email)} · requested ${esc(formatDate(rq.requestedAt))}</p>
    ${rq.note ? `<div class="request-note">${esc(rq.note)}</div>` : ""}
    <div class="row-actions" data-actions></div>`;
  const actions = q(item, "[data-actions]");
  if (rq.status === "pending") {
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "btn btn-small btn-primary";
    approve.textContent = "Approve";
    approve.addEventListener("click", () => actOnRequest(rq.id, "approve", approve, refresh));
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "btn btn-small btn-danger";
    reject.textContent = "Reject";
    reject.addEventListener("click", () => actOnRequest(rq.id, "reject", reject, refresh));
    actions.appendChild(approve);
    actions.appendChild(reject);
  }
  return item;
}

/**
 * @param {string} id
 * @param {"approve"|"reject"} kind
 * @param {HTMLButtonElement} btn
 * @param {() => Promise<void>} refresh
 * @returns {Promise<void>}
 */
async function actOnRequest(id, kind, btn, refresh) {
  btn.disabled = true;
  try {
    await api(`/admin/join-requests/${encodeURIComponent(id)}/${kind}`, { method: "POST" });
    await Promise.allSettled([loadMembers(), loadBadgeCounts()]);
    showBanner({ kind: "info", message: kind === "approve" ? "Request approved — member added." : "Request rejected." });
  } catch (e) {
    btn.disabled = false;
    showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), `Couldn't ${kind} the request.`) });
  }
  await refresh();
}

function openMembersPanel() {
  const body = document.createElement("div");
  openModal({ title: "Members", body, wide: true });

  const form = document.createElement("form");
  form.className = "stack";
  form.innerHTML = `
    <div class="form-grid">
      <div>
        <label class="field" for="am-name">Display name</label>
        <input id="am-name" type="text" class="input" maxlength="80" required>
      </div>
      <div>
        <label class="field" for="am-email">Email</label>
        <input id="am-email" type="email" class="input" maxlength="254" placeholder="Optional">
      </div>
    </div>
    <label class="check-row">
      <input id="am-welcome" type="checkbox"> Send a welcome email
    </label>
    <div class="modal-actions">
      <button type="submit" class="btn btn-primary" id="am-submit">Add member</button>
    </div>
    <p class="form-note" id="am-note" role="status" hidden></p>`;
  body.appendChild(form);

  const listWrap = document.createElement("div");
  body.appendChild(listWrap);

  const noteEl = q(form, "#am-note");
  const nameEl = /** @type {HTMLInputElement} */ (q(form, "#am-name"));
  const emailEl = /** @type {HTMLInputElement} */ (q(form, "#am-email"));
  const welcomeEl = /** @type {HTMLInputElement} */ (q(form, "#am-welcome"));
  const submitEl = /** @type {HTMLButtonElement} */ (q(form, "#am-submit"));

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    noteEl.hidden = true;
    const name = nameEl.value.trim();
    const email = emailEl.value.trim();
    if (!name || (email && !EMAIL_RE.test(email))) {
      noteEl.textContent = "Enter a name and, if provided, a valid email address.";
      noteEl.hidden = false;
      return;
    }
    submitEl.disabled = true;
    const label = submitEl.textContent;
    submitEl.textContent = "Adding…";
    try {
      await api("/admin/members", {
        method: "POST",
        body: { displayName: name, email, welcomeEmail: welcomeEl.checked },
      });
      nameEl.value = "";
      emailEl.value = "";
      welcomeEl.checked = false;
      noteEl.textContent = "Member added.";
      noteEl.hidden = false;
      await Promise.allSettled([loadMembers(), loadBadgeCounts()]);
      await refreshList();
    } catch (e) {
      noteEl.textContent = friendlyMessage(/** @type {ApiError} */ (e), "Couldn't add the member.");
      noteEl.hidden = false;
    } finally {
      submitEl.disabled = false;
      submitEl.textContent = label ?? "Add member";
    }
  });

  async function refreshList() {
    let adminMembers;
    try { adminMembers = (await api("/admin/members")).members ?? []; state.members = adminMembers; fillViewerSelect(); }
    catch {
      renderErrorBox(listWrap, "Couldn't load members.", refreshList);
      return;
    }
    listWrap.innerHTML = "";
    if (state.members.length === 0) {
      const p = document.createElement("p");
      p.className = "empty-state";
      p.textContent = "No active members yet — add the first one above.";
      listWrap.appendChild(p);
      return;
    }
    const hint = document.createElement("p");
    hint.className = "form-hint";
    hint.textContent = "Members who have been deactivated don't appear in this list.";
    listWrap.appendChild(hint);
    for (const m of state.members) {
      listWrap.appendChild(buildMemberRow(m, refreshList));
    }
  }

  refreshList();
}

/**
 * @param {Member} m
 * @param {() => Promise<void>} refresh
 * @returns {HTMLElement}
 */
function buildMemberRow(m, refresh) {
  const row = document.createElement("div");
  row.className = "member-row";
  const name = document.createElement("span");
  name.className = "part-name";
  name.textContent = m.name;
  row.appendChild(name);
  const edit = document.createElement("button");
  edit.type = "button"; edit.className = "btn btn-small"; edit.textContent = "Edit";
  edit.addEventListener("click", () => {
    const body = document.createElement("form"); body.className = "stack";
    body.innerHTML = `<label class="field">Display name<input class="input" id="edit-member-name" value="${esc(m.name)}" maxlength="80" required></label><label class="field">Email<input class="input" id="edit-member-email" type="email" value="${esc(m.email ?? "")}" placeholder="Optional"></label><button class="btn btn-primary" type="submit">Save changes</button>`;
    body.addEventListener("submit", async (ev) => { ev.preventDefault(); const n = body.querySelector("#edit-member-name").value.trim(); const e = body.querySelector("#edit-member-email").value.trim(); if (!n || (e && !EMAIL_RE.test(e))) return; try { await api(`/admin/members/${encodeURIComponent(m.id)}`, { method: "PATCH", body: { displayName: n, email: e } }); closeModal(); await refresh(); showBanner({ kind: "info", message: "Member updated." }); } catch (err) { showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (err), "Couldn't update the member.") }); } });
    openModal({ title: "Edit member", body });
  });
  row.appendChild(edit);
  const deact = document.createElement("button");
  deact.type = "button";
  deact.className = "btn btn-small btn-danger";
  deact.textContent = "Deactivate";
  deact.addEventListener("click", async () => {
    deact.disabled = true;
    try {
      await api(`/admin/members/${encodeURIComponent(m.id)}`, { method: "PATCH", body: { status: "inactive" } });
      showBanner({ kind: "info", message: `${m.name} was deactivated.` });
      await refresh();
    } catch (e) {
      deact.disabled = false;
      showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't deactivate the member.") });
    }
  });
  row.appendChild(deact);
  return row;
}

function openDisputesPanel() {
  const body = document.createElement("div");
  body.innerHTML = `<div class="spinner" aria-hidden="true"></div><p class="loading-text">Loading disputes…</p>`;
  openModal({ title: "Disputes", body, wide: true });
  refresh();
  async function refresh() {
    try {
      const data = await api("/admin/disputes");
      state.adminDisputes = data.disputes ?? [];
      updateBadges();
      const list = state.adminDisputes ?? [];
      body.innerHTML = "";
      if (list.length === 0) {
        body.innerHTML = `<p class="empty-state">No disputes.</p>`;
        return;
      }
      for (const d of list) {
        body.appendChild(buildDisputeItem(d, refresh));
      }
    } catch (e) {
      renderErrorBox(body, friendlyMessage(/** @type {ApiError} */ (e), "Couldn't load disputes."), refresh);
    }
  }
}

/**
 * @param {DisputeInfo} d
 * @param {() => Promise<void>} refresh
 * @returns {HTMLElement}
 */
function buildDisputeItem(d, refresh) {
  const item = document.createElement("article");
  item.className = "dispute-item";
  const sessionTitle = d.session?.title || "Session";
  const dateStr = d.session?.playedAt ? formatDate(d.session.playedAt) : formatDate(d.createdAt);
  item.innerHTML = `
    <div class="dispute-head">
      <strong>${esc(sessionTitle)}</strong>
      <span class="chip chip-${esc(d.status)}">${esc(disputeStatusLabel(d.status))}</span>
    </div>
    <p class="dispute-meta">${esc(dateStr)} · disputed by ${esc(d.memberName)} · ${esc(formatDate(d.createdAt))}</p>
    <div class="dispute-reason">“${esc(d.reason)}”</div>
    ${d.resolutionNote ? `<p class="resolution-note">Note: ${esc(d.resolutionNote)}</p>` : ""}
    <div class="row-actions" data-actions></div>
    <div data-form></div>`;
  const actions = q(item, "[data-actions]");
  const formSlot = q(item, "[data-form]");
  if (d.status === "open") {
    const resolveBtn = document.createElement("button");
    resolveBtn.type = "button";
    resolveBtn.className = "btn btn-small btn-primary";
    resolveBtn.textContent = "Resolve";
    resolveBtn.addEventListener("click", () => {
      formSlot.innerHTML = "";
      formSlot.appendChild(buildResolveForm(d, refresh));
    });
    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "btn btn-small";
    dismissBtn.textContent = "Dismiss";
    dismissBtn.addEventListener("click", () => {
      formSlot.innerHTML = "";
      formSlot.appendChild(buildDismissForm(d, refresh));
    });
    actions.appendChild(resolveBtn);
    actions.appendChild(dismissBtn);
  }
  return item;
}

/**
 * @param {DisputeInfo} d
 * @param {() => Promise<void>} refresh
 * @returns {HTMLElement}
 */
function buildResolveForm(d, refresh) {
  const wrap = document.createElement("div");
  wrap.className = "resolve-form";
  wrap.innerHTML = `
    <label class="field" for="rd-note">Resolution note (optional)</label>
    <textarea id="rd-note" class="input" rows="2" maxlength="500"></textarea>
    <label class="check-row"><input type="checkbox" id="rd-adjust"> Adjust the amounts (optional)</label>
    <div id="rd-corrections" hidden>
      <div class="loading-text">Loading current amounts…</div>
    </div>
    <p class="remainder" id="rd-remainder" aria-live="polite" hidden>Remaining to balance: $0.00</p>
    <ul class="reasons" id="rd-reasons" hidden></ul>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost btn-small" data-cancel>Cancel</button>
      <button type="button" class="btn btn-primary" data-submit>Resolve dispute</button>
    </div>`;
  const noteEl = /** @type {HTMLTextAreaElement} */ (q(wrap, "#rd-note"));
  const adjustEl = /** @type {HTMLInputElement} */ (q(wrap, "#rd-adjust"));
  const corrEl = q(wrap, "#rd-corrections");
  const remainderEl = q(wrap, "#rd-remainder");
  const reasonsEl = /** @type {HTMLUListElement} */ (q(wrap, "#rd-reasons"));
  const submitBtn = /** @type {HTMLButtonElement} */ (q(wrap, "[data-submit]"));
  q(wrap, "[data-cancel]").addEventListener("click", () => wrap.remove());

  /** @type {{id: string, name: string, el: HTMLInputElement, original: number}[]} */
  const corrRows = [];
  let loaded = false;
  let dirty = false;

  function recompute() {
    let sum = 0;
    let invalid = 0;
    dirty = false;
    for (const r of corrRows) {
      const v = parseDollarsToCents(r.el.value);
      const rowEl = r.el.closest(".corr-row");
      if (v === null) {
        invalid += 1;
        if (rowEl) rowEl.classList.add("is-invalid");
      } else {
        if (rowEl) rowEl.classList.remove("is-invalid");
        sum += v;
        if (v !== r.original) dirty = true;
      }
    }
    const reasons = [];
    if (invalid > 0) reasons.push("Every amount must look like +12.50, -5 or 10000 (two decimals max).");
    if (reasons.length === 0 && sum !== 0) reasons.push("The amounts must balance to exactly $0.00.");
    remainderEl.textContent = "Remaining to balance: " + formatCents(-sum).replace(/^\+/, "");
    remainderEl.classList.toggle("remainder-ok", sum === 0);
    reasonsEl.innerHTML = reasons.map((r) => `<li>${esc(r)}</li>`).join("");
    reasonsEl.hidden = reasons.length === 0;
    submitBtn.disabled = !loaded || reasons.length > 0 || sum !== 0;
  }

  adjustEl.addEventListener("change", async () => {
    if (!adjustEl.checked) {
      corrEl.hidden = true;
      corrRows.length = 0;
      remainderEl.hidden = true;
      reasonsEl.hidden = true;
      loaded = false;
      submitBtn.disabled = false;
      return;
    }
    corrEl.hidden = false;
    corrEl.innerHTML = `<div class="loading-text">Loading current amounts…</div>`;
    remainderEl.hidden = true;
    loaded = false;
    submitBtn.disabled = true;
    try {
      const data = await api("/sessions/" + encodeURIComponent(d.sessionId));
      const parts = data?.session?.participants ?? [];
      corrEl.innerHTML = `<div class="corrections-grid"></div>`;
      const grid = q(corrEl, ".corrections-grid");
      for (const p of parts) {
        const rowEl = document.createElement("div");
        rowEl.className = "corr-row";
        const nameElx = document.createElement("span");
        nameElx.className = "part-name";
        nameElx.textContent = p.name;
        const amtEl = document.createElement("input");
        amtEl.type = "text";
        amtEl.inputMode = "decimal";
        amtEl.className = "input part-amount money";
        amtEl.value = toDollarsInput(p.amountCents);
        amtEl.setAttribute("aria-label", "Corrected amount for " + p.name);
        rowEl.appendChild(nameElx);
        rowEl.appendChild(amtEl);
        grid.appendChild(rowEl);
        corrRows.push({ id: p.memberId, name: p.name, el: amtEl, original: p.amountCents });
        amtEl.addEventListener("input", recompute);
      }
      loaded = true;
      remainderEl.hidden = false;
      recompute();
    } catch (e) {
      corrEl.innerHTML = "";
      loaded = false;
      renderErrorBox(corrEl, friendlyMessage(/** @type {ApiError} */ (e), "Couldn't load the session amounts."), () => {
        adjustEl.checked = false;
        adjustEl.dispatchEvent(new Event("change"));
      });
    }
  });

  submitBtn.addEventListener("click", async () => {
    if (submitBtn.disabled) return;
    submitBtn.disabled = true;
    const label = submitBtn.textContent;
    submitBtn.textContent = "Resolving…";
    /** @type {any} */
    const payload = { outcome: "resolved" };
    const note = noteEl.value.trim();
    if (note) payload.note = note;
    if (adjustEl.checked && dirty) {
      payload.corrections = corrRows.map((r) => ({
        memberId: r.id,
        amountCents: /** @type {number} */ (parseDollarsToCents(r.el.value)),
      }));
    }
    try {
      await api(`/admin/disputes/${encodeURIComponent(d.id)}/resolve`, { method: "POST", body: payload });
      showBanner({ kind: "info", message: "Dispute resolved." });
      await loadBadgeCounts();
      await refresh();
    } catch (e) {
      showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't resolve the dispute.") });
      submitBtn.disabled = false;
      submitBtn.textContent = label ?? "Resolve dispute";
    }
  });

  return wrap;
}

/**
 * @param {DisputeInfo} d
 * @param {() => Promise<void>} refresh
 * @returns {HTMLElement}
 */
function buildDismissForm(d, refresh) {
  const wrap = document.createElement("div");
  wrap.className = "resolve-form";
  wrap.innerHTML = `
    <label class="field" for="dd-note">Resolution note (optional)</label>
    <textarea id="dd-note" class="input" rows="2" maxlength="500"></textarea>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost btn-small" data-cancel>Cancel</button>
      <button type="button" class="btn btn-primary" data-submit>Dismiss dispute</button>
    </div>`;
  const noteEl = /** @type {HTMLTextAreaElement} */ (q(wrap, "#dd-note"));
  const submitBtn = /** @type {HTMLButtonElement} */ (q(wrap, "[data-submit]"));
  q(wrap, "[data-cancel]").addEventListener("click", () => wrap.remove());
  submitBtn.addEventListener("click", async () => {
    submitBtn.disabled = true;
    const label = submitBtn.textContent;
    submitBtn.textContent = "Dismissing…";
    /** @type {any} */
    const payload = { outcome: "dismissed" };
    const note = noteEl.value.trim();
    if (note) payload.note = note;
    try {
      await api(`/admin/disputes/${encodeURIComponent(d.id)}/resolve`, { method: "POST", body: payload });
      showBanner({ kind: "info", message: "Dispute dismissed." });
      await loadBadgeCounts();
      await refresh();
    } catch (e) {
      showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't dismiss the dispute.") });
      submitBtn.disabled = false;
      submitBtn.textContent = label ?? "Dismiss dispute";
    }
  });
  return wrap;
}

/* ── Header handlers ───────────────────────────────────────── */

async function onLogout() {
  try {
    await api("/auth/logout", { method: "POST" });
    state.status = { group: false, admin: false, viewer: null, authVersion: 0 };
  } catch {
    try {
      await refreshStatus();
    } catch {
      state.status = { group: false, admin: false, viewer: null, authVersion: 0 };
    }
  }
  state.members = [];
  state.ledger = null;
  state.sessions = [];
  state.live = null;
  state.nextCursor = null;
  route();
}

async function onViewerChange() {
  const sel = /** @type {HTMLSelectElement} */ (el("viewer-select"));
  const id = sel.value;
  if (!id) return;
  sel.disabled = true;
  try {
    const data = await api("/viewer", { method: "POST", body: { memberId: id } });
    if (state.status) {
      state.status = { ...state.status, viewer: data?.viewer ?? null };
    }
    fillViewerSelect();
    // The dashboard asks the user to choose a name until a viewer is set.
    // Clear that one-time prompt as soon as the selection succeeds.
    dismissBanner("Pick your name in the top bar so the sessions you record are marked as yours.");
    // Re-fetch the ledger so the YOU marker follows the newly selected profile.
    await loadLedger();
  } catch (e) {
    showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't switch viewer.") });
  } finally {
    sel.disabled = false;
  }
}

async function onFeedbackSubmit(event) {
  event.preventDefault();
  const message = el("feedback-message").value.trim();
  const note = el("feedback-note");
  if (!message) { note.textContent = "Please enter a message."; note.hidden = false; return; }
  try {
    await api("/feedback", { method: "POST", body: { kind: el("feedback-kind").value, message } });
    el("feedback-message").value = "";
    note.textContent = "Thanks — feedback sent.";
  } catch (e) {
    note.textContent = friendlyMessage(/** @type {ApiError} */ (e), "Couldn’t send feedback yet.");
  }
  note.hidden = false;
}

function openFeedbackModal() {
  const body = document.createElement("form");
  body.className = "stack";
  body.id = "feedback-form";
  body.innerHTML = `<label class="field" for="feedback-kind">Type<select id="feedback-kind" class="input"><option value="suggestion">Suggestion</option><option value="bug">Bug report</option></select></label><label class="field" for="feedback-message">What should we know?<textarea id="feedback-message" class="input" rows="4" maxlength="2000" required></textarea></label><button class="btn btn-primary" type="submit">Send feedback</button><p id="feedback-note" class="form-note" role="status" hidden></p>`;
  body.addEventListener("submit", onFeedbackSubmit);
  openModal({ title: "Suggestions & bugs", body });
}

function onAddSession() {
  if (!state.status?.viewer) {
    showBanner({
      kind: "info",
      message: "Select your name in the top bar first — sessions are recorded for the selected name.",
    });
    return;
  }
  if (state.members.length === 0) {
    showBanner({ kind: "info", message: "There are no active members yet. Ask an admin to add members first." });
    return;
  }
  openSessionModal({
    editing: null,
    onSaved: (session) => {
      if (session) showSessionDetail(session.id);
    },
  });
}

async function onAdminLock() {
  try {
    await api("/admin/lock", { method: "POST" });
    await refreshStatus();
    route();
  } catch (e) {
    showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't lock admin.") });
  }
}

/* ── Init ──────────────────────────────────────────────────── */

function wireStatic() {
  el("gate-form").addEventListener("submit", onGateUnlock);
  el("gate-request-form").addEventListener("submit", onRequestSubmit);
  el("gate-admin-form").addEventListener("submit", onAdminUnlock);
  wireCollapsible("gate-request-toggle", "gate-request-form");
  wireCollapsible("gate-admin-toggle", "gate-admin-form");
  el("dash-admin-form-inner").addEventListener("submit", onDashAdminUnlock);
  wireCollapsible("dash-admin-toggle", "dash-admin-form");
  /** @type {HTMLButtonElement} */ (el("logout-btn")).addEventListener("click", onLogout);
  /** @type {HTMLSelectElement} */ (el("viewer-select")).addEventListener("change", onViewerChange);
  el("feedback-btn").addEventListener("click", openFeedbackModal);
  /** @type {HTMLButtonElement} */ (el("add-session-btn")).addEventListener("click", onAddSession);
  el("start-live-btn").addEventListener("click", openStartLiveModal);
  el("live-banner").addEventListener("click", openLiveModal);
  /** @type {HTMLButtonElement} */ (el("badge-requests")).addEventListener("click", openRequestsPanel);
  /** @type {HTMLButtonElement} */ (el("badge-disputes")).addEventListener("click", openDisputesPanel);
  /** @type {HTMLButtonElement} */ (el("badge-members")).addEventListener("click", openMembersPanel);
  /** @type {HTMLButtonElement} */ (el("admin-lock-btn")).addEventListener("click", onAdminLock);
}

async function init() {
  wireStatic();
  renderGate();
  try {
    await refreshStatus();
  } catch (e) {
    state.status = { group: false, admin: false, viewer: null, authVersion: 0 };
    showBanner({
      kind: "error",
      message: friendlyMessage(
        /** @type {ApiError} */ (e),
        "The poker server isn't reachable yet — it may still be starting up."
      ),
      retryLabel: "Reload",
      onRetry: () => location.reload(),
    });
  }
  route();
}

init();
