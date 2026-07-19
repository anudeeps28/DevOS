#!/bin/bash
# add-label.sh — Todoist adapter
# Usage: bash .claude/trackers/active/add-label.sh <TASK_ID> "<label>"
# Adds a label to the specified task. td's --labels REPLACES the label set,
# so this reads current labels first and appends.

set -o pipefail

TASK_ID="${1:-}"
LABEL="${2:-}"

if [ -z "$TASK_ID" ] || [ -z "$LABEL" ]; then
  echo '{"error": "Usage: add-label.sh <TASK_ID> \"<label>\""}' >&2
  exit 1
fi

TD="${TODOIST_CLI:-td}"

if ! command -v "$TD" &>/dev/null; then
  echo '{"error": "Todoist CLI (td) not found. Install it or set TODOIST_CLI."}' >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo '{"error": "jq is required. Install from https://jqlang.github.io/jq/download/"}' >&2
  exit 1
fi

source "$(dirname "$0")/../lib/retry.sh"
source "$(dirname "$0")/../lib/auth-check.sh"
check_auth_todoist

TASK_JSON=$(with_retry "$TD" task view "id:${TASK_ID}" --json)

if [ -z "$TASK_JSON" ]; then
  echo '{"error": "Failed to fetch task"}' >&2
  exit 1
fi

if echo "$TASK_JSON" | jq -e --arg l "$LABEL" '.labels // [] | index($l)' >/dev/null; then
  echo "Label '$LABEL' already exists on task #${TASK_ID}"
  exit 0
fi

current=$(echo "$TASK_JSON" | jq -r '.labels // [] | join(",")')
if [ -z "$current" ]; then
  new_labels="$LABEL"
else
  new_labels="${current},${LABEL}"
fi

with_retry "$TD" task update "id:${TASK_ID}" --labels "$new_labels" >/dev/null

if [ $? -ne 0 ]; then
  echo '{"error": "Failed to add label"}' >&2
  exit 1
fi

echo "Added label '$LABEL' to task #${TASK_ID}"
