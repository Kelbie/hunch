#!/usr/bin/env python3
"""Answer SemIf decision rows for one loaded model, over stdin, until stdin closes.

SemIf ships a create-only batch scorer: one process, one input file, one output file, one model
load. A review asks many small questions about many hunks, so paying for a model load per request
would make it unusable. This holds one loaded model and scores each request as it arrives.

It is a transport, not a second implementation: every decision is scored by SemIf's own published
functions, and nothing here interprets the probabilities it returns.

Protocol, one JSON object per line in each direction:

  ready    {"ready": true, "model": {...}}                 once, after the model loads
  request  {"id": "1", "rows": [SemIf row, ...]}           rows share one state in shared mode
  answer   {"id": "1", "results": [SemIf result, ...]}
  failure  {"id": "1", "error": "..."}                     this request only; the process stays up

A failure before the ready line is fatal and is reported as {"error": "..."}.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("direct", "serial", "shared", "reranker"), default="shared")
    parser.add_argument("--backend", choices=("torch", "mlx", "llamacpp"), default="torch")
    parser.add_argument("--model", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--max-tokens", type=int, default=32768)
    parser.add_argument("--device", choices=("auto", "cuda", "mps"), default="auto")
    parser.add_argument("--dtype", choices=("bfloat16", "float16", "float32"), default="bfloat16")
    parser.add_argument("--gguf")
    parser.add_argument("--llama-threads", type=int)
    parser.add_argument("--mlx-bits", type=int, choices=(4, 8))
    parser.add_argument("--mlx-cache-limit-mib", type=int)
    args = parser.parse_args(argv)
    if args.max_tokens < 1:
        parser.error("--max-tokens must be positive")
    if args.backend != "llamacpp" and args.gguf:
        parser.error("--gguf requires --backend llamacpp")
    if args.backend == "llamacpp" and not args.gguf:
        parser.error("--backend llamacpp requires --gguf pointing at a GGUF file")
    if args.mode == "reranker" and args.backend != "torch":
        parser.error("reranker mode requires --backend torch")
    return args


def _load(args: argparse.Namespace):
    """One loaded model and the four scoring entry points SemIf publishes for it."""
    from semif_phase1 import core, direct, reranker, serial, shared

    if args.backend == "mlx":
        from semif_phase1 import mlx_backend

        cache = mlx_backend.DEFAULT_CACHE_LIMIT_MIB if args.mlx_cache_limit_mib is None else args.mlx_cache_limit_mib
        model, tokenizer, metadata = mlx_backend.load_model(args.model, args.revision, args.mlx_bits, cache_limit_mib=cache)
        return model, tokenizer, metadata, {
            "direct": mlx_backend.score, "serial": mlx_backend.SerialPrefixScorer, "shared": mlx_backend.score_shared,
        }
    if args.backend == "llamacpp":
        from pathlib import Path

        from semif_phase1 import llamacpp_backend

        model, tokenizer, metadata = llamacpp_backend.load_model(
            args.model, args.revision, Path(args.gguf), threads=args.llama_threads, context_tokens=args.max_tokens)
        return model, tokenizer, metadata, {
            "direct": llamacpp_backend.score, "serial": llamacpp_backend.SerialPrefixScorer, "shared": llamacpp_backend.score_shared,
        }
    # The CLI keeps reranker mode on CUDA; the same restriction applies here.
    device = "cuda" if args.mode == "reranker" else args.device
    model, tokenizer, metadata = core.load_causal_model(args.model, args.revision, device, args.dtype)
    return model, tokenizer, metadata, {
        "direct": direct.score, "serial": serial.SerialPrefixScorer, "shared": shared.score_shared,
        "reranker": reranker.score,
    }


def _score(args, model, tokenizer, metadata, entry, rows: list[dict]) -> list[dict]:
    from semif_phase1.core import validate_row

    for row in rows:
        validate_row(row)
    if args.mode == "shared":
        results, timing = entry["shared"](model, tokenizer, rows, metadata, args.max_tokens)
        return [{**result, "shared_timing": timing} for result in results]
    if args.mode == "serial":
        scorer = entry["serial"](model, tokenizer, metadata, args.max_tokens)
        return [scorer.score(row) for row in rows]
    score = entry["direct"] if args.mode == "direct" else entry["reranker"]
    return [score(model, tokenizer, row, metadata, args.max_tokens) for row in rows]


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    # A model loader that prints to fd 1 would otherwise corrupt the protocol, so responses go to a
    # private duplicate of it and everything else in this process is pointed at stderr.
    out = os.fdopen(os.dup(1), "w", buffering=1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    def send(payload: dict) -> None:
        out.write(json.dumps(payload, allow_nan=False) + "\n")
        out.flush()

    try:
        model, tokenizer, metadata, entry = _load(args)
    except Exception as error:  # noqa: BLE001 - reported to the caller, which decides what to do
        traceback.print_exc()
        send({"error": f"{type(error).__name__}: {error}"})
        return 1
    send({"ready": True, "model": {**metadata, "mode": args.mode, "backend": args.backend}})
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            request_id = request["id"]
        except Exception as error:  # noqa: BLE001 - an unidentifiable request cannot be answered
            send({"id": None, "error": f"Unreadable request: {error}"})
            continue
        try:
            send({"id": request_id, "results": _score(args, model, tokenizer, metadata, entry, request["rows"])})
        except Exception as error:  # noqa: BLE001 - one bad request must not end the process
            traceback.print_exc()
            send({"id": request_id, "error": f"{type(error).__name__}: {error}"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
