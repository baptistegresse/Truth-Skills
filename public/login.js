// Truth-Skills sign-in page. Uses the IDKit browser build (window.IDKit) and qrcode-generator
// (window.qrcode), both served from our own origin.
"use strict";

const $ = (id) => document.getElementById(id);
const requestId = new URLSearchParams(location.search).get("req");
let ctx = null;
let controller = null; // aborts the QR code currently shown
let retry = null; // what "Try again" runs

const show = (id, visible) => {
  $(id).hidden = !visible;
};

const setStatus = (text, isError = false) => {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
};

const isAbort = (error) => error && error.name === "AbortError";

// World App refuses a second uniqueness proof for the same human and action: this human already
// has an account, and only their World ID session (cookie or recovery link) can sign them in.
const ALREADY_REGISTERED = "nullifier_replayed";

class WorldAppError extends Error {
  constructor(code) {
    super(`World App did not complete the request (${code}).`);
    this.code = code;
  }
}

// An error whose way out is the recovery link, not another scan.
class NeedsRecoveryError extends Error {}

const postJson = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { status: res.status });
  return data;
};

// The server answers 404 to a "prove" request when this browser's session matches no account.
const NO_SESSION = 404;

const showQr = (uri) => {
  const qr = window.qrcode(0, "M");
  qr.addData(uri);
  qr.make();
  $("qr-img").src = qr.createDataURL(5, 2);
  $("qr-link").href = uri;
  show("scan", true);
};

const constraints = () => IDKit.any(...ctx.credentials.map((credential) => IDKit.CredentialRequest(credential)));

// Shows one QR code and waits for World App. Resolves with the IDKit result to send to /login/verify.
const scan = async (builder, signal) => {
  const request = await builder.constraints(constraints());
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  showQr(request.connectorURI);
  try {
    const completion = await request.pollUntilCompletion({ pollInterval: 2000, timeout: 180000, signal });
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (!completion.success) throw new WorldAppError(completion.error);
    return completion.result;
  } finally {
    if (!signal.aborted) show("scan", false);
  }
};

const newScan = () => {
  controller?.abort();
  controller = new AbortController();
  return controller.signal;
};

const finish = (redirect) => {
  show("recovery-form", false);
  setStatus("Signed in. Returning to Claude Code…");
  location.assign(redirect);
};

// Runs a step of the flow; on failure shows the error and offers "Try again", which reruns the
// step the flow had reached (a flow that moves on to scan 2 updates `retry` itself).
const showRecoveryForm = () => {
  show("recovery-form", true);
  $("recovery-form").querySelector("details").open = true;
  $("recovery-input").focus();
};

const run = async (step) => {
  show("retry", false);
  retry = step;
  try {
    await step();
  } catch (error) {
    if (isAbort(error)) return;
    show("scan", false);
    setStatus(error.message || "Something went wrong.", true);
    if (error instanceof NeedsRecoveryError) return showRecoveryForm();
    show("retry", true);
  }
};

// Scan 1: prove this is a unique human. Creates the account, or finds it.
const accountFlow = async () => {
  const signal = newScan();
  show("recovery-form", true);
  setStatus("Step 1 of 2 — scan with World App to prove you are a unique human.");
  const rp = await postJson("/login/rp-context", { req: requestId, kind: "account" });
  const config = {
    app_id: ctx.app_id,
    action: rp.action,
    rp_context: rp.rp_context,
    allow_legacy_proofs: false,
    environment: ctx.environment,
  };
  const builder = ctx.invite_code ? IDKit.requestWithInviteCode(config) : IDKit.request(config);
  const result = await scan(builder, signal).catch((error) => {
    if (error.code !== ALREADY_REGISTERED) throw error;
    throw new NeedsRecoveryError(
      "You already have a Truth-Skills account, but this browser does not remember it. " +
        "Paste your recovery link below to sign in with one scan.",
    );
  });
  const outcome = await postJson("/login/verify", { req: requestId, result });
  if (outcome.redirect) return finish(outcome.redirect);
  retry = sessionFlow;
  await sessionFlow();
};

// Scan 2: open a World ID session, the only way to recognise this human later.
const sessionFlow = async () => {
  const signal = newScan();
  show("recovery-form", false);
  setStatus("Step 2 of 2 — scan again so Truth-Skills can recognise you next time.");
  const rp = await postJson("/login/rp-context", { req: requestId, kind: "session" });
  const builder = IDKit.createSession({ app_id: ctx.app_id, rp_context: rp.rp_context, environment: ctx.environment });
  const result = await scan(builder, signal);
  const outcome = await postJson("/login/verify", { req: requestId, result });
  showRecoveryLink(outcome);
};

// A returning human proves the session saved in this browser, or the one in a pasted link.
const proveFlow = async (recovery) => {
  const signal = newScan();
  const rp = await postJson("/login/rp-context", { req: requestId, kind: "prove", recovery });
  const builder = IDKit.proveSession(rp.session_id, {
    app_id: ctx.app_id,
    rp_context: rp.rp_context,
    environment: ctx.environment,
  });
  const result = await scan(builder, signal);
  const outcome = await postJson("/login/verify", { req: requestId, result });
  finish(outcome.redirect);
};

const showRecoveryLink = (outcome) => {
  setStatus("Almost done.");
  $("recovery-url").value = outcome.recovery_url;
  show("recovery", true);
  $("copy").addEventListener("click", async () => {
    $("recovery-url").select();
    try {
      await navigator.clipboard.writeText(outcome.recovery_url);
      $("copy").textContent = "Copied";
    } catch {
      $("copy").textContent = "Select and copy it";
    }
  });
  $("continue").addEventListener("click", () => {
    show("recovery", false);
    finish(outcome.redirect);
  });
};

// A returning human proves the session remembered by this browser. Only when the server knows no
// such session does the page fall back to sign-up: for an existing human, World App would refuse
// scan 1, so any other failure is shown, with "Try again" and the recovery link.
const start = async () => {
  if (!ctx.returning) return accountFlow();
  setStatus("Welcome back — scan once with World App.");
  try {
    await proveFlow(undefined);
  } catch (error) {
    if (error.status !== NO_SESSION) {
      if (!isAbort(error)) show("recovery-form", true);
      throw error;
    }
    await accountFlow();
  }
};

$("recovery-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const recovery = $("recovery-input").value;
  const step = async () => {
    show("recovery-form", false);
    setStatus("Scan with World App to prove this account is yours.");
    try {
      await proveFlow(recovery);
    } catch (error) {
      if (!isAbort(error)) show("recovery-form", true);
      throw error;
    }
  };
  void run(step);
});

$("retry").addEventListener("click", () => {
  if (retry) void run(retry);
});

const init = async () => {
  if (!requestId) return setStatus("Open this page from Claude Code to sign in.", true);
  if (!window.IDKit || !window.qrcode) return setStatus("The sign-in components failed to load. Reload the page.", true);
  const res = await fetch(`/login/context?req=${encodeURIComponent(requestId)}`, { credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return setStatus(data.error || "This sign-in is not valid.", true);
  ctx = data;
  // Both come from the client's own registration: untrusted, so text only.
  $("client-name").textContent = ctx.client_name;
  $("redirect-host").textContent = ctx.redirect_host;
  show("client", true);
  await run(start);
};

void init();
