#!/usr/bin/env bash
# StickyInc MCP smoke test — pipes JSON-RPC over stdio and prints responses.
set -euo pipefail
cd "$(dirname "$0")"

{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
  sleep 0.3
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  sleep 0.2
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 0.2
  echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add_task","arguments":{"text":"Try the smoke test","due_at":"2026-04-24T15:00:00Z"}}}'
  sleep 0.2
  echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"add_task","arguments":{"text":"Call the dentist"}}}'
  sleep 0.2
  echo '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"list_tasks","arguments":{}}}'
  sleep 0.2
  echo '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"complete_task","arguments":{"id":1}}}'
  sleep 0.2
  echo '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"list_tasks","arguments":{"include_completed":true}}}'
  sleep 0.5
} | pnpm -s dev
