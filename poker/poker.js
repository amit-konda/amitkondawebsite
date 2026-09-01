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
const VALID_TABS = new Set(["poker", "blackjack", "handshake", "overall"]);

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
 *   blackjackLedger: LedgerData|null,
 *   blackjackSessions: any[],
 *   gameTab: string,
 *   handshakeLedger: LedgerData|null,
 *   handshakeBets: any[],
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
  blackjackLedger: null,
  blackjackSessions: [],
  gameTab: "overall",
  handshakeLedger: null,
  handshakeBets: [],
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
  // Avoid piling up identical banners: several flows (re-rendering the
  // dashboard, repeated modal-guard checks, etc.) can call showBanner with
  // the exact same message more than once before it's dismissed. Treat a
  // duplicate as a no-op instead of stacking another copy.
  for (const existing of root.querySelectorAll(".banner-msg")) {
    if (existing.textContent === opts.message) return;
  }
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
let livePollTimer = null;

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

const VIEW_IDS = ["view-gate", "view-dashboard", "view-blackjack", "view-overall", "view-handshake", "view-detail", "view-dispute"];

/**
 * @param {"gate"|"dashboard"|"blackjack"|"overall"|"handshake"|"detail"|"dispute"} name
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

/**
 * Build the shareable app URL for a tab (+ optional session id) so views
 * are deep-linkable and survive a refresh. "overall" is the default tab
 * and is omitted from the URL to keep the default link clean.
 * @param {{tab?: string, session?: string|null}} parts
 * @returns {string}
 */
function buildAppUrl(parts) {
  const usp = new URLSearchParams();
  const tab = parts.tab ?? state.gameTab;
  if (tab && tab !== "overall") usp.set("tab", tab);
  if (parts.session) usp.set("session", parts.session);
  const qs = usp.toString();
  return location.pathname + (qs ? "?" + qs : "");
}

/** Push a new history entry for in-app navigation (tab switch, open detail). */
function pushAppUrl(parts) {
  const url = buildAppUrl(parts);
  if (url !== location.pathname + location.search) {
    try {
      history.pushState(null, "", url);
    } catch {
      /* ignore */
    }
  }
}

function route() {
  const params = new URLSearchParams(location.search);
  const token = params.get("token");
  state.token = token && token.length > 0 ? token : null;
  if (!state.status || !state.status.group) {
    el("topbar-controls").hidden = true;
    el("game-tabs").hidden = true;
    el("admin-badges").hidden = true;
    el("dash-admin-toggle").hidden = true;
    renderGate();
    return;
  }
  el("topbar-controls").hidden = false;
  el("game-tabs").hidden = false;
  if (state.token) {
    el("admin-badges").hidden = true;
    el("dash-admin-toggle").hidden = true;
    updateGameTabs();
    renderDisputeView();
    return;
  }
  syncAdminUi();
  const tabParam = params.get("tab");
  state.gameTab = tabParam && VALID_TABS.has(tabParam) ? tabParam : "overall";
  updateGameTabs();
  const sessionId = params.get("session");
  if (sessionId) {
    if (state.gameTab === "blackjack") {
      openBlackjackDetail(sessionId, { push: false });
    } else {
      showSessionDetail(sessionId, { push: false });
    }
    return;
  }
  if (state.gameTab === "blackjack") renderBlackjackDashboard();
  else if (state.gameTab === "overall") renderOverallDashboard();
  else if (state.gameTab === "handshake") renderHandshakeDashboard();
  else renderDashboard();
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
    void maybeShowNamePrompt();
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

/**
 * Admin sign-in toggle + Requests/Disputes/Members badges live outside the
 * per-tab view sections (see index.html), so they must stay in sync on
 * every route() pass rather than only when the Poker tab happens to be
 * active — Overall is the default landing tab.
 */
function syncAdminUi() {
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
}

async function renderDashboard() {
  showView("dashboard");
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
  if (livePollTimer) clearInterval(livePollTimer);
  livePollTimer = window.setInterval(() => { void loadLive(); }, 30000);
}

async function renderBlackjackDashboard() {
  showView("blackjack");
  fillViewerSelect();
  const ledgerBody = el("blackjack-ledger-body");
  const sessionsBody = el("blackjack-sessions-body");
  ledgerBody.innerHTML = `<div class="skel skel-row"></div><div class="skel skel-row"></div>`;
  sessionsBody.innerHTML = `<div class="skel skel-block"></div>`;
  const membersOk = await loadMembers();
  if (!membersOk) showBanner({ kind: "error", message: "Couldn't load the member list.", retryLabel: "Retry", onRetry: renderBlackjackDashboard });
  await Promise.allSettled([loadBlackjackLedger(), loadBlackjackSessions()]);
}

async function loadBlackjackLedger() {
  try { const data = await api("/blackjack/ledger"); state.blackjackLedger = { totalCents: data.totalCents ?? 0, rows: data.rows ?? [] }; renderBlackjackLedger(); }
  catch (e) { renderErrorBox(el("blackjack-ledger-body"), friendlyMessage(/** @type {ApiError} */ (e), "Couldn't load the blackjack ledger."), loadBlackjackLedger); }
}

async function renderOverallDashboard() {
  showView("overall");
  fillViewerSelect();
  const body = el("overall-ledger-body");
  body.innerHTML = `<div class="skel skel-row"></div><div class="skel skel-row"></div>`;
  const membersOk = await loadMembers();
  if (!membersOk) { showBanner({ kind: "error", message: "Couldn't load the member list.", retryLabel: "Retry", onRetry: renderOverallDashboard }); return; }
  await Promise.allSettled([loadLedger(), loadSessions(true), loadBlackjackLedger(), loadBlackjackSessions(), loadHandshakeLedger(), loadHandshakeBets()]);
  renderOverallLedger();
}

/**
 * Merge the three per-game ledgers into one row per member, keeping each
 * game's contribution separately so the overall table can show a column
 * per game alongside the combined net.
 */
function buildOverallRows() {
  const byId = new Map();
  const ensure = (row) => {
    let cur = byId.get(row.memberId);
    if (!cur) {
      cur = { memberId: row.memberId, name: row.name, isViewer: false, pokerCents: 0, blackjackCents: 0, handshakeCents: 0, sessionsPlayed: 0 };
      byId.set(row.memberId, cur);
    }
    return cur;
  };
  for (const row of state.ledger?.rows ?? []) { const cur = ensure(row); cur.pokerCents += row.netCents; cur.sessionsPlayed += row.sessionsPlayed; cur.isViewer ||= row.isViewer; }
  for (const row of state.blackjackLedger?.rows ?? []) { const cur = ensure(row); cur.blackjackCents += row.netCents; cur.sessionsPlayed += row.sessionsPlayed; cur.isViewer ||= row.isViewer; }
  for (const row of state.handshakeLedger?.rows ?? []) { const cur = ensure(row); cur.handshakeCents += row.netCents; cur.isViewer ||= row.isViewer; }
  const rows = [...byId.values()].map((r) => ({ ...r, netCents: r.pokerCents + r.blackjackCents + r.handshakeCents }));
  rows.sort((a, b) => b.netCents - a.netCents || a.name.localeCompare(b.name));
  return rows;
}

function renderOverallLedger() {
  const body = el("overall-ledger-body");
  const rows = buildOverallRows();
  const viewerRow = rows.find((r) => r.isViewer) ?? null;
  const heading = el("overall-heading");
  if (viewerRow && viewerRow.netCents !== 0) {
    heading.innerHTML = `You're ${viewerRow.netCents > 0 ? "up" : "down"} <span class="${moneyClass(viewerRow.netCents)}">${esc(formatPlainCents(viewerRow.netCents))}</span> across everything`;
  } else if (viewerRow) {
    heading.textContent = "You're settled up across everything";
  } else {
    heading.textContent = "Overall ledger";
  }
  const statsEl = el("overall-stats");
  if (viewerRow) {
    statsEl.hidden = false;
    statsEl.innerHTML = [
      { label: "Poker", value: viewerRow.pokerCents },
      { label: "Blackjack", value: viewerRow.blackjackCents },
      { label: "Bets", value: viewerRow.handshakeCents },
    ].map((s) => `<div class="overall-stat"><div class="overall-stat-label">${esc(s.label)}</div><div class="overall-stat-value ${moneyClass(s.value)}">${esc(formatCents(s.value))}</div></div>`).join("");
  } else {
    statsEl.hidden = true;
    statsEl.innerHTML = "";
  }
  if (!rows.length) { body.innerHTML = `<p class="empty-state">No members yet.</p>`; return; }
  const activity = new Map(rows.map((r) => [r.memberId, []]));
  for (const s of state.sessions) for (const p of s.participants) activity.get(p.memberId)?.push({ date: s.playedAt, label: `Poker · ${s.title || "Session"}`, amount: p.amountCents });
  for (const s of state.blackjackSessions) for (const p of s.participants) activity.get(p.memberId)?.push({ date: s.playedAt, label: `Blackjack · ${s.title || "Session"}`, amount: p.amountCents });
  for (const b of state.handshakeBets) { const settled = b.status === "settled" && b.winnerMemberId; const firstAmount = settled ? (b.winnerMemberId === b.firstMemberId ? b.amountCents : -b.amountCents) : 0; const secondAmount = -firstAmount; activity.get(b.firstMemberId)?.push({ date: b.createdAt, label: `Handshake · ${b.description}`, amount: firstAmount, open: !settled }); activity.get(b.secondMemberId)?.push({ date: b.createdAt, label: `Handshake · ${b.description}`, amount: secondAmount, open: !settled }); }
  const cell = (cents, bold) => `<td class="num money ${moneyClass(cents)}${bold ? " overall-net-cell" : ""}">${esc(formatCents(cents))}</td>`;
  const bodyRows = rows.map((r) => {
    const items = (activity.get(r.memberId) ?? []).sort((a, b) => b.date.localeCompare(a.date));
    const history = items.length ? `<details class="ledger-history"><summary>Recent activity</summary><div class="ledger-history-list">${items.slice(0, 8).map((item) => `<div class="ledger-history-row"><span>${esc(new Date(item.date).toLocaleDateString(undefined, { month: "short", day: "numeric" }))} · ${esc(item.label)}</span><strong class="${item.open ? "zero" : moneyClass(item.amount)}">${item.open ? "Open" : esc(formatCents(item.amount))}</strong></div>`).join("")}</div></details>` : "";
    return `<tr class="${r.isViewer ? "row-you" : ""}"><td>${esc(r.name)}${r.isViewer ? '<span class="you-tag">you</span>' : ""}${history}</td>${cell(r.pokerCents)}${cell(r.blackjackCents)}${cell(r.handshakeCents)}${cell(r.netCents, true)}</tr>`;
  }).join("");
  const totals = rows.reduce((acc, r) => ({ poker: acc.poker + r.pokerCents, blackjack: acc.blackjack + r.blackjackCents, handshake: acc.handshake + r.handshakeCents, net: acc.net + r.netCents }), { poker: 0, blackjack: 0, handshake: 0, net: 0 });
  body.innerHTML = `<table class="results-table overall-table"><thead><tr><th>Player</th><th class="num">Poker</th><th class="num">Blackjack</th><th class="num">Handshake</th><th class="num">Overall net</th></tr></thead><tbody>${bodyRows}</tbody><tfoot><tr><td>Total</td><td class="num money">${esc(formatCents(totals.poker))}</td><td class="num money">${esc(formatCents(totals.blackjack))}</td><td class="num money">${esc(formatCents(totals.handshake))}</td><td class="num money">${esc(formatCents(totals.net))}</td></tr></tfoot></table>`;
}

function openOverallSettleModal() {
  const rows = buildOverallRows();
  const transfers = computeSettleUp(rows);
  const body = document.createElement("div");
  body.className = "stack";
  const list = transfers.length
    ? transfers.map((t) => `<div class="settle-row"><span class="settle-parties"><strong>${esc(t.fromName)}</strong> <span class="muted-inline">pays</span> <strong>${esc(t.toName)}</strong>${t.fromIsViewer || t.toIsViewer ? '<span class="you-tag">you</span>' : ""}</span><span class="settle-amount money">${esc(formatPlainCents(t.amountCents))}</span></div>`).join("")
    : `<p class="empty-state">Everyone is settled up.</p>`;
  body.innerHTML = `<p class="form-hint">Fewest transfers that clear every balance across poker, blackjack, and handshake bets.</p>${list}<div class="settle-actions"><button type="button" class="btn" id="overall-settle-copy">Copy as text</button><button type="button" class="btn btn-ghost" id="overall-settle-email">Email the group</button></div>`;
  openModal({ title: "Settle up", body });
  q(body, "#overall-settle-copy").addEventListener("click", async () => {
    const ok = await copyTextToClipboard(settleUpAsText(transfers, "Settle up — Overall"));
    showBanner({ kind: ok ? "info" : "error", message: ok ? "Copied settle-up instructions to your clipboard." : "Couldn't copy — try selecting the text manually." });
  });
  q(body, "#overall-settle-email").addEventListener("click", () => {
    const url = `mailto:?subject=${encodeURIComponent("Poker Ledger — settle up")}&body=${encodeURIComponent(settleUpAsText(transfers, "Settle up — Overall"))}`;
    window.location.href = url;
  });
}
function ledgerActivityDetails(memberId, kind) {
  const items = [];
  if (kind === "poker") for (const s of state.sessions) for (const p of s.participants) if (p.memberId === memberId) items.push({ date: s.playedAt, label: `Poker · ${s.title || "Session"}`, amount: p.amountCents });
  if (kind === "blackjack") for (const s of state.blackjackSessions) for (const p of s.participants) if (p.memberId === memberId) items.push({ date: s.playedAt, label: `Blackjack · ${s.title || "Session"}`, amount: p.amountCents });
  if (kind === "handshake") for (const b of state.handshakeBets) if (b.firstMemberId === memberId || b.secondMemberId === memberId) { const settled = b.status === "settled" && b.winnerMemberId; const amount = !settled ? 0 : b.winnerMemberId === memberId ? b.amountCents : -b.amountCents; items.push({ date: b.createdAt, label: `Handshake · ${b.description}`, amount, open: !settled }); }
  items.sort((a, b) => b.date.localeCompare(a.date));
  if (!items.length) return "";
  return `<details class="ledger-history"><summary>Recent activity</summary><div class="ledger-history-list">${items.slice(0, 8).map((item) => `<div class="ledger-history-row"><span>${esc(new Date(item.date).toLocaleDateString(undefined, { month: "short", day: "numeric" }))} · ${esc(item.label)}</span><strong class="${item.open ? "zero" : moneyClass(item.amount)}">${item.open ? "Open" : esc(formatCents(item.amount))}</strong></div>`).join("")}</div></details>`;
}

async function renderHandshakeDashboard() {
  showView("handshake"); fillViewerSelect();
  el("handshake-ledger-body").innerHTML = `<div class="skel skel-row"></div>`; el("handshake-bets-body").innerHTML = `<div class="skel skel-block"></div>`;
  await Promise.allSettled([loadHandshakeLedger(), loadHandshakeBets()]);
}
async function loadHandshakeLedger() { try { const d = await api("/handshake/ledger"); state.handshakeLedger = { totalCents: d.totalCents ?? 0, rows: d.rows ?? [] }; const b = el("handshake-ledger-body"); const head = `<div class="ledger-head"><span>Player</span><span class="num lh-net">Net</span></div>`; const total = `<div class="ledger-total"><span>Total</span><span class="money">${formatCents(0)}</span></div>`; const html = state.handshakeLedger.rows.map((r) => `<div class="ledger-row"><div class="lr-name">${esc(r.name)}${r.isViewer ? '<span class="you-tag">you</span>' : ""}</div><div class="lr-net money ${moneyClass(r.netCents)}">${esc(formatCents(r.netCents))}</div><div class="lr-meta">handshake bets${ledgerActivityDetails(r.memberId, "handshake")}</div></div>`).join(""); b.innerHTML = head + (html || `<p class="empty-state">No settled bets yet.</p>`) + total; } catch (e) { renderErrorBox(el("handshake-ledger-body"), friendlyMessage(/** @type {ApiError} */ (e), "Couldn't load handshake balances."), loadHandshakeLedger); } }
async function loadHandshakeBets() { try { const d = await api("/handshake/bets"); state.handshakeBets = d.bets ?? []; renderHandshakeBets(); if (state.gameTab === "handshake" || state.gameTab === "overall") await loadHandshakeLedger(); } catch (e) { renderErrorBox(el("handshake-bets-body"), friendlyMessage(/** @type {ApiError} */ (e), "Couldn't load handshake bets."), loadHandshakeBets); } }
function renderHandshakeBets() { const body = el("handshake-bets-body"); if (!state.handshakeBets.length) { body.innerHTML = `<p class="empty-state">No handshake bets yet.</p>`; return; } body.innerHTML = state.handshakeBets.map((b) => `<div class="request-item handshake-bet"><strong>${esc(b.description)}</strong><div class="request-meta">${esc(b.firstMember.name)} vs ${esc(b.secondMember.name)} · ${esc(formatCents(b.amountCents))}</div><div class="request-meta">${b.status === "open" ? "Open" : `Won by ${esc(b.winnerMember?.name ?? "Unknown")}`}</div>${b.status === "open" ? `<button class="btn btn-small btn-primary handshake-settle" data-id="${esc(b.id)}">Settle bet</button>` : ""}</div>`).join(""); body.querySelectorAll(".handshake-settle").forEach((node) => node.addEventListener("click", () => { const bet = state.handshakeBets.find((b) => b.id === node.getAttribute("data-id")); if (bet) openHandshakeSettleModal(bet); })); }
function openHandshakeSettleModal(bet) { const body = document.createElement("div"); body.className = "stack"; body.innerHTML = `<p class="form-hint">Choose the winner to settle this bet.</p><fieldset class="choice-fieldset"><legend class="field">Winner</legend><label class="choice-row"><input type="radio" name="hb-winner" value="${esc(bet.firstMember.id)}" checked> ${esc(bet.firstMember.name)}</label><label class="choice-row"><input type="radio" name="hb-winner" value="${esc(bet.secondMember.id)}"> ${esc(bet.secondMember.name)}</label></fieldset><div class="modal-actions"><button class="btn btn-ghost" type="button" id="hb-settle-cancel">Cancel</button><button class="btn btn-primary" type="button" id="hb-settle-submit">Settle bet</button></div>`; openModal({ title: "Settle handshake bet", body }); q(body, "#hb-settle-cancel").addEventListener("click", closeModal); q(body, "#hb-settle-submit").addEventListener("click", async () => { const winnerId = /** @type {HTMLInputElement|null} */ (body.querySelector("input[name=hb-winner]:checked"))?.value; if (!winnerId) return; try { await api(`/handshake/bets/${encodeURIComponent(bet.id)}/settle`, { method: "POST", body: { winnerMemberId: winnerId } }); closeModal(); await Promise.all([loadHandshakeLedger(), loadHandshakeBets()]); } catch (e) { showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't settle the bet.") }); } }); }
function openHandshakeModal() { if (!state.status?.viewer) { showBanner({ kind: "info", message: "Select your name first." }); return; } const others = state.members.filter((m) => m.id !== state.status?.viewer?.id); const body = document.createElement("div"); body.className = "stack"; body.innerHTML = `<label class="field" for="hb-description">What is the bet?</label><input id="hb-description" class="input" maxlength="200" placeholder="Losing team buys dinner"><label class="field" for="hb-amount">Amount</label><input id="hb-amount" class="input money" inputmode="decimal" placeholder="$25.00"><label class="field" for="hb-opponent">Other bettor</label><select id="hb-opponent" class="input">${others.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("")}</select><label class="check-row"><input id="hb-settle-now" type="checkbox"> Settle this bet now</label><div id="hb-winner-wrap" hidden><label class="field" for="hb-winner-now">Winner</label><select id="hb-winner-now" class="input"></select></div><div class="modal-actions"><button class="btn btn-ghost" type="button" id="hb-cancel">Cancel</button><button class="btn btn-primary" type="button" id="hb-submit">Save bet</button></div>`; openModal({ title: "Add handshake bet", body }); const opponent = /** @type {HTMLSelectElement} */ (q(body, "#hb-opponent")); const winner = /** @type {HTMLSelectElement} */ (q(body, "#hb-winner-now")); const syncWinnerChoices = () => { winner.innerHTML = `<option value="${esc(state.status.viewer.id)}">${esc(state.status.viewer.name)}</option>` + (opponent.value ? `<option value="${esc(opponent.value)}">${esc(others.find((m) => m.id === opponent.value)?.name ?? "Opponent")}</option>` : ""); }; syncWinnerChoices(); opponent.addEventListener("change", syncWinnerChoices); const settleNow = /** @type {HTMLInputElement} */ (q(body, "#hb-settle-now")); settleNow.addEventListener("change", () => { q(body, "#hb-winner-wrap").hidden = !settleNow.checked; }); q(body, "#hb-cancel").addEventListener("click", closeModal); q(body, "#hb-submit").addEventListener("click", async () => { const amount = parseDollarsToCents(field("hb-amount").value); if (!field("hb-description").value.trim() || amount == null || amount <= 0) return showBanner({ kind: "error", message: "Enter a description and positive amount." }); try { const created = await api("/handshake/bets", { method: "POST", body: { requestKey: crypto.randomUUID(), description: field("hb-description").value.trim(), amountCents: amount, firstMemberId: state.status.viewer.id, secondMemberId: opponent.value } }); if (settleNow.checked) await api(`/handshake/bets/${encodeURIComponent(created.id)}/settle`, { method: "POST", body: { winnerMemberId: winner.value } }); closeModal(); await Promise.all([loadHandshakeLedger(), loadHandshakeBets()]); } catch (e) { showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't save the bet.") }); } }); }

function renderBlackjackLedger() {
  const body = el("blackjack-ledger-body"); const ledger = state.blackjackLedger;
  const head = `<div class="ledger-head"><span>Player</span><span class="num lh-net">Net</span></div>`; const total = `<div class="ledger-total"><span>Total</span><span class="money">${formatCents(0)}</span></div>`;
  if (!ledger || ledger.rows.length === 0) { body.innerHTML = head + `<p class="empty-state">No blackjack sessions yet.</p>` + total; return; }
  body.innerHTML = head + ledger.rows.map((r) => `<div class="ledger-row"><div class="lr-name">${esc(r.name)}${r.isViewer ? '<span class="you-tag">you</span>' : ""}</div><div class="lr-net money ${moneyClass(r.netCents)}">${esc(formatCents(r.netCents))}</div><div class="lr-meta">${r.sessionsPlayed} ${r.sessionsPlayed === 1 ? "session" : "sessions"} · last played ${esc(r.lastPlayedAt ? formatDate(r.lastPlayedAt) : "never")}${ledgerActivityDetails(r.memberId, "blackjack")}</div></div>`).join("") + total;
}

async function loadBlackjackSessions() {
  try { const data = await api("/blackjack/sessions"); state.blackjackSessions = data.sessions ?? []; renderBlackjackSessions(); if (state.gameTab === "blackjack" || state.gameTab === "overall") renderBlackjackLedger(); }
  catch (e) { renderErrorBox(el("blackjack-sessions-body"), friendlyMessage(/** @type {ApiError} */ (e), "Couldn't load blackjack sessions."), loadBlackjackSessions); }
}

function renderBlackjackSessions() {
  const body = el("blackjack-sessions-body");
  if (!state.blackjackSessions.length) { body.innerHTML = `<p class="empty-state">No blackjack sessions yet.</p>`; return; }
  body.innerHTML = state.blackjackSessions.map((s) => { const date = new Date(s.playedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }); const players = s.participants.filter((p) => p.memberId !== s.recordedBy).length; return `<button class="session-card" type="button" data-blackjack-id="${esc(s.id)}"><span class="sess-date">${esc(date)}</span><span class="sess-summary">${players} player${players === 1 ? "" : "s"}</span><span class="sess-title">${esc(s.title || "Blackjack")}</span><span class="sess-chev">›</span></button>`; }).join("");
  body.querySelectorAll("[data-blackjack-id]").forEach((node) => node.addEventListener("click", () => openBlackjackDetail(node.getAttribute("data-blackjack-id"))));
}

function openBlackjackModal() {
  if (!state.status?.viewer) { showBanner({ kind: "info", message: "Select your name first — the selected profile must be the dealer." }); return; }
  const players = state.members.filter((m) => m.id !== state.status?.viewer?.id);
  const body = document.createElement("div"); body.className = "stack";
  body.innerHTML = `<div class="form-grid"><div><label class="field" for="bj-title">Session name (optional)</label><input id="bj-title" class="input" maxlength="120" placeholder="Friday blackjack"></div><div><label class="field" for="bj-date">Date</label><input id="bj-date" class="input" type="date" value="${new Date().toISOString().slice(0, 10)}"></div></div><fieldset class="part-fieldset"><legend class="field">Players and results</legend><p class="form-hint">Enter each player’s net result. Positive means the player won; negative means they lost. The dealer result is calculated automatically.</p><div id="bj-players"></div></fieldset><label class="check-row"><input id="bj-verify" type="checkbox"> I verify these results as the dealer.</label><div class="modal-actions"><button type="button" class="btn btn-ghost" id="bj-cancel">Cancel</button><button type="button" class="btn btn-primary" id="bj-submit">Save blackjack session</button></div>`;
  openModal({ title: "Add blackjack session", body, wide: true });
  const rows = players.map((m) => { const row = document.createElement("div"); row.className = "part-row"; row.innerHTML = `<span class="part-name">${esc(m.name)}</span><input class="input part-amount money" type="text" inputmode="decimal" placeholder="+$0.00 / -$0.00">`; q(body, "#bj-players").appendChild(row); return { memberId: m.id, amount: /** @type {HTMLInputElement} */ (q(row, ".part-amount")) }; });
  q(body, "#bj-cancel").addEventListener("click", closeModal);
  q(body, "#bj-submit").addEventListener("click", async () => { const verify = /** @type {HTMLInputElement} */ (q(body, "#bj-verify")); const results = rows.map((r) => ({ memberId: r.memberId, amountCents: parseDollarsToCents(r.amount.value) })).filter((r) => r.amountCents !== null); if (!verify.checked) return showBanner({ kind: "error", message: "Confirm that you verified the results as the dealer." }); if (results.length === 0) return showBanner({ kind: "error", message: "Enter at least one player result." }); const submit = /** @type {HTMLButtonElement} */ (q(body, "#bj-submit")); submit.disabled = true; try { await api("/blackjack/sessions", { method: "POST", body: { requestKey: crypto.randomUUID(), playedAt: new Date(`${field("bj-date").value}T12:00:00`).toISOString(), title: field("bj-title").value.trim() || undefined, verifiedDealer: true, players: results } }); closeModal(); await Promise.all([loadBlackjackLedger(), loadBlackjackSessions()]); } catch (e) { showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't save the blackjack session.") }); submit.disabled = false; } });
}

async function openBlackjackDetail(id, opts = {}) {
  if (!id) return;
  if (opts.push !== false) pushAppUrl({ tab: "blackjack", session: id });
  try { const data = await api(`/blackjack/sessions/${encodeURIComponent(id)}`); const s = data.session; const body = document.createElement("div"); body.className = "card detailwrap"; body.innerHTML = `<button class="detail-back" type="button">← Back to Blackjack</button><div class="detail-head"><h2>${esc(s.title || "Blackjack session")}</h2><span class="status-chip">${new Date(s.playedAt).toLocaleDateString()}</span></div><p class="detail-meta">Dealer: ${esc(s.participants.find((p) => p.memberId === s.dealerMemberId)?.name || "Unknown")}</p><div class="detail-results">${s.participants.map((p) => `<div class="detail-result"><span>${esc(p.name)}</span><strong class="${p.amountCents > 0 ? "positive" : p.amountCents < 0 ? "negative" : "zero"}">${esc(formatCents(p.amountCents))}</strong></div>`).join("")}</div>`; showView("detail"); el("detail-body").innerHTML = ""; el("detail-body").appendChild(body); q(body, ".detail-back").addEventListener("click", () => { pushAppUrl({ tab: "blackjack" }); renderBlackjackDashboard(); }); } catch (e) { showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't load the blackjack session.") }); }
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
  sel.hidden = false;
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
        <div class="lr-meta">${esc(played)} · last played ${esc(last)}${ledgerActivityDetails(r.memberId, "poker")}</div>
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
    if (state.gameTab === "poker" || state.gameTab === "overall") renderLedger();
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

function openRebuyChooser(sessionId, participant) {
  const body = document.createElement("div"); body.className = "stack";
  body.innerHTML = `<p class="form-hint">Choose a common buy-in amount for ${esc(participant.name)}.</p><div class="choice-grid">${[20, 30, 40, 50].map((amount) => `<button type="button" class="btn btn-primary rebuy-choice" data-amount="${amount}">$${amount}</button>`).join("")}<button type="button" class="btn btn-ghost rebuy-custom">Custom</button></div><div id="rebuy-custom-wrap" class="stack" hidden><label class="field" for="rebuy-custom-amount">Custom amount</label><div class="field-row"><input id="rebuy-custom-amount" class="input money" type="text" inputmode="decimal" placeholder="$0.00" autocomplete="off"><button type="button" class="btn btn-primary" id="rebuy-custom-submit">Add</button></div><p id="rebuy-custom-error" class="form-error" role="alert" hidden></p></div><div class="modal-actions"><button type="button" class="btn btn-ghost rebuy-cancel">Cancel</button></div>`;
  openModal({ title: "Add buy-in", body });
  q(body, ".rebuy-cancel").addEventListener("click", closeModal);
  const customWrap = /** @type {HTMLElement} */ (q(body, "#rebuy-custom-wrap"));
  const customInput = /** @type {HTMLInputElement} */ (q(body, "#rebuy-custom-amount"));
  const customError = /** @type {HTMLElement} */ (q(body, "#rebuy-custom-error"));
  q(body, ".rebuy-custom").addEventListener("click", () => {
    customWrap.hidden = false;
    customInput.focus();
  });
  const submitCustom = () => {
    const cents = parseDollarsToCents(customInput.value);
    if (cents == null || cents <= 0) {
      customError.textContent = "Enter an amount like 20 or 20.00.";
      customError.hidden = false;
      customInput.focus();
      return;
    }
    customError.hidden = true;
    closeModal();
    saveRebuy(sessionId, participant.memberId, cents);
  };
  q(body, "#rebuy-custom-submit").addEventListener("click", submitCustom);
  customInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      submitCustom();
    }
  });
  body.querySelectorAll(".rebuy-choice").forEach((button) => button.addEventListener("click", () => { const cents = Number(button.getAttribute("data-amount")) * 100; closeModal(); saveRebuy(sessionId, participant.memberId, cents); }));
}

async function saveRebuy(sessionId, memberId, amountCents) {
  try { await api(`/live/${encodeURIComponent(sessionId)}/buyins`, { method: "POST", body: { memberId, amountCents } }); await refreshStatus(); route(); }
  catch (e) { showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't add the rebuy.") }); }
}

function openLiveModal() {
  if (!state.live) return;
  const body = document.createElement("div"); body.className = "stack live-panel";
  const live = state.live;
  body.innerHTML = `<div class="live-modal-tools"><p class="form-hint">Update a player’s cash-out when they leave. Rebuys are added to the same player.</p><button type="button" class="btn btn-live btn-small" id="live-add-player">+ Add player</button></div><div class="live-player-list"></div><div class="modal-actions"><button type="button" class="btn btn-ghost" id="live-close">Close</button><button type="button" class="btn btn-primary" id="live-end">End session</button></div>`;
  const list = q(body, ".live-player-list");
  for (const p of live.participants) {
    const row = document.createElement("div"); row.className = "live-player-row";
    row.innerHTML = `<div class="live-player-main"><strong>${esc(p.name)}</strong><span class="form-hint">Bought in ${esc(formatCents(p.buyInCents))}</span></div><div class="live-player-actions"><button type="button" class="btn btn-ghost btn-small live-rebuy">+ Rebuy</button><input class="input live-cashout" type="text" inputmode="decimal" placeholder="Cash-out" value="${esc(moneyInputValue(p.cashOutCents))}"><span class="live-saved" aria-live="polite"></span></div>`;
    const cash = /** @type {HTMLInputElement} */ (q(row, ".live-cashout"));
    q(row, ".live-rebuy").addEventListener("click", () => openRebuyChooser(live.session.id, p));
    cash.addEventListener("change", async () => { const cents = parseDollarsToCents(cash.value); if (cents == null || cents < 0) return; const saved = q(row, ".live-saved"); try { await api(`/live/${encodeURIComponent(live.session.id)}/cashouts`, { method: "PATCH", body: { memberId: p.memberId, amountCents: cents } }); saved.textContent = "Saved"; window.setTimeout(() => { saved.textContent = ""; }, 1500); } catch (e) { showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't save the cash-out.") }); } });
    list.appendChild(row);
  }
  q(body, "#live-close").addEventListener("click", closeModal);
  q(body, "#live-add-player").addEventListener("click", () => openLiveAddPlayerChooser(live.session.id, live.participants.map((p) => p.memberId)));
  q(body, "#live-end").addEventListener("click", async () => { try { await api(`/live/${encodeURIComponent(live.session.id)}/end`, { method: "POST", body: {} }); closeModal(); await refreshStatus(); route(); showBanner({ kind: "info", message: "Live session ended and added to the ledger." }); } catch (e) { showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't end the live session.") }); } });
  openModal({ title: live.session.title || "Live session", body, wide: true });
}

function openLiveAddPlayerChooser(sessionId, existingIds) {
  const available = state.members.filter((m) => !existingIds.includes(m.id));
  if (!available.length) { showBanner({ kind: "info", message: "Everyone is already in this live session." }); return; }
  const body = document.createElement("div"); body.className = "stack";
  body.innerHTML = `<label class="field" for="live-new-player">Player</label><select id="live-new-player" class="input">${available.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("")}</select><p class="form-hint">Choose their starting buy-in.</p><div class="choice-grid">${[20, 30, 40, 50].map((amount) => `<button type="button" class="btn btn-primary live-add-choice" data-amount="${amount}">$${amount}</button>`).join("")}<button type="button" class="btn btn-ghost live-add-custom">Custom</button></div><div class="modal-actions"><button type="button" class="btn btn-ghost live-add-cancel">Cancel</button></div>`;
  openModal({ title: "Add player to live session", body });
  q(body, ".live-add-cancel").addEventListener("click", closeModal);
  const save = (cents) => { const memberId = field("live-new-player").value; closeModal(); void saveLivePlayer(sessionId, memberId, cents); };
  body.querySelectorAll(".live-add-choice").forEach((button) => button.addEventListener("click", () => save(Number(button.getAttribute("data-amount")) * 100)));
  q(body, ".live-add-custom").addEventListener("click", () => { const raw = prompt("Starting buy-in", ""); const cents = raw == null ? null : parseDollarsToCents(raw); if (cents && cents > 0) save(cents); });
}

async function saveLivePlayer(sessionId, memberId, amountCents) {
  try { await api(`/live/${encodeURIComponent(sessionId)}/buyins`, { method: "POST", body: { memberId, amountCents } }); await refreshStatus(); route(); }
  catch (e) { showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't add the player.") }); }
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
      <input type="text" inputmode="text" class="input part-amount money" data-id="${esc(e.id)}" aria-label="Amount for ${esc(e.name)}" placeholder="+0.00 or -0.00" autocomplete="off" hidden>`;
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
function showSessionDetail(id, opts = {}) {
  if (opts.push !== false) pushAppUrl({ tab: state.gameTab, session: id });
  showView("detail");
  const body = el("detail-body");
  body.innerHTML = `
    <button type="button" class="detail-back" id="detail-back">← Back to sessions</button>
    <div class="card card-narrow" id="detail-card">
      <div class="spinner" aria-hidden="true"></div>
      <p class="loading-text">Loading session…</p>
    </div>`;
  q(body, "#detail-back").addEventListener("click", () => {
    pushAppUrl({ tab: state.gameTab });
    renderDashboard();
  });
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
    try { adminMembers = (await api("/admin/members")).members ?? []; }
    catch {
      renderErrorBox(listWrap, "Couldn't load members.", refreshList);
      return;
    }
    // Admin sees everyone here, but the viewer picker and session forms must
    // only ever offer active members — resync state.members from /members
    // (active-only) so opening this panel can't leak a deactivated member
    // into those pickers.
    await loadMembers();
    listWrap.innerHTML = "";
    const active = adminMembers.filter((m) => m.status === "active");
    const inactive = adminMembers.filter((m) => m.status !== "active");
    if (active.length === 0 && inactive.length === 0) {
      const p = document.createElement("p");
      p.className = "empty-state";
      p.textContent = "No members yet — add the first one above.";
      listWrap.appendChild(p);
      return;
    }
    if (active.length === 0) {
      const p = document.createElement("p");
      p.className = "empty-state";
      p.textContent = "No active members — add one above, or reactivate someone below.";
      listWrap.appendChild(p);
    } else {
      for (const m of active) {
        listWrap.appendChild(buildMemberRow(m, refreshList));
      }
    }
    if (inactive.length > 0) {
      const hint = document.createElement("p");
      hint.className = "form-hint member-section-hint";
      hint.textContent = "Deactivated — hidden from the viewer picker and session forms until reactivated.";
      listWrap.appendChild(hint);
      for (const m of inactive) {
        listWrap.appendChild(buildMemberRow(m, refreshList));
      }
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
  row.className = "member-row" + (m.status === "active" ? "" : " member-row-inactive");
  const name = document.createElement("span");
  name.className = "part-name";
  name.textContent = m.name;
  row.appendChild(name);
  if (m.status !== "active") {
    const tag = document.createElement("span");
    tag.className = "member-inactive-tag";
    tag.textContent = "Deactivated";
    row.appendChild(tag);
  }
  const edit = document.createElement("button");
  edit.type = "button"; edit.className = "btn btn-small"; edit.textContent = "Edit";
  edit.addEventListener("click", () => {
    const body = document.createElement("form"); body.className = "stack";
    body.innerHTML = `<label class="field">Display name<input class="input" id="edit-member-name" value="${esc(m.name)}" maxlength="80" required></label><label class="field">Email<input class="input" id="edit-member-email" type="email" value="${esc(m.email ?? "")}" placeholder="Optional"></label><button class="btn btn-primary" type="submit">Save changes</button>`;
    body.addEventListener("submit", async (ev) => { ev.preventDefault(); const n = body.querySelector("#edit-member-name").value.trim(); const e = body.querySelector("#edit-member-email").value.trim(); if (!n || (e && !EMAIL_RE.test(e))) return; try { await api(`/admin/members/${encodeURIComponent(m.id)}`, { method: "PATCH", body: { displayName: n, email: e } }); closeModal(); await refresh(); showBanner({ kind: "info", message: "Member updated." }); } catch (err) { showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (err), "Couldn't update the member.") }); } });
    openModal({ title: "Edit member", body });
  });
  row.appendChild(edit);
  if (m.status === "active") {
    const deact = document.createElement("button");
    deact.type = "button";
    deact.className = "btn btn-small btn-danger";
    deact.textContent = "Deactivate";
    let armed = false;
    let armTimer = 0;
    deact.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        deact.textContent = "Click again to confirm";
        deact.classList.add("btn-danger-solid");
        armTimer = window.setTimeout(() => {
          armed = false;
          deact.textContent = "Deactivate";
          deact.classList.remove("btn-danger-solid");
        }, 4000);
        return;
      }
      window.clearTimeout(armTimer);
      deact.disabled = true;
      deact.textContent = "Deactivating…";
      try {
        await api(`/admin/members/${encodeURIComponent(m.id)}`, { method: "PATCH", body: { status: "inactive" } });
        showBanner({ kind: "info", message: `${m.name} was deactivated. Reactivate them anytime from this list.` });
        await refresh();
      } catch (e) {
        armed = false;
        deact.disabled = false;
        deact.textContent = "Deactivate";
        deact.classList.remove("btn-danger-solid");
        showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't deactivate the member.") });
      }
    });
    row.appendChild(deact);
  } else {
    const react = document.createElement("button");
    react.type = "button";
    react.className = "btn btn-small btn-primary";
    react.textContent = "Reactivate";
    react.addEventListener("click", async () => {
      react.disabled = true;
      react.textContent = "Reactivating…";
      try {
        await api(`/admin/members/${encodeURIComponent(m.id)}`, { method: "PATCH", body: { status: "active" } });
        showBanner({ kind: "info", message: `${m.name} was reactivated.` });
        await refresh();
      } catch (e) {
        react.disabled = false;
        react.textContent = "Reactivate";
        showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't reactivate the member.") });
      }
    });
    row.appendChild(react);
  }
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
  if (livePollTimer) {
    clearInterval(livePollTimer);
    livePollTimer = null;
  }
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
    clearSkippedNamePrompt();
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

/* ── Name prompt (ask once at login) ──────────────────────── */

const NAME_PROMPT_SKIP_KEY = "pokerSkipNamePrompt";

function hasSkippedNamePrompt() {
  try {
    return localStorage.getItem(NAME_PROMPT_SKIP_KEY) === "1";
  } catch {
    return false;
  }
}

function setSkippedNamePrompt() {
  try {
    localStorage.setItem(NAME_PROMPT_SKIP_KEY, "1");
  } catch {
    /* ignore — private browsing / storage disabled */
  }
}

function clearSkippedNamePrompt() {
  try {
    localStorage.removeItem(NAME_PROMPT_SKIP_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Ask once, right after logging in, who's using this device — instead of
 * letting people discover the requirement piecemeal via guard banners on
 * whichever action they try first. Only called right after a fresh login
 * (onGateUnlock) or a returning page load (init), so it never re-nags
 * mid-session; the existing per-action banners remain as a fallback for
 * anyone who dismisses or skips it.
 */
async function maybeShowNamePrompt() {
  if (!state.status?.group || state.status.viewer || state.token || hasSkippedNamePrompt() || activeModal) return;
  let members;
  try {
    members = (await api("/members")).members ?? [];
  } catch {
    return;
  }
  if (members.length === 0 || state.status?.viewer || state.token || hasSkippedNamePrompt() || activeModal) return;
  state.members = members;
  // This is a single-account ledger: use the first active member as the
  // account identity instead of prompting for a profile.
  await api("/viewer", { method: "POST", body: { memberId: members[0].id } });
  await refreshStatus();
  route();
  return;
  fillViewerSelect();

  const body = document.createElement("div");
  body.className = "stack";
  body.innerHTML = `
    <p class="form-hint">Pick your name so sessions you record are marked as yours. You can change this anytime from the top bar.</p>
    <label class="field" for="name-prompt-select">Your name</label>
    <select id="name-prompt-select" class="input">
      <option value="">Select your name…</option>
      ${members.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("")}
    </select>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" id="name-prompt-skip">Just checking balances</button>
      <button type="button" class="btn btn-primary" id="name-prompt-submit" disabled>Continue</button>
    </div>`;
  openModal({ title: "Who are you?", body });
  const select = /** @type {HTMLSelectElement} */ (q(body, "#name-prompt-select"));
  const submit = /** @type {HTMLButtonElement} */ (q(body, "#name-prompt-submit"));
  select.addEventListener("change", () => {
    submit.disabled = !select.value;
  });
  q(body, "#name-prompt-skip").addEventListener("click", () => {
    setSkippedNamePrompt();
    closeModal();
  });
  submit.addEventListener("click", async () => {
    if (!select.value) return;
    submit.disabled = true;
    const label = submit.textContent;
    submit.textContent = "Saving…";
    try {
      const data = await api("/viewer", { method: "POST", body: { memberId: select.value } });
      if (state.status) {
        state.status = { ...state.status, viewer: data?.viewer ?? null };
      }
      clearSkippedNamePrompt();
      fillViewerSelect();
      closeModal();
      route();
    } catch (e) {
      submit.disabled = false;
      submit.textContent = label ?? "Continue";
      showBanner({ kind: "error", message: friendlyMessage(/** @type {ApiError} */ (e), "Couldn't save your name — pick it from the top bar instead.") });
    }
  });
}

/* ── Init ──────────────────────────────────────────────────── */

function wireStatic() {
  window.addEventListener("popstate", () => route());
  el("gate-form").addEventListener("submit", onGateUnlock);
  el("gate-request-form").addEventListener("submit", onRequestSubmit);
  el("gate-admin-form").addEventListener("submit", onAdminUnlock);
  wireCollapsible("gate-request-toggle", "gate-request-form");
  wireCollapsible("gate-admin-toggle", "gate-admin-form");
  el("dash-admin-form-inner").addEventListener("submit", onDashAdminUnlock);
  wireCollapsible("dash-admin-toggle", "dash-admin-form");
  /** @type {HTMLButtonElement} */ (el("logout-btn")).addEventListener("click", onLogout);
  el("feedback-btn").addEventListener("click", openFeedbackModal);
  /** @type {HTMLButtonElement} */ (el("add-session-btn")).addEventListener("click", onAddSession);
  el("start-live-btn").addEventListener("click", openStartLiveModal);
  el("live-banner").addEventListener("click", openLiveModal);
  el("add-blackjack-btn").addEventListener("click", openBlackjackModal);
  el("tab-poker").addEventListener("click", () => goToTab("poker"));
  el("tab-blackjack").addEventListener("click", () => goToTab("blackjack"));
  el("tab-overall").addEventListener("click", () => goToTab("overall"));
  el("add-handshake-btn").addEventListener("click", openHandshakeModal);
  el("tab-handshake").addEventListener("click", () => goToTab("handshake"));
  /** @type {HTMLButtonElement} */ (el("badge-requests")).addEventListener("click", openRequestsPanel);
  /** @type {HTMLButtonElement} */ (el("badge-disputes")).addEventListener("click", openDisputesPanel);
  /** @type {HTMLButtonElement} */ (el("badge-members")).addEventListener("click", openMembersPanel);
  /** @type {HTMLButtonElement} */ (el("admin-lock-btn")).addEventListener("click", onAdminLock);
}

/**
 * Switch the active game tab and reflect it in the URL so the tab (and,
 * via route(), any open session detail) stays deep-linkable and survives
 * a refresh or the browser back/forward buttons.
 * @param {string} tab
 */
function goToTab(tab) {
  state.gameTab = tab;
  pushAppUrl({ tab });
  route();
}

function updateGameTabs() {
  for (const tab of ["overall", "poker", "handshake", "blackjack"]) {
    const active = state.gameTab === tab;
    const node = el(`tab-${tab}`);
    node.classList.toggle("is-active", active);
    node.setAttribute("aria-selected", String(active));
  }
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
  void maybeShowNamePrompt();
}

init();
