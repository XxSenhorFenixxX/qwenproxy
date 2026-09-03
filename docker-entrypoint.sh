#!/usr/bin/env bash
set -euo pipefail

ensure_writable_dir() {
  mkdir -p "$1"
  if [ "$(id -u)" = "0" ]; then
    chown -R pwuser:pwuser "$1" 2>/dev/null || true
  fi
}

ensure_writable_dir /app/data
ensure_writable_dir /app/qwen_profiles
ensure_writable_dir /tmp/playwright

# Start Xvfb detached so it survives exec
export DISPLAY=:99
nohup gosu pwuser Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp > /dev/null 2>&1 &
sleep 2

exec gosu pwuser "$@"
