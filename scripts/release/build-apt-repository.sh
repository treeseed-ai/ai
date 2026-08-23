#!/bin/sh
set -eu
debs=${1:?Debian package directory is required}
site=${2:?APT output directory is required}
version=${3:?Version is required}
suite=${4:-stable}
arch=amd64
pool="$site/pool/$suite/main/t/treeseed-ai"
binary="$site/dists/$suite/main/binary-$arch"
mkdir -p "$pool" "$binary"
find "$debs" -maxdepth 1 -type f ! -name '*+cfg.*' \( -name 'treeseed-ai_*_amd64.deb' -o -name 'treeseed-ai-*_amd64.deb' -o -name 'treeseed-ai-*_all.deb' \) -exec cp {} "$pool/" \;
(cd "$site" && dpkg-scanpackages --arch "$arch" --multiversion "pool/$suite" /dev/null) > "$binary/Packages"
xz -9 --threads=0 --keep --force "$binary/Packages"
mkdir -p "$binary/by-hash/SHA256"
for file in Packages Packages.xz; do digest=$(sha256sum "$binary/$file" | cut -d' ' -f1); cp "$binary/$file" "$binary/by-hash/SHA256/$digest"; done
epoch=${SOURCE_DATE_EPOCH:-$(git show -s --format=%ct HEAD)}
release_date=$(date --utc --date="@$epoch" --rfc-email)
valid_seconds=31536000
if [ "$suite" = development ]; then valid_seconds=604800; fi
valid_until=$(date --utc --date="@$((epoch + valid_seconds))" --rfc-email)
apt-ftparchive -o APT::FTPArchive::Release::Origin='TreeSeed AI' -o APT::FTPArchive::Release::Label='TreeSeed AI' -o APT::FTPArchive::Release::Suite="$suite" -o APT::FTPArchive::Release::Codename="$suite" -o APT::FTPArchive::Release::Architectures=amd64 -o APT::FTPArchive::Release::Components=main -o APT::FTPArchive::Release::Acquire-By-Hash=yes -o APT::FTPArchive::Release::Date="$release_date" -o APT::FTPArchive::Release::Valid-Until="$valid_until" release "$site/dists/$suite" > "$site/dists/$suite/Release"
gpg --batch --yes --pinentry-mode loopback --passphrase "$APT_GPG_PASSPHRASE" --local-user "$APT_RELEASE_FINGERPRINT" --clearsign --output "$site/dists/$suite/InRelease" "$site/dists/$suite/Release"
gpg --batch --yes --pinentry-mode loopback --passphrase "$APT_GPG_PASSPHRASE" --local-user "$APT_RELEASE_FINGERPRINT" --detach-sign --armor --output "$site/dists/$suite/Release.gpg" "$site/dists/$suite/Release"
if [ "$suite" = stable ]; then cp release/apt/treeseed-ai-archive-keyring.asc "$site/treeseed-ai-archive-keyring.asc"; else cp release/apt-development/treeseed-ai-development-archive-keyring.asc "$site/treeseed-ai-development-archive-keyring.asc"; fi
