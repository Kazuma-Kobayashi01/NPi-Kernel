#!/bin/sh
# Build the guest image of the sandbox VM: a Linux kernel and a root filesystem (an initramfs) holding Alpine
# with the packages in guest/packages.txt, plus the guest's init and command agent.
#
#   scripts/build-image.sh [alpine]   # writes $NPI_VM_IMAGE_DIR (default ~/.local/share/npi/sandbox-vm/image)
#   scripts/build-image.sh ubuntu     # an Ubuntu 24.04 root; default ~/.local/share/npi/sandbox-vm/image-ubuntu
#
# How: the Alpine aarch64 kernel is booted once under the helper with a throwaway RAM root made from
# alpine-minirootfs; inside it `apk` installs the packages into a directory and tars it up. That tar becomes
# the runtime root (rootfs.cpio.gz). The Ubuntu base works the same way, except the build VM unpacks the pinned
# ubuntu-base tarball and runs `apt` in a chroot (packages in guest/packages-ubuntu.txt, roughly 200 MB of
# downloads, a 250 MB image); both bases boot the Alpine kernel, whose modules are copied into the root. It downloads roughly 60 MB (the kernel and initramfs 20 MB, the minirootfs 4 MB, 64 packages that unpack to 78 MiB; the package size is an estimate),
# needs network access for the build VM only, and needs the Swift toolchain once, for the helper.
#
# Environment: NPI_VM_BASE (alpine | ubuntu, the argument wins), NPI_VM_IMAGE_DIR (output), NPI_VM_BUILD_DIR
# (scratch, kept; default a temp folder, removed on success), NPI_VM_ALPINE (release, default 3.24),
# NPI_VM_BUILD_MEM (build VM MiB, default 3072; 4096 for ubuntu).
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
base=${1:-${NPI_VM_BASE:-alpine}}
case $base in
alpine) image_name=image; build_mem=3072 ;;
ubuntu) image_name=image-ubuntu; build_mem=4096 ;;
*) echo "usage: $0 [alpine|ubuntu]" >&2; exit 64 ;;
esac
image_dir=${NPI_VM_IMAGE_DIR:-$HOME/.local/share/npi/sandbox-vm/$image_name}
release=${NPI_VM_ALPINE:-3.24}
mirror=https://dl-cdn.alpinelinux.org/alpine/v$release
arch=aarch64
keep_build=1
if [ -z "${NPI_VM_BUILD_DIR:-}" ]; then
	NPI_VM_BUILD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/npi-vm-image.XXXXXX")
	keep_build=0
fi
work=$NPI_VM_BUILD_DIR
mkdir -p "$work" "$image_dir"

# Pinned: a different build of the same release is refused rather than trusted.
kernel_sha=cd05fed9e617b5df93dc62ece9b78c422fd94e9b432a2f7c092714b139d5eef4
initramfs_sha=189402937646965374ef2df5d37f76467135179ae168c88175df2fe3e264a0b0
minirootfs=alpine-minirootfs-3.24.4-$arch.tar.gz
minirootfs_sha=4b14c18f7e90a063b61462ea1462a5732c154bf6adad594974fe6487cd98a8de

# The Ubuntu root: the point release's ubuntu-base, pinned like the Alpine files (cdimage.ubuntu.com SHA256SUMS).
ubuntu_base=ubuntu-base-24.04.5-base-arm64.tar.gz
ubuntu_base_sha=a91d5a93010193712d346d761372b7c9db6dfcf093893161c64ca107f05914f2
ubuntu_url=https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/$ubuntu_base

fetch() { # name url sha256
	if [ ! -f "$work/$1" ]; then
		echo "downloading $1"
		curl -fSL --max-time 900 -o "$work/$1.part" "$2"
		mv "$work/$1.part" "$work/$1"
	fi
	actual=$(shasum -a 256 "$work/$1" | cut -d' ' -f1)
	if [ "$actual" != "$3" ]; then
		echo "error: $1 has sha256 $actual, expected $3 (a new Alpine build? update the pin in this script)" >&2
		rm -f "$work/$1"
		exit 1
	fi
}

fetch vmlinuz-virt "$mirror/releases/$arch/netboot/vmlinuz-virt" "$kernel_sha"
fetch initramfs-virt "$mirror/releases/$arch/netboot/initramfs-virt" "$initramfs_sha"
fetch "$minirootfs" "$mirror/releases/$arch/$minirootfs" "$minirootfs_sha"
if [ "$base" = ubuntu ]; then fetch "$ubuntu_base" "$ubuntu_url" "$ubuntu_base_sha"; fi

helper=$here/bin/npi-vm-helper
[ -x "$helper" ] || "$here/helper/build.sh"

# The kernel: vmlinuz-virt is an EFI zboot image; Virtualization.framework wants the raw Image in its payload.
python3 - "$work/vmlinuz-virt" "$work/Image" <<'PY'
import struct, sys, zlib
data = open(sys.argv[1], "rb").read()
if data[4:8] != b"zimg":
    raise SystemExit("vmlinuz-virt is not an EFI zboot image")
offset, size = struct.unpack_from("<II", data, 8)
if data[24:56].split(b"\0")[0] != b"gzip":
    raise SystemExit("unsupported zboot compression")
image = zlib.decompress(data[offset:offset + size], 16 + zlib.MAX_WBITS)
if image[56:60] != b"ARMd":
    raise SystemExit("not an arm64 kernel Image")
open(sys.argv[2], "wb").write(image)
PY

# The kernel's modules come from the netboot initramfs, which matches the kernel.
rm -rf "$work/stock" "$work/extra" "$work/share"
mkdir -p "$work/stock" "$work/extra/sbin" "$work/share"
(cd "$work/stock" && gunzip -c ../initramfs-virt | cpio -idm 2>/dev/null)
if [ "$base" = ubuntu ]; then
	cp "$here/guest/bootstrap-ubuntu" "$work/extra/npi-bootstrap"
else
	cp "$here/guest/bootstrap" "$work/extra/npi-bootstrap"
fi
chmod +x "$work/extra/npi-bootstrap"

# Bootstrap root: the minirootfs, then (as a second cpio, which the kernel unpacks over the first) the modules and
# the bootstrap script. Everything is owned by root, whoever builds.
{
	bsdtar -cf - --format newc @"$work/$minirootfs" | gzip -1
	bsdtar -cf - --format newc --uid 0 --gid 0 -C "$work/stock" lib/modules | gzip -1
	bsdtar -cf - --format newc --uid 0 --gid 0 -C "$work/extra" npi-bootstrap | gzip -1
} > "$work/bootstrap.cpio.gz"

cp "$here/guest/npi-init" "$here/guest/agent.py" "$work/share/"
echo "alpine_repo=$mirror" > "$work/share/repo"
if [ "$base" = ubuntu ]; then
	cp "$here/guest/packages-ubuntu.txt" "$work/share/packages.txt"
	cp "$work/$ubuntu_base" "$work/share/$ubuntu_base"
	echo "ubuntu_base=$ubuntu_base" >> "$work/share/repo"
else
	cp "$here/guest/packages.txt" "$work/share/"
fi
rm -f "$work/share/rootfs.tar" "$work/share/done"

echo "booting the build VM for the $base root (this installs the packages; a few minutes)"
"$helper" run --kernel "$work/Image" --initrd "$work/bootstrap.cpio.gz" --mem "${NPI_VM_BUILD_MEM:-$build_mem}" --cpus 4 \
	--net nat --share "$work/share" --cmdline "console=hvc0 rdinit=/npi-bootstrap loglevel=3" | tee "$work/build.log"

if [ ! -f "$work/share/done" ] || [ ! -f "$work/share/rootfs.tar" ]; then
	echo "error: the build VM did not finish; see $work/build.log" >&2
	exit 1
fi

# The runtime root: the tar the build VM wrote, as a gzip'd newc cpio (entries keep the owners the tar records).
bsdtar -cf - --format newc @"$work/share/rootfs.tar" | gzip -9 > "$work/rootfs.cpio.gz"

cp "$work/Image" "$image_dir/Image.new"
cp "$work/rootfs.cpio.gz" "$image_dir/rootfs.cpio.gz.new"
mv "$image_dir/Image.new" "$image_dir/Image"
mv "$image_dir/rootfs.cpio.gz.new" "$image_dir/rootfs.cpio.gz"
cat > "$image_dir/manifest.json" <<EOF
{
	"base": "$base",
	"alpine": "$release",
	"minirootfs": "$minirootfs",
	"ubuntuBase": "$([ "$base" = ubuntu ] && echo "$ubuntu_base")",
	"kernelSha256": "$kernel_sha",
	"rootfsSha256": "$(shasum -a 256 "$image_dir/rootfs.cpio.gz" | cut -d' ' -f1)",
	"built": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "image written to $image_dir"
ls -l "$image_dir"
if [ "$keep_build" = 0 ]; then rm -rf "$work"; fi
