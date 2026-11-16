#!/bin/sh
# Build and sign the VM helper into ../bin/npi-vm-helper.
#
# Needs the Swift toolchain (Xcode or the command line tools). The helper must carry the
# com.apple.security.virtualization entitlement to use Virtualization.framework; an ad-hoc signature is
# enough on the machine that builds it. NPI_VM_SIGN_IDENTITY picks another identity (a certificate name
# from `security find-identity -v -p codesigning`).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../bin"
mkdir -p "$out"
swiftc -O -o "$out/npi-vm-helper" "$here/main.swift"
codesign --force --sign "${NPI_VM_SIGN_IDENTITY:--}" --entitlements "$here/entitlements.plist" "$out/npi-vm-helper"
echo "built $out/npi-vm-helper"
