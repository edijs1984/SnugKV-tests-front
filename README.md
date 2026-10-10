# SnugKV Benchmark Lab

Desktop Electron + React UI for SnugKV's published Redis-compatible benchmark profiles.

The app can start native Redis or adaptive SnugKV locally and uses the same SnugKV benchmark and validation scripts as the CLI, so desktop and terminal results remain comparable.

## Features

- Native Electron desktop app.
- One-click native local server controls for Redis and adaptive SnugKV.
- React/Vite renderer.
- Test profiles: cached JSON, session JSON, API JSON, counter, UUID, text, compressible, already-compressed, random.
- Editable host, port, result label, key count, GET operations, workers, pipeline, settle time, and seed.
- Live benchmark output streamed directly from the child process.
- SET throughput, GET throughput, p95 latency, bytes/key, and memory delta.
- Copy result JSON.
- Native Save dialog for result JSON.
- Cancel running benchmark.
- Shows the equivalent CLI command.
- Dedicated **Tests & Soak** tab with live validation output.
- One-click release suites: full Go tests, race detector, vet, RESP fuzz, Redis 8.2 differential gates, durability gates, and cluster recovery.
- Focused chaos suites for corrupted-replica and persistence-failure recovery.
- Configurable mixed workload soak, distributed chaos soak, and combined Full Soak presets.
- Validation cancellation terminates the spawned process group to avoid orphan test nodes.
- Validation commands are allow-listed in the Electron main process; the renderer cannot execute arbitrary shell commands.

> **Warning:** the benchmark runs `FLUSHDB` on the selected target.

## Expected directory layout

The default development setup is:

```text
~/Downloads/
  SnugKV/
  SnugKV-tests-front/
```

The Electron app automatically looks for `../SnugKV`.

If your SnugKV checkout is somewhere else, set:

```bash
export SNUGKV_REPO=/absolute/path/to/SnugKV
```

## Run the Electron app

```bash
cd ~/Downloads/SnugKV-tests-front
npm install
npm run electron:dev
```

`npm run dev` is an alias for the Electron development mode. On Linux the development command launches Electron with `--no-sandbox` so Chromium does not require a root-owned SUID `chrome-sandbox` helper inside `node_modules`.

The Vite renderer starts locally, then Electron opens the desktop window. There is no Express server.

## Build the renderer

```bash
npm run build
```

## Build a desktop package

On Linux:

```bash
npm run electron:dist
```

The configured Linux target is AppImage. The project also has basic DMG and NSIS targets for macOS and Windows.

The packaged app still needs access to a SnugKV checkout containing:

```text
scripts/bench/bench-one.sh
cmd/rediswirebench
```

Set `SNUGKV_REPO` when launching the app if that checkout is not next to the application project.


## Tests & Soak tab

The desktop app can run SnugKV's retained validation directly from the local
SnugKV checkout. Open **Tests & Soak** and choose a suite.

Release/correctness suites include:

- Full Release Validation
- Go Test
- Race Detector
- Go Vet
- RESP Fuzz
- Redis 8.2 Differential
- Durability Matrix
- Cluster Recovery Matrix
- Corrupt Replica Recovery
- Persistence Failure Recovery

Long-running suites include:

- Full Soak
- Distributed Chaos Soak
- Mixed Workload Soak

Soak suites expose duration, case timeout, key count, worker count, value size,
and seed controls. The runner streams stdout/stderr into the desktop console and
supports cancellation.

Some validation suites start local Redis/SnugKV instances, use isolated local
ports, and intentionally exercise restart, corruption, persistence failure, and
`FLUSHDB` behavior. Do not run them against production data.

The Validation Lab uses the SnugKV checkout resolved by `SNUGKV_REPO` (or the
same automatic `../SnugKV` lookup used by the benchmark tab), so the available
test scripts are always the scripts from that local checkout.

## CLI parity

For UUID against Redis on port 6390, the UI executes the equivalent of:

```bash
bash scripts/bench/bench-one.sh uuid \
  -p 6390 \
  -h 127.0.0.1 \
  -s redis \
  -k 1000000 \
  -g 2000000 \
  -w 8 \
  -P 256 \
  --settle-ms 10000 \
  --seed 1
```

## Architecture

```text
Electron
├── Main process
│   ├── launches bench-one.sh
│   ├── streams stdout/stderr
│   ├── reads load.json + get.json
│   └── native Save dialog
│
├── Preload
│   └── narrow context-isolated IPC API
│
└── React/Vite renderer
    ├── benchmark configuration
    ├── live output
    └── result cards / copy / save

bench-one.sh
    |
    | RESP2/TCP
    v
server you started manually
```

The renderer has no Node integration. Shell execution stays in the Electron main process behind the preload IPC bridge.

## One-click local servers

The desktop app includes two local server buttons:

- Redis on `127.0.0.1:6390`
- adaptive SnugKV on `127.0.0.1:6383`

On Linux, starting one first clears listeners on both benchmark ports, then starts the selected native server and waits until its TCP port is ready. SnugKV is rebuilt from the current checkout before launch. Encoding, compression, JSON-shape optimization, and terminal RAW storage are selected automatically per value inside SnugKV rather than through separate raw/optimized product modes.

Redis requires `redis-server` to be installed and available on `PATH`. SnugKV requires Go to be installed.


## Database Explorer

The desktop app also includes a **Database** workspace for visually exploring a running local Redis or SnugKV instance.

It is designed for users who do not know Redis commands:

- search/browse keys by pattern
- see data type, TTL, size and encoding metadata
- inspect strings, hashes, lists, sets, sorted sets and JSON
- edit string values visually
- apply/remove TTL without writing commands
- delete keys with confirmation
- create realistic example data for each major data type
- see the equivalent `redis-cli` command for every operation
- learn which data type fits a given use case

Start Redis or SnugKV from the **Benchmark** workspace, then switch to **Database**.
