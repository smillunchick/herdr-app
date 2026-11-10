#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
SDK=${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}}
JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}
export JAVA_HOME PATH=$JAVA_HOME/bin:$PATH
TOOLS=$SDK/build-tools/36.0.0
JAR=$SDK/platforms/android-37.2/android.jar
TARGET=${CARGO_TARGET_DIR:-target}
LIB=$TARGET/aarch64-linux-android/debug/libherdr_android.so
if [ ! -f "$LIB" ]; then printf '%s\n' 'Build the Android native library first.' >&2; exit 1; fi
build=$PWD/android/build
mkdir -p "$build/generated" "$build/classes" "$build/dex" "$build/package/lib/arm64-v8a"
"$TOOLS/aapt2" compile --dir android/res -o "$build/resources.zip"
"$TOOLS/aapt2" link -o "$build/resources.apk" -I "$JAR" --manifest android/AndroidManifest.xml --java "$build/generated" --min-sdk-version 26 --target-sdk-version 36 --rename-manifest-package dev.herdr.android.debug --debug-mode "$build/resources.zip"
find android/java "$build/generated" -name '*.java' > "$build/sources.txt"
javac -source 8 -target 8 -bootclasspath "$TOOLS/core-lambda-stubs.jar:$JAR" -d "$build/classes" @"$build/sources.txt"
jar --create --file "$build/classes.jar" -C "$build/classes" .
"$TOOLS/d8" --min-api 26 --lib "$JAR" --output "$build/dex" "$build/classes.jar"
cp "$build/resources.apk" "$build/unaligned.apk"
cp "$build/dex/classes.dex" "$build/package/"
cp "$LIB" "$build/package/lib/arm64-v8a/"
(cd "$build/package" && zip -q -0 "$build/unaligned.apk" classes.dex lib/arm64-v8a/libherdr_android.so)
"$TOOLS/zipalign" -P 16 -f 4 "$build/unaligned.apk" "$build/aligned.apk"
keys=$HOME/.local/share/herdr-android
mkdir -p "$keys"
chmod 700 "$keys"
if [ ! -f "$keys/debug.keystore" ]; then
    keytool -genkeypair -keystore "$keys/debug.keystore" -alias androiddebugkey -storepass android -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=Herdr Android development' >/dev/null 2>&1
    chmod 600 "$keys/debug.keystore"
fi
"$TOOLS/apksigner" sign --ks "$keys/debug.keystore" --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android --out "$build/herdr-android-debug.apk" "$build/aligned.apk"
"$TOOLS/apksigner" verify --verbose "$build/herdr-android-debug.apk"
printf '%s\n' "$build/herdr-android-debug.apk"
