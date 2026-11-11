#!/usr/bin/env bash
# Walks through every scenario of the README against a running demo.
#
# EDUCATIONAL cache only (not GraphPilot). For GraphPilot, see graphpilot/compare.sh.
#
#   Terminal 1:  npm run educational   (or CACHE_TTL_SECONDS=5 npm run educational)
#   Terminal 2:  npm run educational:demo
#
# Start from a freshly started server: the data lives in memory and this script
# changes book 1.

set -euo pipefail

PROXY="${PROXY:-http://127.0.0.1:4100/graphql}"
ORIGIN="${ORIGIN:-http://127.0.0.1:4101/graphql}"

# gql <METHOD> <URL> <JSON body> [extra curl args...]
# Prints the status line, the cache diagnostics headers and the body.
gql() {
  local method="$1" url="$2" body="$3" out
  shift 3
  out="$(mktemp)"
  curl -sS -X "$method" "$url" -H 'content-type: application/json' --data "$body" "$@" -D - -o "$out" |
    grep -iE '^(HTTP/|x-cache|age:|allow:)' | tr -d '\r'
  cat "$out"
  rm -f "$out"
  printf '\n\n'
}

step() { printf '\033[1m== %s\033[0m\n' "$1"; }

BOOKS='{"query":"{ books { id title author } }"}'
BOOK_1='{"query":"query Book($id: ID!) { book(id: $id) { id title author } }","variables":{"id":"1"}}'
BOOK_2='{"query":"query Book($id: ID!) { book(id: $id) { id title author } }","variables":{"id":"2"}}'
UPDATE='{"query":"mutation { updateBook(id: \"1\", title: \"Updated Book Title\") { id title } }"}'

step "1. First request: MISS (the origin answers, the response is stored)"
gql POST "$PROXY" "$BOOKS"

step "2. Identical request: HIT (served from memory, the origin is not called)"
gql POST "$PROXY" "$BOOKS"

step "3. Different variables: separate entries (id 1 MISS, id 2 MISS, id 1 HIT)"
gql POST "$PROXY" "$BOOK_1"
gql POST "$PROXY" "$BOOK_2"
gql POST "$PROXY" "$BOOK_1"

step "4. Authenticated request: BYPASS (never stored, never served from the shared cache)"
gql POST "$PROXY" "$BOOKS" -H 'authorization: Bearer demo-token-alice'

step "5. Change book 1 directly at the origin, behind the cache's back"
gql POST "$ORIGIN" "$UPDATE"

step "6. The cache still serves the old title: HIT, but stale"
gql POST "$PROXY" "$BOOKS"

step "7. The same mutation through the cache: BYPASS, x-cache-invalidated shows purged entries"
gql POST "$PROXY" "$UPDATE"

step "8. The list is fetched again: MISS with the new title"
gql POST "$PROXY" "$BOOKS"

step "9. The same read with the HTTP QUERY method: HIT (POST and QUERY share one entry)"
gql QUERY "$PROXY" "$BOOKS"

step "10. A mutation over QUERY: 405, rejected before it reaches the origin"
gql QUERY "$PROXY" "$UPDATE"

step "11. TTL expiry"
ttl="$(curl -sS -X POST "$PROXY" -H 'content-type: application/json' --data "$BOOKS" -D - -o /dev/null |
  tr -d '\r' | awk -F': ' 'tolower($1) == "x-cache-ttl" { print $2 }')"
if [[ -n "$ttl" && "$ttl" -le 15 ]]; then
  echo "Entry is fresh for ${ttl}s more. Waiting $((ttl + 1))s..."
  sleep $((ttl + 1))
  gql POST "$PROXY" "$BOOKS"
else
  echo "Entry is fresh for ${ttl:-?}s more. Restart with CACHE_TTL_SECONDS=5 npm run educational to watch it expire."
  printf '\n'
fi

step "Cache statistics"
curl -sS "${PROXY%/graphql}/_cache/stats"
printf '\n'
