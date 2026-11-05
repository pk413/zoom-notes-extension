# app.py — ZoomNotes Cloud Backend with Free NVIDIA NIM Integration
# Can be deployed to Render.com, Hugging Face Spaces, Railway, or Koyeb for free.

import os
import tempfile
import shutil
import logging
from fastapi import FastAPI, File, UploadFile, Form, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel
from openai import OpenAI

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("zoomnotes-cloud")

app = FastAPI(
    title="ZoomNotes Cloud Backend (NVIDIA NIM)",
    description="Processes Zoom meeting audio & uses NVIDIA NIM free endpoints for AI notes synthesis.",
    version="1.0.0"
)

# CORS: allow calls from any browser extension origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Whisper Model for Audio Transcription ────────────────────────────────────
# 'tiny.en' or 'base.en' runs fast on free tier CPU containers (Render / Hugging Face)
MODEL_SIZE = os.getenv("WHISPER_MODEL", "base.en")
logger.info(f"Loading Whisper model: {MODEL_SIZE}")
whisper_model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
logger.info("Whisper model loaded.")

# ─── NVIDIA NIM Client Configuration ──────────────────────────────────────────
# Free NVIDIA NIM endpoints: https://integrate.api.nvidia.com/v1
NVIDIA_BASE_URL = os.getenv("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1")
NVIDIA_DEFAULT_MODEL = os.getenv("NVIDIA_MODEL", "meta/llama-3.3-70b-instruct")

PROMPT_TEMPLATE = """You are an expert executive meeting note-taker.
{interim_prefix}Analyze the provided verbatim transcript from a Zoom meeting and extract structured meeting notes.

Format your response EXACTLY as follows (use these exact markdown headings):

## Key Discussion Points
- Bullet-point summary of main topics discussed

## Decisions Made
- Any decisions, conclusions, or agreements reached (write "None identified" if none)

## Action Items
- [ ] Task description — Owner (if mentioned) — Due date (if mentioned)
(write "None identified" if none)

## Important Quotes
> "Direct quote" — Speaker (if identifiable)
(omit section if none)

## Transcription
Full verbatim transcription of everything said in the audio.

Be concise, accurate, and professional."""


@app.get("/")
async def root():
    return {
        "service": "ZoomNotes Cloud Backend",
        "status": "online",
        "nvidia_endpoint": NVIDIA_BASE_URL,
        "nvidia_model": NVIDIA_DEFAULT_MODEL,
        "whisper_model": MODEL_SIZE
    }


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/v1/audio/transcriptions")
async def transcribe_only(
    file: UploadFile = File(...),
    language: str = Form(default="en")
):
    """OpenAI-compatible speech-to-text endpoint using faster-whisper."""
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    try:
        segments, info = whisper_model.transcribe(
            tmp_path,
            beam_size=1,
            language=language if language != "auto" else None,
            vad_filter=True
        )
        text = " ".join(s.text.strip() for s in segments)
        return {"text": text, "language": info.language, "duration": info.duration}
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


@app.post("/api/process-meeting")
async def process_meeting(
    file: UploadFile = File(...),
    is_interim: bool = Form(default=False),
    model: str = Form(default=None),
    authorization: str = Header(default=None)
):
    """
    End-to-End Meeting Processor:
    1. Transcribes audio segment with faster-whisper
    2. Sends transcript to NVIDIA NIM free endpoints for structured notes synthesis
    """
    # Resolve NVIDIA API key: request header or server env var
    api_key = None
    if authorization and authorization.startswith("Bearer "):
        api_key = authorization.replace("Bearer ", "").strip()
    if not api_key:
        api_key = os.getenv("NVIDIA_API_KEY")

    if not api_key:
        raise HTTPException(
            status_code=401,
            detail="Missing NVIDIA API Key. Provide it in Authorization header or set NVIDIA_API_KEY environment variable."
        )

    # 1. Transcribe
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    transcript = ""
    try:
        segments, _ = whisper_model.transcribe(tmp_path, beam_size=1, language="en", vad_filter=True)
        transcript = " ".join(s.text.strip() for s in segments)
    except Exception as e:
        logger.error(f"Whisper transcription error: {e}")
        transcript = "(Transcription unavailable due to audio processing error)"
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)

    if not transcript.strip():
        return {
            "transcript": "",
            "notes": "_(No audible speech detected in this meeting segment.)_"
        }

    # 2. Call NVIDIA NIM
    nim_model = model or NVIDIA_DEFAULT_MODEL
    logger.info(f"Calling NVIDIA NIM with model: {nim_model}")

    try:
        client = OpenAI(base_url=NVIDIA_BASE_URL, api_key=api_key)
        prefix = "[INTERIM NOTES — append to existing notes]\n" if is_interim else "[FINAL MEETING NOTES]\n"
        system_prompt = PROMPT_TEMPLATE.format(interim_prefix=prefix)

        response = client.chat.completions.create(
            model=nim_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"Meeting Audio Transcript:\n{transcript}"}
            ],
            temperature=0.2,
            max_tokens=4096
        )

        notes_markdown = response.choices[0].message.content
        return {
            "transcript": transcript,
            "notes": notes_markdown,
            "model_used": nim_model
        }

    except Exception as e:
        logger.error(f"NVIDIA NIM error: {e}")
        raise HTTPException(status_code=502, detail=f"NVIDIA NIM inference failed: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "7860"))
    uvicorn.run(app, host="0.0.0.0", port=port)
