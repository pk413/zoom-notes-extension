# ZoomNotes Whisper API Server
# Runs on Raspberry Pi 4 — provides OpenAI-compatible transcription endpoint
# Start: uvicorn whisper_server:app --host 0.0.0.0 --port 8000
#
# Environment variables:
#   WHISPER_MODEL  - Model size to use (default: "base.en")
#                    Options: tiny.en, base.en, small.en, medium.en
#                    'base.en' is recommended for Pi 4; 'small.en' for better accuracy

from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel
import tempfile
import shutil
import os
import time
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="ZoomNotes Whisper API", version="1.0.0")

# Allow requests from Chrome extensions and any other origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Model Loading ────────────────────────────────────────────────────────────
# Load at startup so the first request is not penalised by model load time.
# Use 'model_instance' as the global name to avoid conflict with the
# 'model' Form parameter in the transcription endpoint.
MODEL_SIZE = os.getenv("WHISPER_MODEL", "base.en")
logger.info(f"Loading Whisper model: {MODEL_SIZE}  (device=cpu, compute_type=int8)")
model_instance: WhisperModel = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
logger.info("Whisper model loaded successfully — server ready.")


# ─── Health Endpoint ──────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    """Quick liveness / readiness probe."""
    return {
        "status": "ok",
        "model": MODEL_SIZE,
        "device": "cpu",
        "compute_type": "int8",
    }


# ─── Transcription Endpoint (OpenAI-compatible) ───────────────────────────────
@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form(default="whisper-1"),        # accepted but ignored; model_instance is used
    language: str = Form(default="en"),
    response_format: str = Form(default="json"),
):
    """
    Transcribe an audio/video file.

    Compatible with the OpenAI /v1/audio/transcriptions API so the extension
    can point to this server instead of OpenAI without code changes.

    Supported formats: webm, mp4, mp3, wav, ogg, m4a (anything ffmpeg handles).
    """
    start_time = time.time()

    # Determine file extension for the temp file so ffmpeg can detect the format.
    original_name = file.filename or "audio.webm"
    suffix = os.path.splitext(original_name)[1] or ".webm"

    # Write upload to a temp file
    tmp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            shutil.copyfileobj(file.file, tmp)
            tmp_path = tmp.name

        logger.info(f"Transcribing '{original_name}' → temp file '{tmp_path}' (suffix={suffix})")

        # Transcribe with Faster-Whisper
        segments, info = model_instance.transcribe(
            tmp_path,
            beam_size=1,                                   # beam_size=1 → greedy, fastest on Pi
            language=language if language != "auto" else None,
            vad_filter=True,                               # skip silent sections
            vad_parameters=dict(min_silence_duration_ms=500),
        )

        # Materialise the lazy segment generator
        text = " ".join(segment.text.strip() for segment in segments)
        elapsed = round(time.time() - start_time, 2)
        logger.info(f"Transcription complete in {elapsed}s — {len(text)} chars, lang={info.language}")

        return {
            "text": text,
            "language": info.language,
            "duration": info.duration,
            "processing_time": elapsed,
        }

    except Exception as exc:
        logger.error(f"Transcription failed: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))

    finally:
        # Always clean up the temp file
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)
