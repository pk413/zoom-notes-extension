#!/bin/bash
# ZoomNotes Raspberry Pi Backend Setup Script
# Sets up Faster-Whisper API server + Ollama (Llama 3) on Raspberry Pi 4

set -e

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
ORANGE='\033[0;33m'
NC='\033[0m' # No Color

# ─── Banner ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${PURPLE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${PURPLE}║${NC}  ${RED}🍓${NC}  ${WHITE}ZoomNotes Raspberry Pi Backend Setup${NC}           ${PURPLE}║${NC}"
echo -e "${PURPLE}║${NC}      ${CYAN}Whisper API + Ollama (Llama 3) on Pi 4${NC}         ${PURPLE}║${NC}"
echo -e "${PURPLE}╚════════════════════════════════════════════════════════╝${NC}"
echo ""

# ─── Architecture Check ───────────────────────────────────────────────────────
ARCH=$(uname -m)
echo -e "${CYAN}[1/9]${NC} Checking architecture..."
if [ "$ARCH" != "aarch64" ]; then
    echo -e "${YELLOW}⚠  WARNING: Expected aarch64 (ARM64) but got '$ARCH'.${NC}"
    echo -e "${YELLOW}   This script is optimized for Raspberry Pi 4 (64-bit).${NC}"
    echo -e "${YELLOW}   Performance may be degraded or install may fail on other platforms.${NC}"
    echo ""
    read -r -p "Continue anyway? [y/N] " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        echo -e "${RED}Aborted.${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}✓  Architecture: $ARCH (Raspberry Pi 4 compatible)${NC}"
fi
echo ""

# ─── System Update ────────────────────────────────────────────────────────────
echo -e "${CYAN}[2/9]${NC} Updating package lists..."
sudo apt-get update -y
echo -e "${GREEN}✓  Package lists updated${NC}"
echo ""

# ─── System Dependencies ──────────────────────────────────────────────────────
echo -e "${CYAN}[3/9]${NC} Installing system dependencies (python3-pip, python3-venv, ffmpeg, curl, git)..."
sudo apt-get install -y python3-pip python3-venv ffmpeg curl git
echo -e "${GREEN}✓  System dependencies installed${NC}"
echo ""

# ─── Ollama Install ───────────────────────────────────────────────────────────
echo -e "${CYAN}[4/9]${NC} Installing Ollama..."
curl -fsSL https://ollama.com/install.sh | sh
echo -e "${GREEN}✓  Ollama installed${NC}"
echo ""

# ─── Start Ollama & Pull Model ────────────────────────────────────────────────
echo -e "${CYAN}[5/9]${NC} Starting Ollama and pulling Llama 3 model (llama3:8b-instruct-q4_0)..."
echo -e "${YELLOW}   This may take several minutes depending on your internet speed (~4-5 GB).${NC}"
ollama serve &
OLLAMA_PID=$!
echo -e "   Ollama started (PID $OLLAMA_PID), waiting 5 seconds for readiness..."
sleep 5
ollama pull llama3:8b-instruct-q4_0
echo -e "${GREEN}✓  Llama 3 model pulled successfully${NC}"
echo ""

# ─── Python Virtual Environment ───────────────────────────────────────────────
echo -e "${CYAN}[6/9]${NC} Creating Python virtual environment at ~/zomnotes-env..."
python3 -m venv ~/zomnotes-env
echo -e "   Installing Python packages: faster-whisper, fastapi, uvicorn, python-multipart..."
~/zomnotes-env/bin/pip install --upgrade pip
~/zomnotes-env/bin/pip install faster-whisper fastapi uvicorn python-multipart
echo -e "${GREEN}✓  Python environment ready${NC}"
echo ""

# ─── Copy whisper_server.py ───────────────────────────────────────────────────
echo -e "${CYAN}[7/9]${NC} Copying whisper_server.py to home directory..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/whisper_server.py" ]; then
    cp "$SCRIPT_DIR/whisper_server.py" ~/whisper_server.py
    echo -e "${GREEN}✓  whisper_server.py copied to ~/whisper_server.py${NC}"
else
    echo -e "${RED}✗  whisper_server.py not found next to install.sh at $SCRIPT_DIR${NC}"
    echo -e "${YELLOW}   Please place whisper_server.py in $SCRIPT_DIR and re-run, or copy it manually to ~/whisper_server.py${NC}"
    exit 1
fi
echo ""

# ─── Systemd: Whisper Service ─────────────────────────────────────────────────
echo -e "${CYAN}[8/9]${NC} Creating systemd services..."

CURRENT_USER="${SUDO_USER:-$USER}"
HOME_DIR=$(eval echo "~$CURRENT_USER")

echo -e "   Writing /etc/systemd/system/zomnotes-whisper.service ..."
sudo tee /etc/systemd/system/zomnotes-whisper.service > /dev/null <<EOF
[Unit]
Description=ZoomNotes Faster-Whisper Transcription API
After=network.target

[Service]
Type=simple
User=$CURRENT_USER
WorkingDirectory=$HOME_DIR
ExecStart=$HOME_DIR/zomnotes-env/bin/uvicorn whisper_server:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF

echo -e "   Writing /etc/systemd/system/zomnotes-ollama.service ..."
sudo tee /etc/systemd/system/zomnotes-ollama.service > /dev/null <<EOF
[Unit]
Description=ZoomNotes Ollama LLM Server (Llama 3)
After=network.target

[Service]
Type=simple
User=$CURRENT_USER
ExecStart=/usr/local/bin/ollama serve
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=OLLAMA_HOST=0.0.0.0

[Install]
WantedBy=multi-user.target
EOF

echo -e "${GREEN}✓  Systemd service files written${NC}"
echo ""

# ─── Enable & Start Services ──────────────────────────────────────────────────
echo -e "${CYAN}[9/9]${NC} Enabling and starting services..."

# Stop the background ollama we started earlier (systemd will manage it now)
kill "$OLLAMA_PID" 2>/dev/null || true
sleep 2

sudo systemctl daemon-reload

sudo systemctl enable zomnotes-ollama.service
sudo systemctl start  zomnotes-ollama.service
echo -e "   ${GREEN}✓  zomnotes-ollama started${NC}"

sudo systemctl enable zomnotes-whisper.service
sudo systemctl start  zomnotes-whisper.service
echo -e "   ${GREEN}✓  zomnotes-whisper started${NC}"

echo ""
sleep 3  # give services a moment to settle

# ─── Service Status ───────────────────────────────────────────────────────────
echo -e "${CYAN}Service Status:${NC}"
echo -e "  Ollama:  $(sudo systemctl is-active zomnotes-ollama.service)"
echo -e "  Whisper: $(sudo systemctl is-active zomnotes-whisper.service)"
echo ""

# ─── Final Banner ─────────────────────────────────────────────────────────────
echo -e "${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║${NC}  ${GREEN}✅  ZoomNotes Pi Backend Ready!${NC}                      ${GREEN}║${NC}"
echo -e "${GREEN}╠════════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC}                                                        ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ${WHITE}Services:${NC}                                              ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}    ${CYAN}Ollama (Llama 3):${NC}  http://rpi.local:11434           ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}    ${CYAN}Whisper API:${NC}       http://rpi.local:8000             ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                                        ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ${WHITE}Test with:${NC}                                             ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}    curl http://rpi.local:8000/health                   ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}    curl http://rpi.local:11434/api/tags                ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                                        ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ${WHITE}Configure in ZoomNotes extension:${NC}                     ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}    Settings → Raspberry Pi Backend                    ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}    Use hostname: ${ORANGE}http://rpi.local${NC}                     ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                                        ${GREEN}║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}Tip:${NC} View logs with:  journalctl -u zomnotes-whisper -f"
echo -e "${YELLOW}Tip:${NC} View logs with:  journalctl -u zomnotes-ollama  -f"
echo ""
