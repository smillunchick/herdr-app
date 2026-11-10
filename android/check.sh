#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
SDK=${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}}
NDK=${ANDROID_NDK_HOME:-$SDK/ndk/29.0.14206865}
ZIG=${ZIG:-zig}
case $("$ZIG" version) in
    0.16.*) ;;
    *) printf '%s\n' 'Herdr needs Zig 0.16. Set ZIG to that compiler.' >&2; exit 1 ;;
esac
case $(uname -s) in
    Darwin) host=darwin-x86_64 ;;
    Linux) host=linux-x86_64 ;;
    *) printf '%s\n' 'Run this Android check on macOS or Linux.' >&2; exit 1 ;;
esac
bin=$NDK/toolchains/llvm/prebuilt/$host/bin
if [ ! -x "$bin/aarch64-linux-android26-clang" ]; then
    printf '%s\n' 'Set ANDROID_NDK_HOME to an installed Android NDK.' >&2
    exit 1
fi
export ANDROID_NDK_HOME=$NDK ZIG
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$bin/aarch64-linux-android26-clang
export CC_aarch64_linux_android=$bin/aarch64-linux-android26-clang
export CXX_aarch64_linux_android=$bin/aarch64-linux-android26-clang++
export AR_aarch64_linux_android=$bin/llvm-ar
export BINDGEN_EXTRA_CLANG_ARGS="--sysroot=$NDK/toolchains/llvm/prebuilt/$host/sysroot"
exec cargo check -p herdr-android --lib --target aarch64-linux-android
