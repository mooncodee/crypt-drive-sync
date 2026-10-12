#!/bin/sh
# Builds tests/fixtures/{plain,enc,enc-salt,enc-nodir} with local rclone only.
# Test password, in-memory rclone config (--config ""), no cloud.
set -eu
F="$(cd "$(dirname "$0")" && pwd)/fixtures"
rm -rf "$F"
P="$F/plain"
mkdir -p "$P/bin"

: >"$P/bin/empty.bin"
head -c 1 /dev/urandom > "$P/bin/one.bin"
head -c 65536 /dev/urandom > "$P/bin/64k.bin"
head -c 65537 /dev/urandom > "$P/bin/64k+1.bin"
head -c 1048576 /dev/urandom > "$P/bin/1m.bin"

node -e '
const fs = require("fs"), P = process.argv[1];
const put = (rel, text) => { fs.mkdirSync(require("path").dirname(P + "/" + rel), { recursive: true }); fs.writeFileSync(P + "/" + rel, text); };
const n = "Заметка йё.md";
put("Заметки/" + n.normalize("NFC"), "nfc\n");
put("nfd/" + n.normalize("NFD"), "nfd\n");
put("emoji 😀👍🏽.md", "emoji\n");
put("name with   spaces.md", "spaces\n");
put("long-" + "x".repeat(130) + ".md", "long\n");
put("Папка/Подпапка/Ещё глубже/deep.md", "deep\n");
put("a/b/c/deep.md", "deep2\n");
' "$P"

R="rclone --config="
copy() { $R copy "$P" ":crypt,remote=$F/$1,password=$($R obscure test-pass)$2:"; }
copy enc ""
copy enc-salt ",password2=$($R obscure test-salt)"
copy enc-nodir ",directory_name_encryption=false"
echo "fixtures: $F"
