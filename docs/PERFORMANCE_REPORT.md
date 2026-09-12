# Performance Report

## P0-01 watcher Range Read

Environment: Windows, Node `v24.11.0`; synthetic JSONL file around 100 MiB; tail request starts near the end and asks for 8 MiB, recent request asks for 512 KiB.

| Implementation | File bytes read by request | Lines | Elapsed | RSS delta |
|---|---:|---:|---:|---:|
| Previous whole-file implementation | 8 MiB requested, 100 MiB file loaded | 35,246 | 64.49 ms | +132,227,072 bytes |
| Bounded Range Read | 8 MiB | 35,246 | 24.32 ms | -72,409,088 bytes |

Command: `node --expose-gc tools/benchmark-watcher.js`

The comparison uses the legacy algorithm inside the benchmark only; production `tailRead`, `tailReadAsync`, and `tailRecent` now use `open + read` with bounded buffers. RSS is process-level and includes JSON parsing/GC, so it is evidence of reduced whole-file loading, not a stable hardware-independent benchmark. Defender/360 and packaged Electron performance remain manual verification items.
