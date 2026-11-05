# 🎙️ ZoomNotes — Multi-Meeting Notes Recorder

A powerful Manifest V3 browser extension for **Chrome, Brave, and Edge (Bing)** that silently captures audio and periodic screenshots from up to **three simultaneous Zoom browser tabs**, synthesizes structured executive notes via **NVIDIA NIM, Gemini 2.5 Flash, or local Raspberry Pi 4**, and streams notes live to a dashboard while synchronizing them to **Notion**.

---

## 🌟 Key Features

- **Multi-Tab Simultaneous Recording**: Attend up to 3 Zoom meetings concurrently in separate browser tabs under one browser profile.
- **Audio Passthrough**: Web Audio API `AudioContext` keeps local audio playing through your headphones/speakers while capturing the streams.
- **Automated Screenshots**: Captures tab viewports every 30 seconds for visual slide/presentation context.
- **Flexible AI Backends**:
  - **🚀 NVIDIA NIM (Cloud)**: Connect to free serverless NIM endpoints (`https://integrate.api.nvidia.com/v1`) via a deployable container on **Render**, **Hugging Face Spaces**, or **Railway**.
  - **☁️ Google Gemini 2.5 Flash**: Direct multimodal audio processing on Google AI Studio's free tier.
  - **🍓 Raspberry Pi 4**: 100% offline edge processing with `faster-whisper` and Ollama `llama3:8b-instruct-q4_0`.
- **Live 3-Column Dashboard**: View live screenshots and incremental notes every 5 minutes.
- **Notion Sync**: Automatically creates databases and formatted pages with action items (`to_do`), decisions, and collapsable verbatim transcripts.
- **Markdown Export**: Automatically downloads formatted `.md` files upon meeting completion.

---

## 📁 Repository Structure

```
zoom-notes-extension/
├── manifest.json              # Chrome / Chromium Manifest V3 config
├── background.js              # Service worker (alarms, sessions, Notion sync)
├── offscreen.html / .js       # Hidden DOM context for audio capture + passthrough
├── notes-processor.js         # Multi-backend AI notes generator
├── notion-client.js           # Notion REST API connector
├── popup.html / .js / .css    # Toolbar popup controller
├── dashboard.html / .js / .css# 3-column live dashboard
├── settings.html / .js / .css # Settings and backend tester
├── icon.png                   # 128x128 extension icon
│
├── cloud-backend/             # ☁️ Deployable cloud service with free NVIDIA NIM
│   ├── app.py                 # FastAPI server (Whisper + NVIDIA NIM)
│   ├── Dockerfile             # Container build for Hugging Face / Render / Railway
│   ├── requirements.txt       # Python dependencies
│   └── README.md              # 1-click cloud deployment guide
│
└── raspberry-pi-setup/        # 🍓 Local edge server setup
    ├── install.sh             # 1-command installer script for Pi 4
    └── whisper_server.py      # Local FastAPI faster-whisper server
```

---

## 🌐 Browser Compatibility

This extension runs on **all modern Chromium-based browsers**:
- **Google Chrome** (`chrome://extensions`)
- **Brave Browser** (`brave://extensions`)
- **Microsoft Edge / Bing** (`edge://extensions`)

### Installation in Brave or Edge:
1. Open `brave://extensions` (or `edge://extensions`).
2. Toggle on **Developer mode**.
3. Click **Load unpacked** and select the root directory of this repository.

---

## ☁️ Deploying to Free Cloud Hosting (NVIDIA NIM)

To deploy the backend to a free host:
1. Go to [build.nvidia.com](https://build.nvidia.com) and get a free API key (`nvapi-...`).
2. Deploy the `cloud-backend/` directory to **Hugging Face Spaces** (Docker) or **Render.com** (Free Web Service).
3. Set the environment variable `NVIDIA_API_KEY = nvapi-...`.
4. Copy your service URL (e.g. `https://your-app.onrender.com`) into the extension settings.
5. See [`cloud-backend/README.md`](cloud-backend/README.md) for detailed step-by-step instructions.

---

## 🍓 Raspberry Pi 4 Local Setup

1. Copy `raspberry-pi-setup` to your Pi: `scp -r raspberry-pi-setup pi@rpi.local:~/`
2. Run `./install.sh` on the Pi.
3. Configure the extension settings with `http://rpi.local`.

---

## 📜 License
MIT License.
