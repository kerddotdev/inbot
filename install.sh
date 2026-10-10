#!/bin/sh
set -eu

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
version=
install_root=${INBOT_INSTALL_ROOT:-"$HOME/.local/share/inbot"}
bin_dir=${INBOT_BIN_DIR:-"$HOME/.local/bin"}
release_base=${INBOT_RELEASE_BASE_URL:-}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version|--install-root|--bin-dir)
      [ "$#" -ge 2 ] || fail "Missing value for $1"
      case "$1" in
        --version) version=${2#v} ;;
        --install-root) install_root=$2 ;;
        --bin-dir) bin_dir=$2 ;;
      esac
      shift 2 ;;
    --help|-h)
      printf 'Usage: sh install.sh [--version VERSION] [--install-root DIR] [--bin-dir DIR]\n'
      exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail 'Supported systems: macOS and Linux.' ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) fail 'Supported architectures: arm64 and x64.' ;;
esac
command -v curl >/dev/null 2>&1 || fail 'Install curl first.'
command -v tar >/dev/null 2>&1 || fail 'Install tar first.'
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  fail 'Install sha256sum or shasum first.'
fi
if [ -z "$version" ]; then
  [ -z "$release_base" ] || fail '--version is required with INBOT_RELEASE_BASE_URL.'
  metadata=$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    https://api.github.com/repos/kerddotdev/inbot/releases/latest) || fail 'No published release could be fetched.'
  version=$(printf '%s' "$metadata" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\([^"]*\)".*/\1/p')
fi
printf '%s\n' "$version" | LC_ALL=C awk '/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/ { valid=1 } END {exit !valid}' || fail 'Invalid release version.'
if [ -z "$release_base" ]; then
  release_base="https://github.com/kerddotdev/inbot/releases/download/v$version"
fi
case "$release_base" in
  https://*|http://127.0.0.1:*|http://localhost:*|file://*) ;;
  *) fail 'Release URL must use HTTPS or an explicit local fixture.' ;;
esac
case "$install_root:$bin_dir" in
  *'
'*|*'"'*|*'`'*|*'$'*|*'\'*) fail 'Install paths contain unsupported shell characters.' ;;
esac
case "$install_root" in /*) ;; *) fail 'Install root must be absolute.' ;; esac
case "$bin_dir" in /*) ;; *) fail 'Bin directory must be absolute.' ;; esac
archive="inbot-$version-$os-$arch.tar.gz"
work=$(mktemp -d "${TMPDIR:-/tmp}/inbot-install.XXXXXX")
staging=
cleanup() {
  rm -rf "$work"
  if [ -n "$staging" ]; then rm -rf "$staging"; fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
fetch() {
  curl --fail --silent --show-error --location --proto '=https,http,file' --proto-redir '=https' "$release_base/$1" -o "$work/$1"
}
fetch SHA256SUMS || fail 'Could not download release checksums.'
expected=$(awk -v name="$archive" '$2 == name {print $1; count++} END {if (count != 1) exit 1}' "$work/SHA256SUMS") || fail 'Archive checksum missing or duplicated.'
printf '%s\n' "$expected" | LC_ALL=C awk '/^[a-fA-F0-9]+$/ && length($0)==64 {valid=1} END {exit !valid}' || fail 'Invalid SHA-256 checksum.'
expected=$(printf '%s' "$expected" | tr 'ABCDEF' 'abcdef')
fetch "$archive" || fail 'Could not download release archive.'
[ "$(checksum "$work/$archive")" = "$expected" ] || fail 'SHA-256 mismatch. Nothing was installed.'
tar -tzf "$work/$archive" > "$work/entries"
if ! awk '/^inbot\// && $0 !~ /(^|\/)\.\.($|\/)/ {next} {exit 1}' "$work/entries"; then
  fail 'Archive contains an unsafe path.'
fi
tar -xzf "$work/$archive" -C "$work"
[ -x "$work/inbot/inbot" ] && [ -x "$work/inbot/runtime/bin/node" ] && \
  [ -f "$work/inbot/application/dist/apps/cli/src/main.js" ] || fail 'Incomplete release archive.'
mkdir -p "$install_root/app" "$bin_dir"
destination="$install_root/app/$version"
if [ -e "$destination" ]; then
  [ -f "$destination/.archive-sha256" ] && \
    [ "$(cat "$destination/.archive-sha256")" = "$expected" ] || fail 'Existing version differs; choose a new install root or remove it explicitly.'
else
  staging=$(mktemp -d "$install_root/app/.install.XXXXXX")
  cp -R "$work/inbot/." "$staging/"
  printf '%s\n' "$expected" > "$staging/.archive-sha256"
  mv "$staging" "$destination"
  staging=
fi
shim="$work/inbot-shim"
cat > "$shim" <<SHIM
#!/bin/sh
exec "$destination/inbot" "\$@"
SHIM
chmod 755 "$shim"
# A shim preserves the package-relative launcher paths when invoked through PATH.
cp "$shim" "$bin_dir/.inbot-new-$$"
mv -f "$bin_dir/.inbot-new-$$" "$bin_dir/inbot"
printf 'Installed Inbot %s to %s\n' "$version" "$destination"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) printf 'Add this directory to PATH: %s\n' "$bin_dir" ;;
esac
printf 'Next: inbot serve --init\nNo service was installed.\n'
