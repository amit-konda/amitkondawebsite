"use strict";

const API = "/api/split";
const app = document.querySelector("#app");
const notices = document.querySelector("#notice-root");
const headerActions = document.querySelector("#header-actions");
const bottomNav = document.querySelector("#bottom-nav");

const state = {
  me: null,
  demo: false,
  dashboard: null,
  draft: null,
  invitation: null,
  phone: "",
};

const demoDashboard = {
  summary: { owedByYouCents: 4832, owedToYouCents: 12640, outstandingCount: 3 },
  bills: [
    { id: "demo-1", merchant: "Loro", date: "2026-09-10", totalCents: 18640, yourAmountCents: 4832, role: "participant", status: "unpaid" },
    { id: "demo-2", merchant: "Suerte", date: "2026-09-06", totalCents: 22410, yourAmountCents: 12640, role: "organizer", status: "open", participantCount: 5 },
    { id: "demo-3", merchant: "Home Slice", date: "2026-08-28", totalCents: 7890, yourAmountCents: 2630, role: "participant", status: "settled" },
  ],
};

function esc(value) {
  return String(value ?? "").replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
}
function money(cents = 0) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(cents) / 100);
}
function dateLabel(value) {
  if (!value) return "Date not set";
  const parsed = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.valueOf()) ? String(value) : parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function initials(name = "You") { return name.split(/\s+/).slice(0, 2).map(x => x[0]).join("").toUpperCase(); }
function parseCents(value) { return Math.round((Number.parseFloat(value) || 0) * 100); }
function getRoute() { return location.hash.replace(/^#\/?/, "").split("/").filter(Boolean); }
function go(path) { location.hash = `#/${path.replace(/^\//, "")}`; }
function setBusy(button, busy, label = "Working…") { if (!button) return; if (busy) { button.dataset.label = button.textContent; button.textContent = label; button.disabled = true; } else { button.textContent = button.dataset.label || button.textContent; button.disabled = false; } }

async function api(path, options = {}) {
  const binaryBody = options.body instanceof Blob || options.body instanceof ArrayBuffer;
  const init = { credentials: "same-origin", ...options, headers: { Accept: "application/json", ...(options.body && !(options.body instanceof FormData) && !binaryBody ? { "Content-Type": "application/json" } : {}), ...options.headers } };
  if (init.body && !(init.body instanceof FormData) && !binaryBody && typeof init.body !== "string") init.body = JSON.stringify(init.body);
  const response = await fetch(`${API}${path}`, init);
  const type = response.headers.get("content-type") || "";
  const data = type.includes("json") ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.message || `Request failed (${response.status})`);
    error.status = response.status; error.data = data; throw error;
  }
  return data;
}

function notice(message, type = "success") {
  const node = document.createElement("div");
  node.className = `notice ${type}`;
  node.innerHTML = `<span>${esc(message)}</span><button type="button" aria-label="Dismiss">×</button>`;
  node.querySelector("button").addEventListener("click", () => node.remove());
  notices.append(node);
  window.setTimeout(() => node.remove(), 5500);
}

function shell(loggedIn = Boolean(state.me)) {
  headerActions.innerHTML = loggedIn ? `<button class="text-btn" type="button" data-action="logout">Log out</button><button class="avatar" type="button" data-action="profile" aria-label="Account for ${esc(state.me?.displayName || state.me?.name || "you")}">${esc(initials(state.me?.displayName || state.me?.name))}</button>` : `<a class="text-btn" href="/">amitkonda.com ↗</a>`;
  bottomNav.hidden = !loggedIn;
  headerActions.querySelector('[data-action="logout"]')?.addEventListener("click", logout);
  headerActions.querySelector('[data-action="profile"]')?.addEventListener("click", () => go("profile"));
}

async function bootstrap() {
  const invite = new URLSearchParams(location.search).get("invite");
  if (invite) sessionStorage.setItem("split_invite", invite);
  try {
    let result;
    try { result = await api("/auth/status"); } catch (error) { if (error.status !== 404) throw error; result = await api("/me"); }
    state.me = result.user || result.me || (result.id ? result : null);
  } catch (error) {
    if (![401, 404].includes(error.status)) notice("Split couldn’t connect. You can still preview the experience.", "error");
  }
  // Google returns to the app root. Preserve an invite opened before sign-in
  // so a guest lands directly on the receipt instead of finding the invite
  // again in a message.
  const pendingInvite = sessionStorage.getItem("split_invite");
  if (state.me && pendingInvite && !getRoute().length) return go(`invite/${encodeURIComponent(pendingInvite)}`);
  route();
}

async function logout() {
  try { await api("/auth/logout", { method: "POST" }); } catch (_) { /* session still cleared locally */ }
  state.me = null; state.demo = false; state.dashboard = null; go("welcome");
}

function authView(step = "phone") {
  shell(false);
  const verifying = step === "verify";
  app.innerHTML = `<section class="auth-view">
    <div class="auth-copy">
      <p class="eyebrow">Dinner math, done</p>
      <h1>Pass the plates.<br>Not the calculator.</h1>
      <p class="lede">Sign in once, then upload a receipt, let everyone claim what they ordered, and gently nudge the stragglers.</p>
      <div class="mini-receipt" aria-hidden="true"><strong>FRIDAY DINNER</strong><p>3 friends · good food<br>1 receipt · no awkward math</p><div class="row-between receipt-total"><span>TOTAL</span><span>settled ✓</span></div></div>
    </div>
    <div class="card auth-card">
      ${verifying ? `<p class="eyebrow">Check your phone</p><h2>Enter your code</h2><p class="muted">We sent a 6-digit code to ${esc(state.phone)}.</p>
        <form id="verify-form" class="stack">
          <label class="field"><span>Verification code</span><input class="input" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" pattern="[0-9]{4,8}" placeholder="123456" required autofocus></label>
          <label class="field"><span>Your name <em class="muted small">(new accounts)</em></span><input class="input" name="name" autocomplete="name" maxlength="80" placeholder="Alex"></label>
          <button class="btn btn-primary btn-block" type="submit">Continue</button>
          <button class="demo-link" type="button" data-action="resend-code">Resend code</button>
          <button class="demo-link" type="button" data-action="change-phone">Use a different number</button>
        </form>` : `<p class="eyebrow">Welcome to Split</p><h2>Sign in to start splitting</h2><p class="muted">Enter your phone number and we’ll text you a secure code. It takes a few seconds.</p>
        <form id="phone-form" class="stack">
          <label class="field"><span>Phone number</span><span class="phone-row"><input class="input country-code" value="+1" aria-label="Country code" readonly><input class="input" name="phone" type="tel" autocomplete="tel-national" inputmode="tel" placeholder="(512) 555-0148" required autofocus></span></label>
          <button class="btn btn-primary btn-block" type="submit">Text me a code</button>
          <p class="fine-print">By continuing, you agree to receive transactional texts about bills you join. Message and data rates may apply. Reply STOP to opt out.</p>
        </form>
        <button class="demo-link" type="button" data-action="demo">Preview with sample data</button>`}
    </div>
  </section>`;
  document.querySelector("#phone-form")?.addEventListener("submit", startAuth);
  document.querySelector("#verify-form")?.addEventListener("submit", verifyAuth);
  document.querySelector('#verify-form input[name="code"]')?.addEventListener("input", event => {
    const input = event.currentTarget;
    if (/^\d{6}$/.test(input.value)) input.form?.requestSubmit();
  });
  document.querySelector('[data-action="resend-code"]')?.addEventListener("click", resendCode);
  document.querySelector('[data-action="change-phone"]')?.addEventListener("click", () => authView());
  document.querySelector('[data-action="demo"]')?.addEventListener("click", () => { state.demo = true; state.me = { id: "demo-user", name: "Alex", hasPhone: true }; go("dashboard"); });
}

async function resendCode(event) {
  const button = event.currentTarget;
  setBusy(button, true, "Sending…");
  try { await api("/auth/start", { method: "POST", body: { phone: state.phone } }); notice("A new code is on its way."); }
  catch (error) { notice(error.message, "error"); }
  finally { setBusy(button, false); }
}

async function startAuth(event) {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector("button[type=submit]");
  let digits = String(new FormData(form).get("phone") || "").replace(/\D/g, "");
  // Accept the common pasted +1 format even though the country code has its
  // own field in the compact phone form.
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return notice("Enter a 10-digit US phone number.", "error");
  state.phone = `+1${digits}`;
  setBusy(button, true, "Sending…");
  try { await api("/auth/start", { method: "POST", body: { phone: state.phone } }); authView("verify"); }
  catch (error) { notice(error.message, "error"); setBusy(button, false); }
}
async function verifyAuth(event) {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector("button[type=submit]"); const values = Object.fromEntries(new FormData(form));
  setBusy(button, true, "Checking…");
  try {
    const result = await api("/auth/verify", { method: "POST", body: { phone: state.phone, code: values.code, displayName: values.name || undefined } });
    state.me = result.user || result.me || result; notice("You’re in.");
    const invite = sessionStorage.getItem("split_invite"); go(invite ? `invite/${invite}` : "dashboard");
  } catch (error) { notice(error.message, "error"); setBusy(button, false); }
}

function dashboardLoading() {
  shell(true); app.innerHTML = `<div class="page-head"><div><p class="eyebrow">Your table</p><h1>Good evening.</h1></div></div><div class="summary-grid"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div><div class="bill-list"><div class="skeleton"></div><div class="skeleton"></div></div>`;
}
async function dashboardView() {
  dashboardLoading();
  try { if (!state.dashboard) state.dashboard = state.demo ? demoDashboard : await api("/dashboard"); renderDashboard(state.dashboard); }
  catch (error) { renderError("We couldn’t load your dinners.", error.message, dashboardView); }
}
function normalizeBills(data) {
  if (data?.bills) return data.bills;
  if (data?.organized || data?.participating) {
    const rows = new Map();
    for (const bill of data.organized || []) rows.set(bill.id, { ...bill, role: "organizer" });
    for (const row of data.participating || []) if (!rows.has(row.bill.id)) rows.set(row.bill.id, { ...row.bill, participant: row.participant, role: "participant", yourAmountCents: row.participant?.finalAmountCents, paymentStatus: row.participant?.paymentStatus });
    return [...rows.values()].sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0));
  }
  return [...(data?.outstanding || []), ...(data?.past || [])];
}
function renderDashboard(data) {
  shell(true); const bills = normalizeBills(data); const summary = data.summary || data.totals || {};
  app.innerHTML = `<div class="page-head"><div class="page-head-copy"><p class="eyebrow">Your table</p><h1>${greeting()}, ${esc((state.me?.displayName || state.me?.name || "friend").split(" ")[0])}.</h1><p class="lede">Here’s who owes what—without digging through the group chat.</p></div><button class="btn btn-primary" type="button" data-action="new-bill">Scan a receipt</button></div>
    <section class="summary-grid" aria-label="Balance summary">
      <div class="card summary-card"><span class="muted small">Open dinners</span><strong class="amount">${Number(summary.outstandingCount ?? bills.filter(x => !["paid","settled"].includes(x.status)).length)}</strong></div>
      <div class="card summary-card owe"><span class="muted small">You owe</span><strong class="amount">${money(summary.owedByYouCents ?? summary.youOweCents)}</strong></div>
      <div class="card summary-card owed"><span class="muted small">Owed to you</span><strong class="amount">${money(summary.owedToYouCents ?? summary.youAreOwedCents)}</strong></div>
    </section>
    <section class="section"><div class="section-head"><h2>Recent dinners</h2>${bills.length ? `<span class="muted small">${bills.length} receipt${bills.length === 1 ? "" : "s"}</span>` : ""}</div>
      ${bills.length ? `<div class="bill-list">${bills.map(billRow).join("")}</div>` : emptyDashboard()}
    </section>`;
  bindCommon();
}
function greeting() { const h = new Date().getHours(); return h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening"; }
function billRow(b) {
  const status = b.paymentStatus || b.status || "open"; const sub = b.role === "organizer" ? `${b.participantCount || 0} people · you paid` : "Your share";
  const merchant=b.merchantName||b.merchant||"Untitled receipt";
  return `<a class="bill-row" href="#/bill/${encodeURIComponent(b.id)}"><span class="merchant-icon">${esc(merchant[0])}</span><span class="bill-meta"><h3>${esc(merchant)}</h3><p>${esc(dateLabel(b.purchasedAt || b.date || b.receiptDate))} · ${esc(sub)}</p></span><span class="status ${esc(status)}">${esc(status.replaceAll("_", " "))}</span><span class="bill-amount">${money(b.yourAmountCents ?? b.totalCents)}<small>${b.role === "organizer" ? `${money(b.totalCents)} total` : "your total"}</small></span></a>`;
}
function emptyDashboard() { return `<div class="card empty-state"><div class="empty-icon" aria-hidden="true">⌁</div><h2>No receipt drama yet</h2><p class="muted">Upload your first dinner receipt and invite everyone to claim their items.</p><button class="btn btn-primary" data-action="new-bill" type="button">Split your first bill</button></div>`; }

function profileView() {
  shell(true);
  app.innerHTML = `<a class="back-link" href="#/dashboard">← Back to dashboard</a><div class="page-head"><div><p class="eyebrow">Account</p><h1>${esc(state.me?.displayName || state.me?.name || "Your account")}</h1><p class="lede">Add a verified phone so Split can send dinner invites and payment reminders.</p></div></div><section class="card card-pad"><h2>${state.me?.hasPhone ? "Phone number linked" : "Link your phone"}</h2><p class="muted">Your number stays private and is only used for transactional Split texts.</p><form id="link-phone-form" class="stack"><label class="field"><span>Phone number</span><input class="input" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(214) 940-0587" required></label><button class="btn btn-primary" type="submit">Text me a code</button></form></section>`;
  document.querySelector("#link-phone-form").addEventListener("submit", linkPhoneStart);
}
async function linkPhoneStart(event) {
  event.preventDefault(); const form = event.currentTarget; const phone = new FormData(form).get("phone");
  try { await api("/auth/phone/link/start", { method: "POST", body: { phone } }); form.innerHTML = `<label class="field"><span>Verification code</span><input class="input" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required></label><button class="btn btn-primary" type="submit">Verify phone</button>`; form.addEventListener("submit", e => linkPhoneVerify(e, phone), { once: true }); notice("Code sent."); } catch (error) { notice(error.message, "error"); }
}
async function linkPhoneVerify(event, phone) {
  event.preventDefault(); const code = new FormData(event.currentTarget).get("code");
  try { await api("/auth/phone/link/verify", { method: "POST", body: { phone, code } }); state.me.hasPhone = true; notice("Phone linked."); go("dashboard"); } catch (error) { notice(error.message, "error"); }
}

function uploadView() {
  shell(true); app.innerHTML = `<a class="back-link" href="#/dashboard">← Back to dashboard</a><div class="page-head"><div><p class="eyebrow">New split · 1 of 3</p><h1>Show us the receipt.</h1><p class="lede">A clear, flat photo works best. You’ll review every item before anyone gets a text.</p></div></div>
    <div class="upload-layout"><label class="upload-zone" id="upload-zone"><input id="receipt-file" type="file" accept="image/jpeg,image/png,image/webp"><span id="upload-content"><span class="upload-icon">＋</span><h2>Choose from Photos, Camera, or Files</h2><p class="muted">JPG, PNG, or WebP · compressed automatically</p><span class="btn">Choose receipt</span></span></label>
      <aside class="card upload-details"><p class="eyebrow">A few tips</p><div class="stack"><div><h3>Find good light</h3><p class="muted small">Avoid hard shadows and glare across the prices.</p></div><div><h3>Get the whole receipt</h3><p class="muted small">Include the merchant, every item, tax, tip, and total.</p></div><div><h3>Check our work</h3><p class="muted small">OCR is a starting point. Nothing is sent until you approve it.</p></div></div></aside>
    </div>`;
  const input = document.querySelector("#receipt-file"), zone = document.querySelector("#upload-zone");
  input.addEventListener("change", () => input.files[0] && handleReceipt(input.files[0]));
  ["dragenter","dragover"].forEach(name => zone.addEventListener(name, e => { e.preventDefault(); zone.classList.add("dragging"); }));
  ["dragleave","drop"].forEach(name => zone.addEventListener(name, e => { e.preventDefault(); zone.classList.remove("dragging"); }));
  zone.addEventListener("drop", e => e.dataTransfer.files[0] && handleReceipt(e.dataTransfer.files[0]));
}

async function handleReceipt(file) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return notice("Choose a JPG, PNG, or WebP receipt image.", "error");
  // Phone cameras often produce 5–12 MB images. Compress those in-browser
  // before upload; only reject unusually large files that would be expensive
  // to decode on a mobile device.
  if (file.size > 20 * 1024 * 1024) return notice("That file is over 20 MB. Try a smaller image.", "error");
  const content = document.querySelector("#upload-content");
  const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
  content.innerHTML = `${preview ? `<img class="receipt-preview" src="${esc(preview)}" alt="Receipt preview">` : `<span class="upload-icon">PDF</span>`}<h2>Reading your receipt…</h2><p class="muted">Finding items, tax, tip, and the total.</p><div class="progress" aria-label="Processing"><i></i></div>`;
  try {
    if (state.demo) { await new Promise(r => setTimeout(r, 900)); state.draft = demoDraft(); return editorView(); }
    // Keep a review draft around when an upload fails so the next attempt
    // retries the same bill instead of creating orphaned dashboard entries.
    if (!state.draft?.id || state.draft.id === "demo-new" || state.draft.status !== "review") {
      const created = await api("/bills", { method: "POST", body: { requestKey: crypto.randomUUID(), subtotalCents: 0, taxCents: 0, tipCents: 0, feeCents: 0, discountCents: 0, totalCents: 0 } });
      state.draft = normalizeBill(created);
    }
    const upload = await prepareReceipt(file);
    await api(`/upload?billId=${encodeURIComponent(state.draft.id)}&filename=${encodeURIComponent(upload.name || file.name)}`, {
      method: "POST",
      headers: { "Content-Type": upload.type || "image/jpeg" },
      body: upload
    });
    state.draft = normalizeBill(await api(`/bills/${encodeURIComponent(state.draft.id)}`));
    if (state.draft.status === "processing" && state.draft.id) await pollBill(state.draft.id);
    editorView();
  } catch (error) { notice(error.message, "error"); uploadView(); }
}
async function prepareReceipt(file) {
  if (file.size <= 4 * 1024 * 1024) return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2200 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const encode = quality => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Couldn’t compress that receipt.")), "image/jpeg", quality));
  let blob = await encode(.82);
  if (blob.size > 4 * 1024 * 1024) blob = await encode(.62);
  if (blob.size > 4 * 1024 * 1024) throw new Error("That image is still too large after compression. Try a smaller photo.");
  return new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "receipt"}.jpg`, { type: "image/jpeg" });
}
function normalizeBill(result) { if (!result) return result; if (result.bill) return { ...result.bill, items: result.items || result.bill.items || [], participants: result.participants || result.bill.participants || [], allocations: result.allocations || [] }; return result; }
async function pollBill(id) {
  for (let i = 0; i < 12; i += 1) {
    await new Promise(r => setTimeout(r, Math.min(1200 + i * 300, 3500)));
    const result = await api(`/bills/${encodeURIComponent(id)}`); state.draft = normalizeBill(result);
    if (state.draft.status !== "processing") return;
  }
  throw new Error("Receipt processing is taking longer than usual. It will appear on your dashboard when ready.");
}
function demoDraft() { return { id: "demo-new", version: 1, status: "review", merchantName: "June's All Day", purchasedAt: new Date().toISOString().slice(0,10), items: [{ id:"i1", description:"Burrata", totalCents:1600 },{ id:"i2",description:"Steak frites",totalCents:3200 },{ id:"i3",description:"Salmon",totalCents:2900 },{ id:"i4",description:"Chocolate tart",totalCents:1200 }], subtotalCents:8900,taxCents:734,tipCents:1780,feeCents:0,discountCents:0,totalCents:11414,participants:[] }; }

function editorView() {
  shell(true); const b = state.draft || demoDraft(); const items = b.items || b.lineItems || []; const people = b.participants || [];
  app.innerHTML = `<a class="back-link" href="#/new" data-action="choose-receipt">← Choose another receipt</a><div class="page-head"><div><p class="eyebrow">New split · 2 of 3</p><h1>Check the details.</h1><p class="lede">Fix anything the scanner missed, then add everyone at the table.</p></div></div>
    <form id="bill-form" class="editor-layout"><div class="editor-main">
      <section class="card card-pad"><div class="form-grid"><label class="field"><span>Restaurant</span><input class="input" name="merchant" value="${esc(b.merchantName || b.merchant)}" maxlength="120" required></label><label class="field"><span>Date</span><input class="input" type="date" name="date" value="${esc(String(b.purchasedAt || b.date || "").slice(0,10))}" required></label></div></section>
      <section class="card card-pad"><div class="section-head"><div><h2>Receipt items</h2><p class="muted small">Tap any line to correct it.</p></div><button class="btn btn-sm" type="button" data-action="add-item">+ Add item</button></div><div id="item-list">${items.map((x,i) => itemEditor(x,i)).join("")}</div></section>
      <section class="card card-pad"><div class="section-head"><div><h2>People at dinner</h2><p class="muted small">They’ll get an individual link after you publish.</p></div><button class="btn btn-sm" type="button" data-action="pick-contact">From contacts</button></div><div id="participant-list" class="participant-list">${people.map(personEditor).join("")}</div><div class="add-person"><div class="contact-name-wrap"><input class="input" id="person-name" placeholder="Search a name" maxlength="80" autocomplete="off"><div id="contact-suggestions" class="contact-suggestions" role="listbox" hidden></div></div><input class="input" id="person-phone" type="tel" inputmode="tel" placeholder="Phone number"><button class="btn" type="button" data-action="add-person">Add</button></div><p class="field-hint">Search past diners or enter a new name and phone.</p></section>
    </div><aside class="editor-aside"><section class="card card-pad"><h2>Receipt total</h2><div class="totals"><label class="total-line"><span>Subtotal</span><span class="input-prefix"><input class="input money-input" name="subtotal" value="${(Number(b.subtotalCents || 0)/100).toFixed(2)}" inputmode="decimal"></span></label><label class="total-line"><span>Tax</span><span class="input-prefix"><input class="input money-input" name="tax" value="${(Number(b.taxCents || 0)/100).toFixed(2)}" inputmode="decimal"></span></label><label class="total-line"><span>Tip</span><span class="input-prefix"><input class="input money-input" name="tip" value="${(Number(b.tipCents || 0)/100).toFixed(2)}" inputmode="decimal"></span></label><div class="total-line grand"><span>Total</span><strong id="calculated-total">${money(b.totalCents)}</strong></div></div></section><button class="btn btn-primary btn-block" type="submit">Save and preview</button><p class="fine-print center">No texts are sent until the next step.</p></aside></form>`;
  bindEditor(b);
}
function itemEditor(x,i) { return `<div class="item-row" data-item-id="${esc(x.id || "")}"><input class="input item-name" value="${esc(x.description || x.name)}" aria-label="Item ${i+1} name" maxlength="160"><span class="input-prefix"><input class="input money-input item-price" value="${(Number(x.lineTotalCents ?? x.totalCents ?? x.priceCents ?? 0)/100).toFixed(2)}" inputmode="decimal" aria-label="Item ${i+1} price"></span><button class="icon-btn" type="button" data-action="remove-item" aria-label="Remove item">×</button></div>`; }
function personEditor(p) { const name=p.displayName||p.name||"Guest";return `<div class="person" data-person-id="${esc(p.id || "")}"><span class="person-dot">${esc(initials(name))}</span><span class="person-copy"><strong>${esc(name)}</strong><small>${esc(p.phone || p.maskedPhone || "Invite pending")}</small></span>${p.id?"":`<button class="text-btn btn-danger" type="button" data-action="remove-person">Remove</button>`}<input type="hidden" class="person-name-value" value="${esc(name)}"><input type="hidden" class="person-phone-value" value="${esc(p.phone || "")}"></div>`; }
function bindEditor(b) {
  const form = document.querySelector("#bill-form"), list = document.querySelector("#item-list"), people = document.querySelector("#participant-list");
  document.querySelector('[data-action="choose-receipt"]')?.addEventListener("click", () => { state.draft = null; });
  const nameInput = document.querySelector("#person-name"), phoneInput = document.querySelector("#person-phone"), suggestions = document.querySelector("#contact-suggestions");
  let searchTimer, searchVersion = 0;
  nameInput?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const version = ++searchVersion;
    const query = nameInput.value.trim();
    if (query.length < 1) { suggestions.hidden = true; suggestions.innerHTML = ""; return; }
    searchTimer = setTimeout(async () => {
      const found = state.demo ? [{ name: "Maya", phone: "+12145550101" }, { name: "Sam", phone: "+15125550102" }].filter(x => x.name.toLowerCase().includes(query.toLowerCase())) : (await api(`/contacts?q=${encodeURIComponent(query)}`).catch(() => ({ contacts: [] }))).contacts || [];
      if (version !== searchVersion || nameInput.value.trim() !== query) return;
      suggestions.innerHTML = found.map(contact => `<button type="button" role="option" data-action="choose-contact" data-name="${esc(contact.name)}" data-phone="${esc(contact.phone)}"><strong>${esc(contact.name)}</strong><small>${esc(contact.phone.slice(-4).padStart(contact.phone.length, "•"))}</small></button>`).join("");
      suggestions.hidden = !found.length;
    }, 180);
  });
  nameInput?.addEventListener("keydown", event => { if (event.key === "Escape") suggestions.hidden = true; });
  document.addEventListener("click", event => { if (!event.target.closest(".contact-name-wrap")) suggestions.hidden = true; });
  const total = () => { const itemSum = [...document.querySelectorAll(".item-price")].reduce((s,x) => s + parseCents(x.value),0); form.elements.subtotal.value = (itemSum/100).toFixed(2); document.querySelector("#calculated-total").textContent = money(itemSum + parseCents(form.elements.tax.value) + parseCents(form.elements.tip.value)); };
  form.addEventListener("input", e => { if (e.target.matches(".item-price,[name=tax],[name=tip]")) total(); });
  form.addEventListener("click", e => { const target=e.target.closest("[data-action]"), action = target?.dataset.action; if (action === "add-item") { list.insertAdjacentHTML("beforeend", itemEditor({},list.children.length)); list.lastElementChild.querySelector("input").focus(); } if (action === "remove-item") { e.target.closest(".item-row").remove(); total(); } if (action === "remove-person") e.target.closest(".person").remove(); if (action === "add-person") addPersonFromInputs(people); if (action === "choose-contact") { nameInput.value=target.dataset.name||""; phoneInput.value=target.dataset.phone||""; suggestions.hidden=true; } if (action === "pick-contact") pickContact(people); });
  form.addEventListener("submit", e => saveDraft(e,b));
  // Reconcile the summary immediately, including OCR results with a missing
  // subtotal or a receipt whose line items were corrected before submission.
  total();
}
function addPersonFromInputs(people) { const name = document.querySelector("#person-name"), phone = document.querySelector("#person-phone"); if (!name.value.trim() || phone.value.replace(/\D/g,"").length < 10) return notice("Add a name and valid phone number.","error"); people.insertAdjacentHTML("beforeend", personEditor({name:name.value.trim(),phone:phone.value.trim()})); name.value="";phone.value=""; }
async function pickContact(people) {
  if (!navigator.contacts?.select) return notice("Contact picking isn’t available in this browser. You can still enter someone manually.", "error");
  try { const selected = await navigator.contacts.select(["name","tel"], { multiple: true }); selected.forEach(contact => { const name = contact.name?.[0] || "Guest", phone = contact.tel?.[0] || ""; if (phone) people.insertAdjacentHTML("beforeend", personEditor({ name, phone })); }); } catch (_) { /* The person closed the native picker. */ }
}
async function saveDraft(event,b) {
  event.preventDefault(); const button = event.currentTarget.querySelector("button[type=submit]"); const form = event.currentTarget;
  const items = [...document.querySelectorAll(".item-row")].map((row,index) => { const lineTotalCents=parseCents(row.querySelector(".item-price").value);return { id:row.dataset.itemId || undefined, description:row.querySelector(".item-name").value.trim(), quantity:1, unitPriceCents:lineTotalCents, lineTotalCents, displayOrder:index }; });
  const participants = [...document.querySelectorAll(".person")].map(row => ({ id:row.dataset.personId || undefined,name:row.querySelector(".person-name-value").value,phone:row.querySelector(".person-phone-value").value }));
  const payload = { version:b.version, merchantName:form.elements.merchant.value.trim(), purchasedAt:form.elements.date.value, subtotalCents:parseCents(form.elements.subtotal.value),taxCents:parseCents(form.elements.tax.value),tipCents:parseCents(form.elements.tip.value),feeCents:Number(b.feeCents||0),discountCents:Number(b.discountCents||0) }; payload.totalCents = payload.subtotalCents+payload.taxCents+payload.tipCents+payload.feeCents-payload.discountCents;
  if (!items.length || items.some(x => !x.description || x.lineTotalCents < 0)) return notice("Check each item name and price.","error");
  setBusy(button,true,"Saving…");
  try { if(state.demo) state.draft={...b,...payload,items,participants}; else { const updated=await api(`/bills/${encodeURIComponent(b.id)}`,{method:"PATCH",body:payload}); await saveItemsAndPeople(b,items,participants); const fresh=await api(`/bills/${encodeURIComponent(b.id)}`);state.draft=normalizeBill(fresh); if(!state.draft.version)state.draft.version=(updated.bill||updated).version; } previewBill(); }
  catch(error) { notice(error.message,"error");setBusy(button,false); }
}
async function saveItemsAndPeople(b,items,participants) {
  const retained=new Set(items.filter(x=>x.id).map(x=>String(x.id)));
  const calls=items.map(item=>{const body={description:item.description,quantity:item.quantity,unitPriceCents:item.unitPriceCents,lineTotalCents:item.lineTotalCents,displayOrder:item.displayOrder};return item.id?api(`/items/${encodeURIComponent(item.id)}`,{method:"PATCH",body}):api(`/bills/${encodeURIComponent(b.id)}/items`,{method:"POST",body});});
  for(const old of b.items||[])if(!retained.has(String(old.id)))calls.push(api(`/items/${encodeURIComponent(old.id)}`,{method:"DELETE"}));
  for(const person of participants)if(!person.id)calls.push(api(`/bills/${encodeURIComponent(b.id)}/participants`,{method:"POST",body:{displayName:person.name,phone:person.phone}}));
  await Promise.all(calls);
}

function previewBill() {
  const b=state.draft,people=b.participants||[];
  app.innerHTML=`<a class="back-link" href="#/edit">← Edit receipt</a><div class="page-head"><div><p class="eyebrow">New split · 3 of 3</p><h1>Ready for the table?</h1><p class="lede">Publishing sends one text to each person. Unpaid guests get a reminder every 24 hours until they report payment.</p></div></div>
  <div class="split-layout"><section class="card card-pad"><h2>${esc(b.merchantName||b.merchant)}</h2><p class="muted">${dateLabel(b.purchasedAt||b.date)} · ${money(b.totalCents)}</p><div class="participant-list">${people.length?people.map(p=>personEditor(p)).join(""):`<div class="callout warning">No guests added yet. Go back and add at least one person.</div>`}</div></section>
  <aside class="card pay-panel"><p class="eyebrow">What happens next</p><div class="timeline"><div class="timeline-row"><i class="timeline-dot done"></i><div><h3>Receipt reviewed</h3><p class="muted small">Your itemized receipt is ready.</p></div></div><div class="timeline-row"><i class="timeline-dot"></i><div><h3>Everyone claims items</h3><p class="muted small">Each guest gets a private text link.</p></div></div><div class="timeline-row"><i class="timeline-dot"></i><div><h3>You get paid</h3><p class="muted small">Guests can reply PAID; you confirm it.</p></div></div></div><button class="btn btn-primary btn-block" data-action="publish" ${people.length?"":"disabled"}>Text ${people.length} ${people.length===1?"person":"people"}</button></aside></div>`;
  document.querySelector('[data-action="publish"]').addEventListener("click",publishBill);
}
async function publishBill(event) { const button=event.currentTarget;setBusy(button,true,"Sending invites…");try{ const result=state.demo?{}:await api(`/bills/${encodeURIComponent(state.draft.id)}/publish`,{method:"POST"}); if(result.delivery?.failed) notice(`Bill published, but ${result.delivery.failed} invite${result.delivery.failed===1?"":"s"} will retry automatically.`,"error"); else notice("Invites sent. We’ll keep track from here.");state.dashboard=null;go(`bill/${state.draft.id}`);}catch(error){notice(error.message,"error");setBusy(button,false);} }

async function billView(id) {
  shell(true); app.innerHTML=`<div class="skeleton"></div><div class="split-layout"><div class="skeleton"></div><div class="skeleton"></div></div>`;
  try { let b; if (state.demo) b=id==="demo-new"?state.draft:demoBill(id); else b=normalizeBill(await api(`/bills/${encodeURIComponent(id)}`)); renderBill(b); } catch(error){renderError("We couldn’t open this dinner.",error.message,()=>billView(id));}
}
function demoBill(id){return {...demoDraft(),id,status:id==="demo-3"?"settled":"open",participants:[{id:"p1",name:"Alex",paymentStatus:"paid",amountCents:4832},{id:"p2",name:"Maya",paymentStatus:"unpaid",amountCents:3982},{id:"p3",name:"Sam",paymentStatus:"reported_paid",amountCents:2600}]};}
function renderBill(b) {
  const people=b.participants||[], rawItems=b.items||b.lineItems||[], items=rawItems.map(item=>({...item,allocations:item.allocations||(b.allocations||[]).filter(a=>String(a.itemId)===String(item.id))})), mine=b.currentParticipant||people.find(p=>p.userId===state.me?.id);
  const isOrganizer=b.organizerUserId===state.me?.id;
  const paidCount=people.filter(x=>["paid","confirmed","reported_paid"].includes(x.paymentStatus)).length;
  const paidPercent=people.length?Math.round((paidCount/people.length)*10)*10:0;
  app.innerHTML=`<a class="back-link" href="#/dashboard">← Dashboard</a><section class="card bill-hero"><div><p class="eyebrow">${esc((b.status||"open").replaceAll("_"," "))}</p><h1>${esc(b.merchantName||b.merchant||"Dinner")}</h1><p class="muted">${dateLabel(b.purchasedAt||b.date||b.receiptDate)} · ${people.length} people</p></div><div class="bill-total"><small>Receipt total</small><span>${money(b.totalCents)}</span></div></section>
    <div class="split-layout"><section class="card card-pad"><div class="section-head"><div><h2>Items</h2><p class="muted small">${mine?"Select everything you had.":"What everyone claimed."}</p></div>${mine&&items.length?`<button class="text-btn" type="button" data-action="select-all">Select all</button>`:""}</div><div>${items.map(x=>claimItem(x,mine)).join("")||`<p class="muted">No item details available.</p>`}</div>${mine?`<button class="btn btn-primary btn-block" type="button" data-action="save-claims">${mine.selectionStatus==="complete"?"Update my items":"Save my items"}</button>`:""}</section>
    <aside class="stack"><section class="card pay-panel">${isOrganizer?organizerStatus(people,b):mine?participantPayment(mine,b):organizerStatus(people,b)}</section><section class="card card-pad"><h2>Split progress</h2><div class="allocation-bar" role="progressbar" aria-label="Payment progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${paidPercent}"><i class="p${paidPercent}"></i></div><p class="muted small">${paidCount} of ${people.length} have reported payment</p></section></aside></div>`;
  document.querySelector('[data-action="save-claims"]')?.addEventListener("click",()=>saveClaims(b)); document.querySelector('[data-action="select-all"]')?.addEventListener("click",e=>{document.querySelectorAll(".claim-check").forEach(input=>{input.checked=true;});e.currentTarget.textContent="All selected";e.currentTarget.disabled=true;}); document.querySelector('[data-action="report-paid"]')?.addEventListener("click",e=>reportPaid(e,mine)); document.querySelector('[data-action="lock-bill"]')?.addEventListener("click",e=>lockBill(e,b));
  document.querySelectorAll('[data-action="confirm-payment"]').forEach(button=>button.addEventListener("click",e=>setPaymentStatus(e,button.dataset.participant,"confirmed",b)));
}
function claimItem(x,mine){const assigned=x.allocations||x.claims||[];const selected=assigned.some(a=>a.participantId===mine?.id);return `<label class="claim-item">${mine?`<input class="claim-check" type="checkbox" value="${esc(x.id)}" ${selected?"checked":""}>`:`<span class="person-dot">${assigned.length?"✓":"—"}</span>`}<span><strong>${esc(x.description||x.name)}</strong><small class="muted">${assigned.length?`${assigned.length} ${assigned.length===1?"person":"people"} claiming`:"Available"}</small></span><span class="claim-price">${money(x.lineTotalCents??x.totalCents??x.priceCents)}</span></label>`;}
function participantPayment(p,b){if(b.status!=="locked"&&b.status!=="settled")return `<p class="eyebrow">Your picks</p><h2>${p.selectionStatus==="complete"?"Items submitted":"Choose what you had"}</h2><p class="muted small">Your exact share, including tax and tip, appears when everyone finishes.</p>`;const status=p.paymentStatus||"unpaid";const subtotal=p.itemSubtotalCents;const breakdown=subtotal!=null?`<div class="totals share-breakdown"><div class="total-line"><span>Items</span><span>${money(subtotal)}</span></div><div class="total-line"><span>Your tax</span><span>${money(p.taxCents||0)}</span></div><div class="total-line"><span>Your tip</span><span>${money(p.tipCents||0)}</span></div></div>`:"<p class=\"muted small\">Includes your proportional share of tax and tip.</p>";return `<span class="status ${esc(status)}">${esc(status.replaceAll("_"," "))}</span><h2>Your share</h2><div class="pay-amount">${money(p.amountCents||p.finalAmountCents)}</div>${breakdown}${status==="unpaid"?`<button class="btn btn-primary btn-block" data-action="report-paid">I’ve paid</button><p class="fine-print center">You can also reply PAID to the reminder text.</p>`:`<div class="callout">${status==="reported_paid"?"Payment reported. Waiting for the payer to confirm.":"You’re all settled up."}</div>`}`;}
function organizerStatus(people,b){const canLock=b.status==="open"&&people.length&&people.every(p=>p.selectionStatus==="complete");return `<p class="eyebrow">Payment status</p><h2>Who’s settled up</h2><div class="participant-list">${people.map(p=>{const name=p.displayName||p.name||"Guest",status=p.paymentStatus||"unpaid";return `<div class="person"><span class="person-dot">${esc(initials(name))}</span><span class="person-copy"><strong>${esc(name)}</strong><small>${p.finalAmountCents!=null?money(p.finalAmountCents):esc((p.selectionStatus||"waiting").replaceAll("_"," "))}</small></span>${b.status==="locked"&&status!=="confirmed"?`<button class="btn btn-sm" type="button" data-action="confirm-payment" data-participant="${esc(p.id)}">${status==="reported_paid"?"Confirm":"Mark paid"}</button>`:`<span class="status ${esc(status)}">${esc(status.replaceAll("_"," "))}</span>`}</div>`;}).join("")||`<p class="muted">Waiting for guests.</p>`}</div>${b.status==="open"?`<button class="btn btn-dark btn-block" type="button" data-action="lock-bill" ${canLock?"":"disabled"}>Finalize amounts</button><p class="fine-print center">${canLock?"This locks everyone’s selections and sends final totals.":"Everyone must finish choosing before totals can be finalized."}</p>`:`<p class="fine-print">Unpaid guests are reminded every 24 hours. Reminders stop as soon as they report payment.</p>`}`;}
async function lockBill(event,b){setBusy(event.currentTarget,true,"Finalizing…");try{const result=await api(`/bills/${encodeURIComponent(b.id)}/lock`,{method:"POST"});if(result.delivery?.failed) notice(`Amounts finalized, but ${result.delivery.failed} final text${result.delivery.failed===1?"":"s"} will retry automatically.`,`error`);else notice("Final totals sent.");billView(b.id);}catch(error){notice(error.message,"error");setBusy(event.currentTarget,false);}}
async function setPaymentStatus(event,participantId,status,b){setBusy(event.currentTarget,true,"Updating…");try{await api(`/participants/${encodeURIComponent(participantId)}/payment-status`,{method:"POST",body:{status}});notice("Payment confirmed.");billView(b.id);}catch(error){notice(error.message,"error");setBusy(event.currentTarget,false);}}
async function saveClaims(b){const ids=[...document.querySelectorAll(".claim-check:checked")].map(x=>x.value);const participant=state.invitation?.participant||b.currentParticipant;try{if(!participant?.id&&!state.demo)throw new Error("This invitation is missing a participant.");if(!state.demo){await api(`/participants/${encodeURIComponent(participant.id)}/allocations`,{method:"POST",body:{allocations:ids.map(itemId=>({itemId,kind:"equal_share",shareUnits:1}))}});await api(`/participants/${encodeURIComponent(participant.id)}/selection/complete`,{method:"POST"});}if(participant)participant.selectionStatus="complete";if(state.invitation?.participant)state.invitation.participant.selectionStatus="complete";notice("Your items are saved.");renderBill({...b,currentParticipant:participant,participants:(b.participants||[]).map(p=>p.id===participant?.id?{...p,selectionStatus:"complete"}:p)});}catch(error){notice(error.message,"error");}}
async function reportPaid(event,p){setBusy(event.currentTarget,true,"Updating…");try{if(!state.demo)await api(`/participants/${encodeURIComponent(p.id)}/report-paid`,{method:"POST",body:{requestKey:crypto.randomUUID()}});p.paymentStatus="reported_paid";notice("Payment reported. The payer will confirm it.");route();}catch(error){notice(error.message,"error");setBusy(event.currentTarget,false);}}

async function inviteView(token){sessionStorage.setItem("split_invite",token);if(!state.me)return authView();try{const preview=await api(`/invites/${encodeURIComponent(token)}`);const accepted=await api(`/invites/${encodeURIComponent(token)}/accept`,{method:"POST"});sessionStorage.removeItem("split_invite");state.invitation={...preview,...accepted};const bill=normalizeBill(state.invitation.bill?state.invitation:{...state.invitation,bill:preview.bill});bill.currentParticipant=accepted.participant||preview.participant;renderBill(bill);}catch(error){if(state.demo)return renderBill(demoBill("demo-1"));renderError("This invitation isn’t available.",error.message,()=>go("dashboard"));}}
function activityView(){dashboardView();}
function renderError(title,detail,retry){shell(Boolean(state.me));app.innerHTML=`<div class="card empty-state"><div class="empty-icon">!</div><h1>${esc(title)}</h1><p class="muted">${esc(detail||"Try again in a moment.")}</p><button class="btn btn-primary" type="button" id="retry">Try again</button></div>`;document.querySelector("#retry").addEventListener("click",retry);}
function bindCommon(){document.querySelectorAll('[data-action="new-bill"]').forEach(x=>x.addEventListener("click",()=>{state.draft=null;go("new");}));}

function route(){const parts=getRoute();const routeName=parts[0]|| (state.me?"dashboard":"welcome");document.querySelectorAll("[data-nav]").forEach(x=>x.classList.toggle("active",x.dataset.nav===routeName));if(!state.me&&routeName!=="invite")return authView();if(routeName==="welcome")return state.me?go("dashboard"):authView();if(routeName==="dashboard")return dashboardView();if(routeName==="activity")return activityView();if(routeName==="profile")return profileView();if(routeName==="new")return uploadView();if(routeName==="edit")return editorView();if(routeName==="preview")return previewBill();if(routeName==="bill"&&parts[1])return billView(parts[1]);if(routeName==="invite"&&parts[1])return inviteView(parts[1]);go(state.me?"dashboard":"welcome");}

bottomNav.addEventListener("click",e=>{if(e.target.closest('[data-action="new-bill"]'))go("new");});
window.addEventListener("hashchange",route);
bootstrap();
