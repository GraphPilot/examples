#!/usr/bin/env bash
# Sends the same Book queries and mutations to two endpoints and shows the difference:
#
#   ORIGIN_URL      the Book origin, directly (no cache)
#   GRAPHPILOT_URL  the same origin behind GraphPilot's edge cache
#
#   export ORIGIN_URL=http://127.0.0.1:4000/graphql                       # default
#   export GRAPHPILOT_URL=https://<subdomain>.<label>.graphpilot.cloud/graphql
#   npm run compare
#
# ORIGIN_URL must be the same origin GraphPilot forwards to: the script changes
# a book directly there to show what a cache does when data changes behind it.
# Without GRAPHPILOT_URL, only the direct requests run.
#
# Requires: bash, curl, node (for printing the JSON compactly).

set -euo pipefail

ORIGIN_URL="${ORIGIN_URL:-http://127.0.0.1:4000/graphql}"
GRAPHPILOT_URL="${GRAPHPILOT_URL:-}"
# Purges reach GraphPilot's edge locations asynchronously, usually within seconds.
PURGE_WAIT_SECONDS="${PURGE_WAIT_SECONDS:-3}"

BOOKS='{"query":"{ books { id title author } }"}'
BOOK_1='{"query":"query Book($id: ID!) { book(id: $id) { id title author } }","variables":{"id":"1"}}'
BOOK_2='{"query":"query Book($id: ID!) { book(id: $id) { id title author } }","variables":{"id":"2"}}'
UPDATE='{"query":"mutation { updateBook(id: \"1\", title: \"Updated Book Title\") { id title } }"}'
BEHIND='{"query":"mutation { updateBook(id: \"1\", title: \"Changed At The Origin\") { id title } }"}'
RESET='{"query":"mutation { updateBook(id: \"1\", title: \"The Pragmatic Programmer\") { id title } }"}'

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
note() { printf '\033[2m%s\033[0m\n' "$1"; }

# ask <label> <url> <json body>
# Prints one line: endpoint, cache status, timing, then the surrogate keys and the data.
ask() {
  local label="$1" url="$2" body="$3" headers out time json status cache reason age remaining keys color
  headers="$(mktemp)"
  out="$(curl -sS -X POST "$url" -H 'content-type: application/json' --data "$body" \
    -D "$headers" -w '\n%{http_code} %{time_total}')"
  status="$(tail -n1 <<<"$out" | cut -d' ' -f1)"
  time="$(tail -n1 <<<"$out" | cut -d' ' -f2)"
  json="$(sed '$d' <<<"$out")"
  header() { grep -i "^$1:" "$headers" | head -n1 | cut -d' ' -f2- | tr -d '\r' || true; }
  cache="$(header gp-cache)"
  reason="$(header gp-cache-reason)"
  age="$(header gp-cache-age)"
  remaining="$(header gp-cache-remaining)"
  keys="$(header gp-surrogate-key | tr ' ' '\n' | grep -E '^[A-Za-z_]+:id:' | tr '\n' ' ' || true)"
  rm -f "$headers"

  case "$cache" in HIT) color=32 ;; MISS) color=33 ;; PASS) color=36 ;; STALE) color=35 ;; *) color=37 ;; esac
  printf '  %-11s HTTP %s  \033[1;%sm%-5s\033[0m %6.0f ms' "$label" "$status" "$color" "${cache:-none}" \
    "$(awk -v t="$time" 'BEGIN { print t * 1000 }')"
  [[ -n "$age" ]] && printf '  age %ss' "$age"
  [[ -n "$remaining" ]] && printf '  remaining %ss' "$remaining"
  [[ -n "$reason" ]] && printf '  %s' "$reason"
  printf '\n'
  [[ -n "$keys" ]] && note "              keys: $keys"
  printf '              %s\n' "$(node -e 'const j=JSON.parse(process.argv[1]); console.log(JSON.stringify(j.data ?? j))' "$json" | cut -c1-140)"
}

direct() { ask direct "$ORIGIN_URL" "$1"; }
edge() { ask graphpilot "$GRAPHPILOT_URL" "$1"; }

printf 'direct:     %s\n' "$ORIGIN_URL"
printf 'graphpilot: %s\n' "${GRAPHPILOT_URL:-(not set, only direct requests run)}"

bold "0. Reset book 1's title (through GraphPilot when set, so cached copies are purged)"
if [[ -n "$GRAPHPILOT_URL" ]]; then edge "$RESET"; sleep "$PURGE_WAIT_SECONDS"; else direct "$RESET"; fi

bold "1. Direct to the origin: every request runs the resolvers, nothing is cached"
direct "$BOOKS"
direct "$BOOKS"
note "  No gp-cache header. Both requests appear in the origin's log."

if [[ -z "$GRAPHPILOT_URL" ]]; then
  bold "Set GRAPHPILOT_URL to compare with GraphPilot (see the README)."
  exit 0
fi

bold "2. Through GraphPilot: the first request is a MISS, the identical second one a HIT"
edge "$BOOKS"
edge "$BOOKS"
note "  The HIT is answered at the edge and does not appear in the origin's log."

bold "3. Different variables: separate cache entries"
edge "$BOOK_1"
edge "$BOOK_2"
edge "$BOOK_1"

bold "4. A mutation through GraphPilot purges every cached response containing book 1"
edge "$UPDATE"
sleep "$PURGE_WAIT_SECONDS"
edge "$BOOKS"
edge "$BOOK_1"
edge "$BOOKS"
note "  The mutation returned Book 1, so GraphPilot purged the key Book:id:1."

bold "5. A change made directly at the origin is invisible to the cache"
edge "$BOOKS"
direct "$BEHIND"
edge "$BOOKS"
direct "$BOOKS"
note "  GraphPilot still serves the cached title until the entry expires (Book: 30 s)"
note "  or is purged: gpilot service purge Book:id:1"

bold "6. Restore book 1 through GraphPilot (purges again)"
edge "$RESET"
sleep "$PURGE_WAIT_SECONDS"
edge "$BOOKS"
