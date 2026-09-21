# SnugKV Benchmark Lab

Local React UI for the published SnugKV black-box benchmark profiles.

The UI does **not** start or stop Redis/SnugKV. Start the target server yourself, then point the UI at its host and port. The local Node API invokes the same `scripts/bench/bench-one.sh` used by the CLI so browser and CLI results remain comparable.

## Features

- Test profile dropdown: cache JSON, session JSON, API JSON, counter, UUID, text, compressible, already-compressed, random.
- Editable host, port, label, key count, GET operations, workers, pipeline, settle time and seed.
- Live benchmark output.
- SET throughput, GET throughput, p95 latency, bytes/key and memory delta.
- Copy result JSON.
- Download result JSON.
- Shows the equivalent CLI command before running.
- No Docker or server lifecycle management.

> **Warning:** the benchmark runs `FLUSHDB` on the selected target.

## Run locally

The easiest layout is:

```text
~/Downloads/
  SnugKV/
  SnugKV-tests-front/
```

Then:

```bash
cd ~/Downloads/SnugKV-tests-front
npm install
npm run dev
```

Open http://localhost:5173.

If SnugKV is elsewhere:

```bash
SNUGKV_REPO=/absolute/path/to/SnugKV npm run dev
```

The API listens on `127.0.0.1:8787` by default.

## CLI parity

For example, configuring UUID / Redis / port 6390 in the UI runs the equivalent of:

```bash
bash scripts/bench/bench-one.sh uuid -p 6390 -h 127.0.0.1 -s redis \
  -k 1000000 -g 2000000 -w 8 -P 256 --settle-ms 10000 --seed 1
```

## Architecture

```text
React/Vite UI
    |
    | HTTP localhost
    v
small Express runner
    |
    | spawn bash
    v
SnugKV/scripts/bench/bench-one.sh
    |
    | RESP2/TCP
    v
server you started manually
```

This repository intentionally contains no Redis/SnugKV server startup logic.
