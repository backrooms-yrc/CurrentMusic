#!/usr/bin/env bash
# CurrentMusic APK 构建脚本（无 Gradle/AGP：aapt2 + javac + d8 + zipalign + apksigner）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_HOME:-/opt/android-sdk}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
APP="$ROOT/app"
WEB="$ROOT/web"
OUT="${1:-/tmp/cm-apk}"
VER_NAME="${VER_NAME:-1.0.0}"
VER_CODE="${VER_CODE:-1}"
KS="$ROOT/keystore.jks"
APK_FINAL="$ROOT/dist/CurrentMusic-v${VER_NAME}.apk"

command -v java >/dev/null || { echo "缺少 JDK"; exit 1; }

echo "==> [1/6] 构建前端 (esbuild)"
(cd "$WEB" && node build.mjs >/dev/null)

echo "==> [2/6] 清理输出目录 $OUT"
rm -rf "$OUT" && mkdir -p "$OUT/gen" "$OUT/classes"

echo "==> [3/6] aapt2 compile + link"
"$BT/aapt2" compile --dir "$APP/src/main/res" -o "$OUT/res.zip"
"$BT/aapt2" link \
  -o "$OUT/base.apk" \
  -I "$PLATFORM" \
  --manifest "$APP/src/main/AndroidManifest.xml" \
  -R "$OUT/res.zip" \
  -A "$APP/src/main/assets" \
  --java "$OUT/gen" \
  --auto-add-overlay \
  --min-sdk-version 24 --target-sdk-version 34 \
  --version-code "$VER_CODE" --version-name "$VER_NAME"

echo "==> [4/6] javac + d8"
find "$APP/src/main/java" -name '*.java' > "$OUT/sources.txt"
find "$OUT/gen" -name '*.java' >> "$OUT/sources.txt"
javac -source 8 -target 8 -encoding UTF-8 \
  -classpath "$PLATFORM" \
  -d "$OUT/classes" @"$OUT/sources.txt" 2> >(grep -v '^Note:\|warning' >&2 || true)
"$BT/d8" --release --lib "$PLATFORM" --output "$OUT" \
  $(find "$OUT/classes" -name '*.class')

echo "==> [5/6] 打包 dex + 对齐"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT" && zip -q unsigned.apk classes.dex)
"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "==> [6/6] 签名"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass currentmusic -keypass currentmusic \
    -alias cm -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=CurrentMusic, OU=CurrentMusic, O=Rcst20, L=Internet, ST=Internet, C=CN"
  echo "已生成自签名 keystore: $KS"
fi
mkdir -p "$ROOT/dist"
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:currentmusic \
  --out "$APK_FINAL" "$OUT/aligned.apk"
"$BT/apksigner" verify "$APK_FINAL" && echo "签名校验通过"

echo "==> 完成: $APK_FINAL ($(du -h "$APK_FINAL" | cut -f1))"
"$BT/aapt" dump badging "$APK_FINAL" | head -6
