#!/bin/sh
# Keep the existing entry point; the Rust tool owns package creation.
set -eu
cd "$(dirname "$0")/.."
exec cargo run --quiet --locked --offline --release --manifest-path tools/packager/Cargo.toml -- .
