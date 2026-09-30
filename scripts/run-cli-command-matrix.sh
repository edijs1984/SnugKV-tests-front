#!/usr/bin/env bash
set -u

ROOT="${SNUGKV_REPO:-$HOME/Downloads/SnugKV}"
PORT="${SNUGKV_CLI_TEST_PORT:-6389}"
HOST=127.0.0.1
BIN="${TMPDIR:-/tmp}/snugkv-cli-matrix-$$"
LOG="${TMPDIR:-/tmp}/snugkv-cli-matrix-$$.log"

PASS=0
FAIL=0
SKIP=0
TOTAL=0
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" >/dev/null 2>&1 || true; fi
  rm -f "$BIN"
}
trap cleanup EXIT INT TERM

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "[FATAL] missing dependency: $1"; exit 2; }
}
need redis-cli
need go

echo "SnugKV CLI command matrix"
echo "repo=$ROOT port=$PORT"
echo

cd "$ROOT" || exit 2
go build -buildvcs=false -o "$BIN" ./cmd/snugkv || exit 2
"$BIN" -listen "$HOST:$PORT" -admin-listen "" -pprof-listen "" -metrics-listen "" -aof "" -snapshot "" >"$LOG" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 100); do
  redis-cli -h "$HOST" -p "$PORT" PING >/dev/null 2>&1 && break
  sleep 0.1
done
redis-cli -h "$HOST" -p "$PORT" PING >/dev/null 2>&1 || {
  echo "[FATAL] SnugKV failed to start"
  cat "$LOG"
  exit 2
}

cli() { redis-cli --raw -h "$HOST" -p "$PORT" "$@" 2>&1; }

case_eq() {
  local name="$1" expected="$2"; shift 2
  TOTAL=$((TOTAL+1))
  local out rc
  out="$(cli "$@")"; rc=$?
  if [[ $rc -eq 0 && "$out" == "$expected" ]]; then
    PASS=$((PASS+1)); printf '[PASS] %-34s %s\n' "$name" "$out"
  else
    FAIL=$((FAIL+1)); printf '[FAIL] %-34s expected=%q got=%q rc=%s\n' "$name" "$expected" "$out" "$rc"
  fi
}

case_has() {
  local name="$1" needle="$2"; shift 2
  TOTAL=$((TOTAL+1))
  local out rc
  out="$(cli "$@")"; rc=$?
  if [[ $rc -eq 0 && "$out" == *"$needle"* ]]; then
    PASS=$((PASS+1)); printf '[PASS] %-34s contains %q\n' "$name" "$needle"
  else
    FAIL=$((FAIL+1)); printf '[FAIL] %-34s expected contains=%q got=%q rc=%s\n' "$name" "$needle" "$out" "$rc"
  fi
}

case_ok() {
  local name="$1"; shift
  TOTAL=$((TOTAL+1))
  local out rc
  out="$(cli "$@")"; rc=$?
  if [[ $rc -eq 0 && "$out" != ERR* ]]; then
    PASS=$((PASS+1)); printf '[PASS] %-34s %s\n' "$name" "$(printf '%s' "$out" | head -c 100)"
  else
    FAIL=$((FAIL+1)); printf '[FAIL] %-34s %q rc=%s\n' "$name" "$out" "$rc"
  fi
}

case_optional() {
  local name="$1"; shift
  TOTAL=$((TOTAL+1))
  local out rc
  out="$(cli "$@")"; rc=$?
  if [[ $rc -eq 0 && "$out" != ERR* ]]; then
    PASS=$((PASS+1)); printf '[PASS] %-34s %s\n' "$name" "$(printf '%s' "$out" | head -c 100)"
  else
    SKIP=$((SKIP+1)); printf '[SKIP] %-34s %q\n' "$name" "$out"
  fi
}

cli FLUSHDB >/dev/null 2>&1 || true

echo "== connection / server =="
case_eq "PING" "PONG" PING
case_eq "ECHO" "hello" ECHO hello
case_ok "COMMAND" COMMAND
case_ok "INFO" INFO
case_ok "DBSIZE" DBSIZE
case_ok "TIME" TIME
case_ok "ROLE" ROLE

echo
echo "== strings / keys =="
case_eq "SET" "OK" SET cli:s alpha
case_eq "GET" "alpha" GET cli:s
case_eq "EXISTS" "1" EXISTS cli:s
case_eq "TYPE" "string" TYPE cli:s
case_eq "STRLEN" "5" STRLEN cli:s
case_eq "APPEND" "7" APPEND cli:s "!!"
case_eq "GET after APPEND" "alpha!!" GET cli:s
case_eq "SETNX existing" "0" SETNX cli:s nope
case_eq "SETNX new" "1" SETNX cli:nx yes
case_eq "MSET" "OK" MSET cli:m1 one cli:m2 two
case_has "MGET" "one" MGET cli:m1 cli:m2
case_eq "GETSET" "alpha!!" GETSET cli:s beta
case_eq "INCR" "1" INCR cli:counter
case_eq "INCRBY" "10" INCRBY cli:counter 9
case_eq "DECR" "9" DECR cli:counter
case_eq "DECRBY" "4" DECRBY cli:counter 5
case_eq "DEL" "1" DEL cli:nx

echo
echo "== expiry =="
case_eq "SET expiry key" "OK" SET cli:ttl value
case_eq "EXPIRE" "1" EXPIRE cli:ttl 60
case_ok "TTL" TTL cli:ttl
case_eq "PERSIST" "1" PERSIST cli:ttl
case_eq "TTL persistent" "-1" TTL cli:ttl
case_eq "PEXPIRE" "1" PEXPIRE cli:ttl 60000
case_ok "PTTL" PTTL cli:ttl
case_ok "EXPIRETIME" EXPIRETIME cli:ttl
case_ok "PEXPIRETIME" PEXPIRETIME cli:ttl

echo
echo "== hashes =="
case_eq "HSET" "2" HSET cli:h a 1 b 2
case_eq "HGET" "1" HGET cli:h a
case_has "HMGET" "2" HMGET cli:h a b
case_ok "HGETALL" HGETALL cli:h
case_eq "HEXISTS" "1" HEXISTS cli:h b
case_eq "HLEN" "2" HLEN cli:h
case_eq "HINCRBY" "3" HINCRBY cli:h a 2
case_eq "HDEL" "1" HDEL cli:h b

echo
echo "== lists =="
case_eq "LPUSH" "2" LPUSH cli:l b a
case_eq "RPUSH" "3" RPUSH cli:l c
case_has "LRANGE" "a" LRANGE cli:l 0 -1
case_eq "LLEN" "3" LLEN cli:l
case_eq "LINDEX" "b" LINDEX cli:l 1
case_eq "LSET" "OK" LSET cli:l 1 B
case_eq "LPOP" "a" LPOP cli:l
case_eq "RPOP" "c" RPOP cli:l

echo
echo "== sets =="
case_eq "SADD" "3" SADD cli:set a b c
case_eq "SCARD" "3" SCARD cli:set
case_eq "SISMEMBER" "1" SISMEMBER cli:set b
case_ok "SMEMBERS" SMEMBERS cli:set
case_eq "SREM" "1" SREM cli:set c
case_eq "SADD second" "2" SADD cli:set2 b d
case_ok "SUNION" SUNION cli:set cli:set2
case_ok "SINTER" SINTER cli:set cli:set2
case_ok "SDIFF" SDIFF cli:set cli:set2

echo
echo "== sorted sets =="
case_eq "ZADD" "3" ZADD cli:z 1 a 2 b 3 c
case_eq "ZCARD" "3" ZCARD cli:z
case_eq "ZSCORE" "2" ZSCORE cli:z b
case_ok "ZRANGE" ZRANGE cli:z 0 -1
case_eq "ZRANK" "1" ZRANK cli:z b
case_eq "ZINCRBY" "4" ZINCRBY cli:z 3 a
case_eq "ZREM" "1" ZREM cli:z c

echo
echo "== transactions / scripting =="
case_eq "MULTI" "OK" MULTI
# redis-cli opens a fresh connection per invocation, so use one stdin session for transaction semantics.
TOTAL=$((TOTAL+1))
txn="$(printf 'MULTI\nSET cli:tx 42\nGET cli:tx\nEXEC\n' | redis-cli --raw -h "$HOST" -p "$PORT" 2>&1)"
if [[ "$txn" == *"42"* ]]; then PASS=$((PASS+1)); echo "[PASS] transaction EXEC"; else FAIL=$((FAIL+1)); printf '[FAIL] transaction EXEC %q\n' "$txn"; fi
case_eq "EVAL" "pong" EVAL "return 'pong'" 0
case_ok "SCRIPT LOAD" SCRIPT LOAD "return 7"
case_optional "SCRIPT EXISTS" SCRIPT EXISTS deadbeef

echo
echo "== ACL / persistence / observability =="
case_ok "ACL WHOAMI" ACL WHOAMI
case_ok "ACL USERS" ACL USERS
case_ok "ACL CAT" ACL CAT
case_ok "ACL GENPASS" ACL GENPASS 64
case_ok "SLOWLOG LEN" SLOWLOG LEN
case_ok "LASTSAVE" LASTSAVE
case_optional "SAVE" SAVE
case_optional "BGSAVE" BGSAVE
case_optional "BGREWRITEAOF" BGREWRITEAOF
case_optional "SNUG.STATS" SNUG.STATS

echo
echo "== JSON / search / functions (feature-aware) =="
case_optional "JSON.SET" JSON.SET cli:j '$' '{"name":"snug","n":1}'
case_optional "JSON.GET" JSON.GET cli:j '$'
case_optional "JSON.TYPE" JSON.TYPE cli:j '$'
case_optional "FT._LIST" FT._LIST
case_optional "FUNCTION LIST" FUNCTION LIST

echo
echo "== cluster / replication metadata (feature-aware) =="
case_optional "CLUSTER INFO" CLUSTER INFO
case_optional "CLUSTER NODES" CLUSTER NODES
case_optional "REPLICAOF NO ONE" REPLICAOF NO ONE

echo
echo "== error handling =="
TOTAL=$((TOTAL+1))
unknown="$(cli THIS_COMMAND_DOES_NOT_EXIST 2>&1)"
if [[ "$unknown" == ERR* || "$unknown" == *"unknown command"* ]]; then PASS=$((PASS+1)); echo "[PASS] unknown command rejected"; else FAIL=$((FAIL+1)); printf '[FAIL] unknown command response %q\n' "$unknown"; fi

printf '\nSUMMARY total=%d pass=%d fail=%d skip=%d\n' "$TOTAL" "$PASS" "$FAIL" "$SKIP"
[[ "$FAIL" -eq 0 ]]
