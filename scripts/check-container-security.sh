#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
scan_dir="$(mktemp -d)"
image_tag="anytype-mcp-security:${scan_dir##*/}"
# Official aquasec/trivy 0.75.0 multi-platform manifest, verified 2026-10-03.
trivy_image='docker.io/aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa'

cleanup() {
  docker image rm "$image_tag" >/dev/null 2>&1 || true
  rm -rf -- "$scan_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Expose only the Dockerfile and exported image, never Docker's control socket.
cp "$repo_dir/Dockerfile" "$scan_dir/Dockerfile"
docker run --rm --mount "type=bind,src=$scan_dir,dst=/scan,readonly" "$trivy_image" \
  config --config /dev/null --ignorefile /dev/null --exit-code 1 \
  --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL /scan/Dockerfile

docker build --pull --platform linux/amd64 --tag "$image_tag" "$repo_dir"
node "$repo_dir/scripts/check-container-runtime.mjs" "$image_tag"
docker save --output "$scan_dir/image.tar" "$image_tag"
docker run --rm --mount "type=bind,src=$scan_dir,dst=/scan,readonly" "$trivy_image" \
  image --input /scan/image.tar --config /dev/null --ignorefile /dev/null \
  --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed=false --exit-code 1 --timeout 10m
