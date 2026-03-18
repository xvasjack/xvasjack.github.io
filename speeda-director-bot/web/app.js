const defaults = {
  workbook_path: "C:\\Users\\User\\OneDrive - YCP Holdings\\potential seller.xlsx",
  sheet_name: "Company List",
  start_row: 11,
  end_row: 8673,
  target_column: "V",
  max_retries: 2,
  pace_profile: "conservative",
  base_url: "https://www.ub-speeda.com/",
  force_retry: false,
  headless: false,
};

let pollTimer = null;

function byId(id) {
  return document.getElementById(id);
}

function addLog(message, isError = false) {
  const box = byId("event_log");
  const prefix = new Date().toLocaleTimeString();
  const line = `[${prefix}] ${message}`;
  box.textContent = `${line}\n${box.textContent}`.slice(0, 14000);
  if (isError) {
    console.error(message);
  } else {
    console.log(message);
  }
}

function readConfig() {
  return {
    workbook_path: byId("workbook_path").value,
    sheet_name: byId("sheet_name").value,
    start_row: Number(byId("start_row").value),
    end_row: Number(byId("end_row").value),
    target_column: byId("target_column").value,
    force_retry: byId("force_retry").checked,
    max_retries: Number(byId("max_retries").value),
    pace_profile: byId("pace_profile").value,
    base_url: byId("base_url").value,
    headless: byId("headless").checked,
  };
}

function buildConfig(mode) {
  const cfg = readConfig();
  if (mode === "test") {
    cfg.start_row = 12;
    cfg.end_row = 40;
    cfg.force_retry = true;
  }
  if (mode === "full") {
    cfg.start_row = 11;
    cfg.end_row = 8673;
  }
  return cfg;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

function renderErrors(errors) {
  const tbody = byId("error_rows");
  tbody.innerHTML = "";
  for (const item of errors || []) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${item.row_number ?? "-"}</td><td>${item.company_name ?? "-"}</td><td>${item.status ?? "-"}</td>`;
    tbody.appendChild(tr);
  }
}

function renderStatus(status) {
  byId("run_id").textContent = status.run_id || "-";
  byId("status").textContent = status.status || "-";
  byId("current_step").textContent = status.current_step || "-";
  byId("current_row").textContent = status.current_row ?? "-";
  byId("current_company").textContent = status.current_company || "-";
  byId("current_url").textContent = status.current_url || "-";
  byId("message").textContent = status.message || "-";
  byId("elapsed_seconds").textContent = Math.round(status.elapsed_seconds || 0);
  byId("eta_seconds").textContent =
    status.eta_seconds == null ? "-" : `${Math.round(status.eta_seconds)}s`;

  const total = status.total_rows || 0;
  const done = status.done_rows || 0;
  const percent = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  byId("progress_fill").style.width = `${percent}%`;
  byId("progress_text").textContent = `${done} / ${total}`;
  byId("progress_success").textContent = `Success: ${status.success_rows || 0}`;
  byId("progress_failed").textContent = `Failed: ${status.failed_rows || 0}`;
  byId("progress_skipped").textContent = `Skipped: ${status.skipped_rows || 0}`;

  renderErrors(status.recent_errors || []);
}

async function pollStatus() {
  try {
    const res = await fetch("/api/status");
    const status = await res.json();
    renderStatus(status);
  } catch (err) {
    addLog(`Status poll failed: ${err}`, true);
  }
}

async function doAction(label, endpoint, body) {
  try {
    const result = await postJson(endpoint, body);
    if (result.ok) {
      addLog(`${label}: ${result.message}`);
    } else {
      addLog(`${label} failed: ${result.message}`, true);
    }
    await pollStatus();
  } catch (err) {
    addLog(`${label} error: ${err}`, true);
  }
}

function initDefaults() {
  for (const [key, value] of Object.entries(defaults)) {
    const el = byId(key);
    if (!el) continue;
    if (el.type === "checkbox") {
      el.checked = Boolean(value);
    } else {
      el.value = value;
    }
  }
}

function initActions() {
  byId("btn_login_check").addEventListener("click", async () => {
    const cfg = readConfig();
    await doAction("Login Check", "/api/login_check", {
      base_url: cfg.base_url,
      headless: cfg.headless,
      pace_profile: cfg.pace_profile,
    });
  });

  byId("btn_start_test").addEventListener("click", async () => {
    await doAction("Start 30-Row Test", "/api/start_run", buildConfig("test"));
  });

  byId("btn_start_full").addEventListener("click", async () => {
    await doAction("Start Full Run", "/api/start_run", buildConfig("full"));
  });

  byId("btn_pause").addEventListener("click", async () => {
    await doAction("Pause", "/api/pause_run", {});
  });

  byId("btn_resume").addEventListener("click", async () => {
    await doAction("Resume", "/api/resume_run", {});
  });

  byId("btn_stop").addEventListener("click", async () => {
    await doAction("Stop", "/api/stop_run", {});
  });

  byId("btn_retry").addEventListener("click", async () => {
    await doAction("Retry Failed", "/api/retry_failed", {});
  });

  byId("btn_export").addEventListener("click", async () => {
    await doAction("Export", "/api/export_results", {
      destination_path: byId("destination_path").value || null,
    });
  });
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    pollStatus();
  }, 2000);
  pollStatus();
}

initDefaults();
initActions();
startPolling();
addLog("Simple dashboard ready. AI used for extraction: none.");
