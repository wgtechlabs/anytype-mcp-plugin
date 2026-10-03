#!/bin/sh
set -eu

# Rebuild the official v0.4.0 source with the reviewed dependency-only patch.
# Keep this identity distinct from Anytype's unmodified release binary.
source_revision=bb73c27503dde4e5632629b8b7dbd4c78e1b28a1
source_sha256=e00fdcfed05f0e4d883ac29a98484bb9ed71f0a2aed6b11cc9f498edbaa3eea3
heart_revision=11eb77c889c2eda1e4fc902751194813239c4590
heart_sha256=ad44b175644a866913f14c58de8dceec62e02e3bbcfb42b6bae8e29adbbc36ce
tantivy_version=v1.0.6
patch_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
arch=${TARGETARCH:-$(go env GOARCH)}
case "$arch" in
  amd64) tantivy_sha256=88b34e006707bfec2d29e8b26405f67cbb975d06fd4ea164da856d0084aaabbc; musl_cc=x86_64-linux-musl-gcc ;;
  arm64) tantivy_sha256=0a4a9143388977df41a174075ce05cd6aee2821da6425b5b9f9d591fe35d3756; musl_cc=aarch64-linux-musl-gcc ;;
  *) echo 'Unsupported Anytype build architecture.' >&2; exit 1 ;;
esac
test "$(go env GOVERSION)" = go1.26.8
test "$(go env GOARCH)" = "$arch"

mkdir -p /build/anytype /build/heart /out
cd /build/heart
curl -fsSL --retry 3 "https://codeload.github.com/anyproto/anytype-heart/tar.gz/$heart_revision" -o /build/heart-source.tar.gz
echo "$heart_sha256  /build/heart-source.tar.gz" | sha256sum -c -
tar -xzf /build/heart-source.tar.gz --strip-components=1
patch -p1 < "$patch_dir/heart-security.patch"

cd /build/anytype
curl -fsSL --retry 3 "https://codeload.github.com/anyproto/anytype-cli/tar.gz/$source_revision" -o /build/anytype-source.tar.gz
echo "$source_sha256  /build/anytype-source.tar.gz" | sha256sum -c -
tar -xzf /build/anytype-source.tar.gz --strip-components=1
patch -p1 < "$patch_dir/security.patch"

tantivy_dir="/build/anytype/dist/tantivy-linux-$arch"
mkdir -p "$tantivy_dir"
curl -fsSL --retry 3 "https://github.com/anyproto/tantivy-go/releases/download/$tantivy_version/linux-$arch-musl.tar.gz" -o /build/tantivy.tar.gz
echo "$tantivy_sha256  /build/tantivy.tar.gz" | sha256sum -c -
tar -xzf /build/tantivy.tar.gz -C "$tantivy_dir"
test -s "$tantivy_dir/libtantivy_go.a"
touch "$tantivy_dir/.version-$tantivy_version"
ln -sf /usr/bin/gcc "/usr/local/bin/$musl_cc"

export GOTOOLCHAIN=local GOFLAGS='-mod=readonly -trimpath'
export CGO_ENABLED=1 CGO_LDFLAGS="-L$tantivy_dir"
# Anytype's session tests exercise JWT generation, signing, and validation.
go test github.com/golang-jwt/jwt/v4 github.com/anyproto/anytype-heart/core/session
make "build-linux-$arch" VERSION=v0.4.0-security.1 COMMIT="$source_revision" \
  GIT_STATE=dirty BUILD_TIME='2026-09-30 16:16:41'
cp "dist/anytype-linux-$arch" /out/anytype
cp LICENSE.md /out/LICENSE-anytype-cli.md
cp /build/heart/LICENSE.md /out/LICENSE-anytype-heart.md
go version -m /out/anytype
