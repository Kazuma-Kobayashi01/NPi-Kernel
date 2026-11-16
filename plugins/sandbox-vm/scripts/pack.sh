#!/bin/sh
# Pack the plugin with its guest images inside: dist/extension/npi-plugin-sandbox-vm-<version>.npix, ready to
# install on a machine that has never built an image (`npi plugin install <file>`).
#
#   scripts/pack.sh [output.npix]
#
# The images come from the folders build-image.sh writes (NPI_VM_DATA_DIR, default ~/.local/share/npi/sandbox-vm:
# `image` = alpine, `image-ubuntu` = ubuntu); one that is missing is built first. They are copied into the
# plugin's `images/<base>/` (git-ignored) for the pack and removed again. Rebuild the images after changing
# anything under guest/ or scripts/build-image.sh: this script packs what is there. The plugin prefers an image
# built on the machine over the packed one, so a user can still build their own.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/../../.." && pwd)
data=${NPI_VM_DATA_DIR:-$HOME/.local/share/npi/sandbox-vm}
version=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$here/package.json" | head -1)
out=${1:-$repo/dist/extension/npi-plugin-sandbox-vm-$version.npix}

[ -x "$here/bin/npi-vm-helper" ] || "$here/helper/build.sh"

trap 'rm -rf "$here/images"' EXIT
rm -rf "$here/images"
for base in alpine ubuntu; do
	if [ "$base" = alpine ]; then src=$data/image; else src=$data/image-$base; fi
	if [ ! -f "$src/Image" ] || [ ! -f "$src/rootfs.cpio.gz" ]; then
		NPI_VM_IMAGE_DIR=$src "$here/scripts/build-image.sh" "$base"
	fi
	mkdir -p "$here/images/$base"
	cp "$src/Image" "$src/rootfs.cpio.gz" "$src/manifest.json" "$here/images/$base/"
done

mkdir -p "$(dirname "$out")"
npi plugin pack "$here" -o "$out"
ls -l "$out"
shasum -a 256 "$out"
