from __future__ import annotations

from pathlib import Path

from flask import Flask, jsonify, request, send_file

from .config import (
    DEFAULT_SERVER_HOST,
    DEFAULT_SERVER_PORT,
    STATE_DB_PATH,
    WEB_ROOT,
    ensure_directories,
)
from .models import ApiResult, RunConfig
from .runner import SpeedaRunController
from .storage import StateStore


ensure_directories()
store = StateStore(STATE_DB_PATH)
controller = SpeedaRunController(store)

app = Flask(__name__, static_folder=None)


@app.get("/")
def index():
    return send_file(WEB_ROOT / "index.html")


@app.get("/styles.css")
def styles():
    return send_file(WEB_ROOT / "styles.css")


@app.get("/app.js")
def script():
    return send_file(WEB_ROOT / "app.js")


@app.get("/api/health")
def health():
    return jsonify({"ok": True, "status": "healthy"})


@app.get("/api/status")
def status():
    return jsonify(controller.get_status().to_dict())


@app.get("/api/recent_errors")
def recent_errors():
    snapshot = controller.get_status()
    return jsonify({"ok": True, "run_id": snapshot.run_id, "errors": snapshot.recent_errors})


@app.post("/api/start_run")
def start_run():
    payload = request.get_json(silent=True) or {}
    config = RunConfig.from_payload(payload)
    ok, message, run_id = controller.start_run(config)
    return jsonify(ApiResult(ok=ok, message=message, run_id=run_id).to_dict())


@app.post("/api/pause_run")
def pause_run():
    ok, message = controller.pause_run()
    return jsonify(ApiResult(ok=ok, message=message).to_dict())


@app.post("/api/resume_run")
def resume_run():
    ok, message = controller.resume_run()
    return jsonify(ApiResult(ok=ok, message=message).to_dict())


@app.post("/api/stop_run")
def stop_run():
    ok, message = controller.stop_run()
    return jsonify(ApiResult(ok=ok, message=message).to_dict())


@app.post("/api/retry_failed")
def retry_failed():
    ok, message, run_id = controller.retry_failed()
    return jsonify(ApiResult(ok=ok, message=message, run_id=run_id).to_dict())


@app.post("/api/login_check")
def login_check():
    payload = request.get_json(silent=True) or {}
    config = RunConfig.from_payload(payload)
    ok, message = controller.login_check(config)
    return jsonify(ApiResult(ok=ok, message=message).to_dict())


@app.post("/api/export_results")
def export_results():
    payload = request.get_json(silent=True) or {}
    destination_path = payload.get("destination_path")
    ok, message = controller.export_results(destination_path)
    return jsonify(ApiResult(ok=ok, message=message).to_dict())


@app.get("/api/download_log")
def download_log():
    snapshot = controller.get_status()
    if not snapshot.run_id:
        return jsonify({"ok": False, "message": "No run available."}), 404
    run = store.get_run(snapshot.run_id)
    if not run:
        return jsonify({"ok": False, "message": "Run metadata not found."}), 404
    run_dir = Path(run["working_workbook_path"]).parent
    csv_path = run_dir / "run_log.csv"
    if not csv_path.exists():
        store.export_run_csv(snapshot.run_id, csv_path)
    return send_file(csv_path, as_attachment=True, download_name=f"{snapshot.run_id}_log.csv")


def run() -> None:
    app.run(host=DEFAULT_SERVER_HOST, port=DEFAULT_SERVER_PORT, debug=False)

