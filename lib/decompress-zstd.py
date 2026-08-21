#!/usr/bin/env python3
# 解压 DeepSeek Harness 的 session.jsonl.zstd，输出原始 JSONL 到 stdout
import sys
import zstandard

if len(sys.argv) < 2:
    sys.stderr.write("usage: decompress-zstd.py <file.zstd>\n")
    sys.exit(2)

path = sys.argv[1]
try:
    with open(path, 'rb') as f:
        dctx = zstandard.ZstdDecompressor()
        with dctx.stream_reader(f) as reader:
            sys.stdout.buffer.write(reader.read())
except Exception as e:
    sys.stderr.write(f"[decompress-zstd] {path}: {e}\n")
    sys.exit(1)
