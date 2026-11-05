---
title: ZoomNotes NVIDIA NIM Backend
emoji: 🎙️
colorFrom: indigo
colorTo: purple
sdk: docker
pinned: false
app_port: 7860
---

# 🎙️ ZoomNotes Cloud Backend (Hugging Face Spaces + NVIDIA NIM)

A containerized backend service running **faster-whisper** audio transcription and routing structured note synthesis to **NVIDIA NIM's free serverless endpoints** (`https://integrate.api.nvidia.com/v1`).

---

## 🚀 Setup on Hugging Face Spaces (3-Minute Setup)

### Step 1: Create Space
1. Log in to [Hugging Face](https://huggingface.co/) (create a free account if you don't have one).
2. Go to [huggingface.co/new-space](https://huggingface.co/new-space).
3. Name: `zoomnotes-backend`
4. Space SDK: Select **Docker** (Blank).
5. Visibility: **Public** (or Private).
6. Click **Create Space**.

---

### Step 2: Upload Files
In your new Space repository, upload the 3 files from this folder:
- `Dockerfile`
- `requirements.txt`
- `app.py`
- (and this `README.md`)

*You can drag-and-drop them via the "Files" tab in your Hugging Face Space, or push via git.*

---

### Step 3: Add Your Free NVIDIA API Key
1. Get a free API key at [build.nvidia.com](https://build.nvidia.com) (starts with `nvapi-...`).
2. In your Space, go to **Settings** → **Variables and secrets**.
3. Under **Secrets**, click **New secret**:
   - **Name:** `NVIDIA_API_KEY`
   - **Value:** `nvapi-your-key-here`
4. Click **Save**.

Your Space will build and launch in ~1-2 minutes.

---

### Step 4: Connect to the Browser Extension
1. When your Space status turns to **Running**, copy its Direct URL:
   - Click the `...` menu (top-right of Space) → **Embed this space** or view URL:
   `https://<your-username>-zoomnotes-backend.hf.space`
2. Open your ZoomNotes browser extension → ⚙️ **Settings**.
3. Select **🚀 NVIDIA NIM (Cloud Backend)**.
4. Paste your Space URL in **Hosted Backend URL**:
   `https://<your-username>-zoomnotes-backend.hf.space`
5. Click **Test Backend** — it will verify with a green checkmark!
