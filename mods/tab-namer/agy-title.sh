#!/bin/sh
# Antigravity CLI (`agy`) `title` command for Herdr's tab-namer mod.
# Reads the state JSON piped on stdin and prints the conversation title,
# falling back to conversation_summaries.db when agy omits conversation_title
# on newly created conversations, and to "Antigravity" when no title exists yet.
set -eu

data=$(cat)
title=$(printf '%s' "$data" | jq -r '.conversation_title // empty' 2>/dev/null || true)

if [ -z "$title" ]; then
  cid=$(printf '%s' "$data" | jq -r '.conversation_id // empty' 2>/dev/null | tr -cd 'a-fA-F0-9-' || true)
  db="${AGY_CLI_HOME:-$HOME/.gemini/antigravity-cli}/conversation_summaries.db"
  if [ -n "$cid" ] && [ -r "$db" ]; then
    title=$(sqlite3 -init /dev/null -batch -list -noheader "$db" <<SQL 2>/dev/null || true
.timeout 500
SELECT title FROM conversation_summaries WHERE conversation_id = '$cid' LIMIT 1;
SQL
)
  fi
fi

printf '%s\n' "${title:-Antigravity}"
