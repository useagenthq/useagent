#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="${USEAGENT_DEMO_DIR:-$HOME/Desktop/skynet-demo}"
SCREEN_DEVICE="${USEAGENT_SCREEN_DEVICE:-Capture screen 0}"
CLICK_BIN="${USEAGENT_CLICLICK_BIN:-cliclick}"
FFMPEG_BIN="${USEAGENT_FFMPEG_BIN:-ffmpeg}"
FFPROBE_BIN="${USEAGENT_FFPROBE_BIN:-ffprobe}"
SCREENSHOT_BIN="${USEAGENT_SCREENSHOT_BIN:-screencapture}"
OSASCRIPT_BIN="${USEAGENT_OSASCRIPT_BIN:-osascript}"
PYTHON_BIN="${USEAGENT_PYTHON_BIN:-/usr/bin/python3}"

dry_run=0

usage() {
  cat <<'EOF'
Usage:
  mac-demo-harness.sh [global flags] start --scenario SCENARIO --engine ENGINE [--label LABEL]
  mac-demo-harness.sh [global flags] stop [--session-dir DIR] [--redacted]
  mac-demo-harness.sh [global flags] pause [--session-dir DIR]
  mac-demo-harness.sh [global flags] status [--session-dir DIR]
  mac-demo-harness.sh [global flags] click X Y
  mac-demo-harness.sh [global flags] double-click X Y
  mac-demo-harness.sh [global flags] right-click X Y
  mac-demo-harness.sh [global flags] move X Y
  mac-demo-harness.sh [global flags] drag X1 Y1 X2 Y2
  mac-demo-harness.sh [global flags] type TEXT...
  mac-demo-harness.sh [global flags] key KEY
  mac-demo-harness.sh [global flags] hotkey MOD... KEY
  mac-demo-harness.sh [global flags] shot [NAME]
  mac-demo-harness.sh [global flags] focus APP NAME...
  mac-demo-harness.sh [global flags] fullscreen

Global flags:
  --dry-run
  --base-dir DIR
  --screen-device NAME

Defaults:
  base dir: ~/Desktop/skynet-demo
  screen device: Capture screen 0
EOF
}

die() {
  printf 'mac-demo-harness: %s\n' "$*" >&2
  exit 1
}

sanitize_slug() {
  local value="${1:-}"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9._-' '-')"
  value="${value##-}"
  value="${value%%-}"
  while [[ "$value" == *"--"* ]]; do
    value="${value//--/-}"
  done
  printf '%s' "${value:-session}"
}

now_utc() {
  if [[ -n "${USEAGENT_DEMO_CREATED_AT:-}" ]]; then
    printf '%s' "$USEAGENT_DEMO_CREATED_AT"
    return 0
  fi
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

compact_utc() {
  if [[ -n "${USEAGENT_DEMO_SESSION_ID:-}" ]]; then
    printf '%s' "$(sanitize_slug "$USEAGENT_DEMO_SESSION_ID")"
    return 0
  fi
  date -u +"%Y%m%dT%H%M%SZ"
}

session_link() {
  printf '%s/current' "$BASE_DIR"
}

write_session_json() {
  local session_dir="$1"
  local session_id="$2"
  local scenario_slug="$3"
  local engine_slug="$4"
  local label_slug="$5"
  local created_at="$6"
  local status="$7"
  local redacted="$8"
  local video_path="$9"
  local pid_file="${10}"
  local log_file="${11}"
  local pid="${12}"
  local started_at="${13}"
  local stopped_at="${14}"
  local codec="${15}"
  local width="${16}"
  local height="${17}"
  local duration="${18}"
  local size_bytes="${19}"

  local sidecar_path="$session_dir/$session_id.json"
  cat >"$sidecar_path" <<EOF
{
  "session_id": "$session_id",
  "session_dir": "$session_dir",
  "scenario_slug": "$scenario_slug",
  "engine_slug": "$engine_slug",
  "label_slug": "$label_slug",
  "created_at": "$created_at",
  "recording": {
    "status": "$status",
    "redaction_boundary": $redacted,
    "video_path": "$video_path",
    "pid_file": "$pid_file",
    "log_file": "$log_file",
    "pid": $pid,
    "started_at": "$started_at",
    "stopped_at": "$stopped_at",
    "codec": "$codec",
    "width": $width,
    "height": $height,
    "duration_seconds": $duration,
    "size_bytes": $size_bytes,
    "screen_device": "$SCREEN_DEVICE",
    "capture_tool": "$FFMPEG_BIN",
    "control_tool": "$CLICK_BIN",
    "screenshot_tool": "$SCREENSHOT_BIN",
    "script_tool": "$OSASCRIPT_BIN"
  }
}
EOF
}

print_start_plan() {
  local session_dir="$1"
  local session_id="$2"
  local video_path="$3"
  local sidecar_path="$4"
  local pid_file="$5"
  local log_file="$6"
  cat <<EOF
session_id=$session_id
session_dir=$session_dir
video_path=$video_path
sidecar_path=$sidecar_path
pid_file=$pid_file
log_file=$log_file
ffmpeg: $FFMPEG_BIN -y -hide_banner -loglevel error -f avfoundation -capture_cursor 1 -capture_mouse_clicks 1 -pixel_format bgr0 -i "$SCREEN_DEVICE:none" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "$video_path"
EOF
}

print_stop_plan() {
  local session_dir="$1"
  local video_path="$2"
  local sidecar_path="$3"
  local pid_file="$4"
  local redacted="$5"
  cat <<EOF
session_dir=$session_dir
video_path=$video_path
sidecar_path=$sidecar_path
pid_file=$pid_file
redaction_boundary=$redacted
stop: kill -INT "\$(cat "$pid_file")" && wait-for-exit && ffprobe -hide_banner -loglevel error -show_entries stream=codec_name,width,height -show_entries format=duration,size -of default=noprint_wrappers=1 "$video_path"
EOF
}

ensure_base_dir() {
  mkdir -p "$BASE_DIR"
}

start_recording() {
  local scenario_slug="$1"
  local engine_slug="$2"
  local label_slug="$3"
  local session_id="$4"
  local session_dir="$5"
  local sidecar_path="$6"
  local video_path="$7"
  local pid_file="$8"
  local log_file="$9"

  if [[ -e "$pid_file" ]]; then
    die "recording already active for $session_id"
  fi

  if [[ "$dry_run" -eq 1 ]]; then
    print_start_plan "$session_dir" "$session_id" "$video_path" "$sidecar_path" "$pid_file" "$log_file"
    return 0
  fi

  mkdir -p "$session_dir"
  local created_at
  created_at="$(now_utc)"
  write_session_json "$session_dir" "$session_id" "$scenario_slug" "$engine_slug" "$label_slug" "$created_at" \
    "recording" "false" "$video_path" "$pid_file" "$log_file" 0 "$created_at" "" "" 0 0 0 0

  local pid
  pid="$(
    "$PYTHON_BIN" - "$log_file" \
      "$FFMPEG_BIN" \
      -y \
      -hide_banner \
      -loglevel error \
      -f avfoundation \
      -capture_cursor 1 \
      -capture_mouse_clicks 1 \
      -pixel_format bgr0 \
      -i "$SCREEN_DEVICE:none" \
      -c:v libx264 \
      -pix_fmt yuv420p \
      -movflags +faststart \
      "$video_path" <<'PY'
import os
import sys

log_path = sys.argv[1]
command = sys.argv[2:]
read_fd, write_fd = os.pipe()

first_pid = os.fork()
if first_pid:
    os.close(write_fd)
    detached_pid = os.read(read_fd, 64).decode("ascii")
    os.close(read_fd)
    _, status = os.waitpid(first_pid, 0)
    if status != 0 or not detached_pid:
        raise SystemExit(1)
    print(detached_pid, end="")
    raise SystemExit(0)

os.close(read_fd)
os.setsid()
detached_pid = os.fork()
if detached_pid:
    os.write(write_fd, str(detached_pid).encode("ascii"))
    os.close(write_fd)
    os._exit(0)

os.close(write_fd)
stdin_fd = os.open(os.devnull, os.O_RDONLY)
log_fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
os.dup2(stdin_fd, 0)
os.dup2(log_fd, 1)
os.dup2(log_fd, 2)
os.close(stdin_fd)
os.close(log_fd)
os.chdir("/")
os.execvp(command[0], command)
PY
  )"
  printf '%s\n' "$pid" >"$pid_file"
  ln -sfn "$session_dir" "$(session_link)"
  write_session_json "$session_dir" "$session_id" "$scenario_slug" "$engine_slug" "$label_slug" "$created_at" \
    "recording" "false" "$video_path" "$pid_file" "$log_file" "$pid" "$created_at" "" "" 0 0 0 0
  printf 'recording_started=%s\n' "$video_path"
  printf 'session_json=%s\n' "$sidecar_path"
}

wait_for_pid_exit() {
  local pid="$1"
  local attempts=40
  while kill -0 "$pid" 2>/dev/null && [[ "$attempts" -gt 0 ]]; do
    sleep 0.25
    attempts=$((attempts - 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    attempts=20
    while kill -0 "$pid" 2>/dev/null && [[ "$attempts" -gt 0 ]]; do
      sleep 0.25
      attempts=$((attempts - 1))
    done
  fi
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
}

stop_recording() {
  local redacted="$1"
  local session_dir="${2:-}"
  if [[ -z "$session_dir" ]]; then
    session_dir="$(readlink "$(session_link)" 2>/dev/null || true)"
  fi
  [[ -n "$session_dir" ]] || die "no session dir provided and $(session_link) is absent"
  [[ -d "$session_dir" ]] || die "session dir does not exist: $session_dir"

  local session_id
  session_id="$(basename "$session_dir")"
  local sidecar_path="$session_dir/$session_id.json"
  local video_path="$session_dir/$session_id.mp4"
  local pid_file="$session_dir/$session_id.pid"
  local log_file="$session_dir/$session_id.ffmpeg.log"

  if [[ "$dry_run" -eq 1 ]]; then
    print_stop_plan "$session_dir" "$video_path" "$sidecar_path" "$pid_file" "$redacted"
    return 0
  fi

  local pid=0
  if [[ -f "$pid_file" ]]; then
    pid="$(cat "$pid_file")"
    [[ "$pid" =~ ^[0-9]+$ ]] || die "invalid pid file: $pid_file"
    kill -INT "$pid" 2>/dev/null || true
    wait_for_pid_exit "$pid"
    rm -f "$pid_file"
  fi

  [[ -f "$video_path" ]] || die "recording file missing: $video_path"
  local probe
  probe="$("$FFPROBE_BIN" -hide_banner -loglevel error \
    -show_entries stream=codec_name,width,height \
    -show_entries format=duration,size \
    -of default=noprint_wrappers=1 \
    "$video_path")"

  local codec width height duration size_bytes
  codec="$(printf '%s\n' "$probe" | awk -F= '/^codec_name=/{print $2; exit}')"
  width="$(printf '%s\n' "$probe" | awk -F= '/^width=/{print $2; exit}')"
  height="$(printf '%s\n' "$probe" | awk -F= '/^height=/{print $2; exit}')"
  duration="$(printf '%s\n' "$probe" | awk -F= '/^duration=/{print $2; exit}')"
  size_bytes="$(printf '%s\n' "$probe" | awk -F= '/^size=/{print $2; exit}')"

  [[ "$codec" == "h264" ]] || die "unexpected codec: $codec"
  [[ "$width" =~ ^[0-9]+$ ]] || die "invalid width: $width"
  [[ "$height" =~ ^[0-9]+$ ]] || die "invalid height: $height"
  [[ "$size_bytes" =~ ^[0-9]+$ ]] || die "invalid size: $size_bytes"
  [[ "$duration" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "invalid duration: $duration"

  local started_at stopped_at created_at scenario_slug engine_slug label_slug
  if [[ -f "$sidecar_path" ]]; then
    created_at="$(sed -n 's/^  "created_at": "\(.*\)",$/\1/p' "$sidecar_path" | head -n1)"
    scenario_slug="$(sed -n 's/^  "scenario_slug": "\(.*\)",$/\1/p' "$sidecar_path" | head -n1)"
    engine_slug="$(sed -n 's/^  "engine_slug": "\(.*\)",$/\1/p' "$sidecar_path" | head -n1)"
    label_slug="$(sed -n 's/^  "label_slug": "\(.*\)",$/\1/p' "$sidecar_path" | head -n1)"
    started_at="$(sed -n 's/^    "started_at": "\(.*\)",$/\1/p' "$sidecar_path" | head -n1)"
  else
    created_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    scenario_slug="session"
    engine_slug="session"
    label_slug="session"
    started_at="$created_at"
  fi
  stopped_at="$(now_utc)"

  write_session_json "$session_dir" "$session_id" "$scenario_slug" "$engine_slug" "$label_slug" "$created_at" \
    "$([[ "$redacted" == "true" ]] && printf '%s' 'paused' || printf '%s' 'complete')" \
    "$redacted" "$video_path" "$pid_file" "$log_file" 0 "$started_at" "$stopped_at" \
    "$codec" "$width" "$height" "$duration" "$size_bytes"

  printf 'recording_complete=%s\n' "$video_path"
  printf 'session_json=%s\n' "$sidecar_path"
  printf 'codec=%s width=%s height=%s duration=%s size=%s\n' "$codec" "$width" "$height" "$duration" "$size_bytes"
}

capture_shot() {
  local name="${1:-shot-$(compact_utc)}"
  local session_dir="${2:-}"
  if [[ -z "$session_dir" ]]; then
    session_dir="$(readlink "$(session_link)" 2>/dev/null || true)"
  fi
  [[ -n "$session_dir" ]] || die "no session dir provided and $(session_link) is absent"
  mkdir -p "$session_dir"
  local shot_path="$session_dir/$name.png"
  if [[ "$dry_run" -eq 1 ]]; then
    printf 'screencapture: %s -x %q\n' "$SCREENSHOT_BIN" "$shot_path"
    return 0
  fi
  "$SCREENSHOT_BIN" -x "$shot_path"
  printf '%s\n' "$shot_path"
}

click_point() {
  local kind="$1"
  local x="$2"
  local y="$3"
  local command
  case "$kind" in
    click) command="c:$x,$y" ;;
    double-click) command="dc:$x,$y" ;;
    right-click) command="rc:$x,$y" ;;
    move) command="m:$x,$y" ;;
    *) die "unsupported mouse command: $kind" ;;
  esac
  if [[ "$dry_run" -eq 1 ]]; then
    printf 'cliclick: %s %s\n' "$CLICK_BIN" "$command"
    return 0
  fi
  "$CLICK_BIN" "$command"
}

drag_point() {
  local x1="$1"
  local y1="$2"
  local x2="$3"
  local y2="$4"
  if [[ "$dry_run" -eq 1 ]]; then
    printf 'cliclick: %s dd:%s,%s dm:%s,%s du:%s,%s\n' "$CLICK_BIN" "$x1" "$y1" "$x2" "$y2" "$x2" "$y2"
    return 0
  fi
  "$CLICK_BIN" "dd:$x1,$y1" "dm:$x2,$y2" "du:$x2,$y2"
}

type_text() {
  local text="$*"
  if [[ "$dry_run" -eq 1 ]]; then
    printf 'cliclick: %s t:%s\n' "$CLICK_BIN" "$text"
    return 0
  fi
  "$CLICK_BIN" "t:$text"
}

press_key() {
  local key="$1"
  if [[ "$dry_run" -eq 1 ]]; then
    printf 'cliclick: %s kp:%s\n' "$CLICK_BIN" "$key"
    return 0
  fi
  "$CLICK_BIN" "kp:$key"
}

hotkey() {
  if [[ "$#" -lt 2 ]]; then
    die "hotkey requires at least one modifier and one key"
  fi
  local key="${@: -1}"
  local mods=("${@:1:$#-1}")
  local modarg
  modarg="$(IFS=,; printf '%s' "${mods[*]}")"
  if [[ "$key" =~ ^[[:print:]]$ ]]; then
    local apple_mods=()
    local modifier
    for modifier in "${mods[@]}"; do
      case "$modifier" in
        cmd|command) apple_mods+=("command down") ;;
        shift) apple_mods+=("shift down") ;;
        ctrl|control) apple_mods+=("control down") ;;
        alt|option) apple_mods+=("option down") ;;
        *) die "unsupported hotkey modifier: $modifier" ;;
      esac
    done
    local apple_modarg
    apple_modarg="$(IFS=,; printf '%s' "${apple_mods[*]}")"
    local script="tell application \"System Events\" to keystroke \"$key\" using {$apple_modarg}"
    if [[ "$dry_run" -eq 1 ]]; then
      printf 'osascript: %s -e %q\n' "$OSASCRIPT_BIN" "$script"
      return 0
    fi
    "$OSASCRIPT_BIN" -e "$script"
    return 0
  fi
  if [[ "$dry_run" -eq 1 ]]; then
    printf 'cliclick: %s kd:%s kp:%s ku:%s\n' "$CLICK_BIN" "$modarg" "$key" "$modarg"
    return 0
  fi
  "$CLICK_BIN" "kd:$modarg" "kp:$key" "ku:$modarg"
}

focus_app() {
  local app="$*"
  if [[ "$dry_run" -eq 1 ]]; then
    printf 'osascript: %s -e %q\n' "$OSASCRIPT_BIN" "tell application \"$app\" to activate"
    return 0
  fi
  "$OSASCRIPT_BIN" -e "tell application \"$app\" to activate"
}

toggle_fullscreen() {
  if [[ "$dry_run" -eq 1 ]]; then
    printf 'osascript: %s -e %q\n' "$OSASCRIPT_BIN" 'tell application "System Events" to keystroke "f" using {control down, command down}'
    return 0
  fi
  "$OSASCRIPT_BIN" -e 'tell application "System Events" to keystroke "f" using {control down, command down}'
}

if [[ "$#" -eq 0 ]]; then
  usage
  exit 1
fi

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --base-dir)
      [[ $# -ge 2 ]] || die "--base-dir requires a value"
      BASE_DIR="$2"
      shift 2
      ;;
    --screen-device)
      [[ $# -ge 2 ]] || die "--screen-device requires a value"
      SCREEN_DEVICE="$2"
      shift 2
      ;;
    start|stop|pause|status|click|double-click|right-click|move|drag|type|key|hotkey|shot|focus|fullscreen)
      command="$1"
      shift
      break
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown global flag or command: $1"
      ;;
  esac
done

case "${command:-}" in
  start)
    scenario=""
    engine=""
    label="demo"
    while [[ "$#" -gt 0 ]]; do
      case "$1" in
        --scenario)
          [[ $# -ge 2 ]] || die "--scenario requires a value"
          scenario="$2"
          shift 2
          ;;
        --engine)
          [[ $# -ge 2 ]] || die "--engine requires a value"
          engine="$2"
          shift 2
          ;;
        --label)
          [[ $# -ge 2 ]] || die "--label requires a value"
          label="$2"
          shift 2
          ;;
        -h|--help)
          usage
          exit 0
          ;;
        *)
          die "unexpected start argument: $1"
          ;;
      esac
    done
    [[ -n "$scenario" ]] || die "--scenario is required"
    [[ -n "$engine" ]] || die "--engine is required"
    ensure_base_dir
    scenario_slug="$(sanitize_slug "$scenario")"
    engine_slug="$(sanitize_slug "$engine")"
    label_slug="$(sanitize_slug "$label")"
    session_id="$(compact_utc)--${scenario_slug}--${engine_slug}--${label_slug}"
    session_dir="$BASE_DIR/$session_id"
    sidecar_path="$session_dir/$session_id.json"
    video_path="$session_dir/$session_id.mp4"
    pid_file="$session_dir/$session_id.pid"
    log_file="$session_dir/$session_id.ffmpeg.log"
    start_recording "$scenario_slug" "$engine_slug" "$label_slug" "$session_id" "$session_dir" "$sidecar_path" "$video_path" "$pid_file" "$log_file"
    ;;
  stop|pause)
    redacted="false"
    session_dir=""
    while [[ "$#" -gt 0 ]]; do
      case "$1" in
        --session-dir)
          [[ $# -ge 2 ]] || die "--session-dir requires a value"
          session_dir="$2"
          shift 2
          ;;
        --redacted)
          redacted="true"
          shift
          ;;
        -h|--help)
          usage
          exit 0
          ;;
        *)
          die "unexpected ${command} argument: $1"
          ;;
      esac
    done
    [[ "$command" != "pause" ]] || redacted="true"
    stop_recording "$redacted" "$session_dir"
    ;;
  status)
    session_dir=""
    while [[ "$#" -gt 0 ]]; do
      case "$1" in
        --session-dir)
          [[ $# -ge 2 ]] || die "--session-dir requires a value"
          session_dir="$2"
          shift 2
          ;;
        -h|--help)
          usage
          exit 0
          ;;
        *)
          die "unexpected status argument: $1"
          ;;
      esac
    done
    if [[ -z "$session_dir" ]]; then
      session_dir="$(readlink "$(session_link)" 2>/dev/null || true)"
    fi
    [[ -n "$session_dir" ]] || die "no session dir provided and $(session_link) is absent"
    session_id="$(basename "$session_dir")"
    sidecar_path="$session_dir/$session_id.json"
    pid_file="$session_dir/$session_id.pid"
    if [[ -f "$sidecar_path" ]]; then
      cat "$sidecar_path"
    else
      printf 'session_dir=%s\n' "$session_dir"
      printf 'pid_file=%s\n' "$pid_file"
      printf 'status=missing\n'
    fi
    ;;
  click|double-click|right-click|move)
    [[ $# -eq 2 ]] || die "$command expects X Y"
    click_point "$command" "$1" "$2"
    ;;
  drag)
    [[ $# -eq 4 ]] || die "drag expects X1 Y1 X2 Y2"
    drag_point "$1" "$2" "$3" "$4"
    ;;
  type)
    [[ $# -ge 1 ]] || die "type expects text"
    type_text "$*"
    ;;
  key)
    [[ $# -eq 1 ]] || die "key expects one key"
    press_key "$1"
    ;;
  hotkey)
    [[ $# -ge 2 ]] || die "hotkey expects modifiers plus key"
    hotkey "$@"
    ;;
  shot)
    session_dir=""
    if [[ "$#" -gt 0 && "$1" == "--session-dir" ]]; then
      [[ $# -ge 2 ]] || die "--session-dir requires a value"
      session_dir="$2"
      shift 2
    fi
    [[ "$#" -le 1 ]] || die "shot accepts at most one name"
    capture_shot "${1:-}" "$session_dir"
    ;;
  focus)
    [[ $# -ge 1 ]] || die "focus expects an app name"
    focus_app "$*"
    ;;
  fullscreen)
    toggle_fullscreen
    ;;
  "")
    usage
    exit 1
    ;;
  *)
    die "unknown command: $command"
    ;;
esac
