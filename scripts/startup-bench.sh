#!/usr/bin/env bash
# Usage: [MDW_BIN=path] [MDW_ARGS=--no-server] startup-bench.sh FILE [RUNS]
set -eu -o pipefail
file=${1:?Pass a Markdown file}
runs=${2:-3}
read -r -a args <<< "${MDW_ARGS:-}"
for ((i = 0; i < runs; i++)); do
  if ! output=$(MDW_TIMING=1 MDW_TIMING_QUIT=1 "${MDW_BIN:-mdw}" "${args[@]}" -- "$file" 2>&1); then
    echo "$output" >&2
    exit 1
  fi
  if ! grep -q 'first frame' <<< "$output"; then
    echo "$output" >&2
    echo "No first-frame sample. Close any existing window for the benchmark file." >&2
    exit 1
  fi
  grep -E 'client send|server receive|assign$|window built|navigation start|script start|view created|editor created|first frame' <<< "$output" | tr -s ' ' | tr '\n' ' '
  echo
  sleep 0.5
done
