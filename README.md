# SnugKV Benchmark Lab

Desktop Electron + React UI for SnugKV's published Redis-compatible benchmark profiles.

The app does **not** start or stop Redis, SnugKV, Valkey, Dragonfly, or containers. Start the target server yourself and point the app at its host and port. Electron invokes the same `scripts/bench/bench-one.sh` used by the CLI, so desktop and terminal results remain comparable.

## Features

- Native Electron desktop app.
- React/Vite renderer.
- Test profiles: cached JSON, session JSON, API JSON, counter, UUID, text, compressible, already-compressed, random.
- Editable host, port, result label, key count, GET operations, workers, pipeline, settle time, and seed.
- Live benchmark output streamed directly from the child process.
- SET throughput, GET throughput, p95 latency, bytes/key, and memory delta.
- Copy result JSON.
- Native Save dialog for result JSON.
- Cancel running benchmark.
- Shows the equivalent CLI command.
- No Docker or database lifecycle management.

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
