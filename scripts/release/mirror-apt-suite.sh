#!/bin/sh
set -eu
base=${1%/}
suite=${2:?APT suite is required}
site=${3:?APT output directory is required}
source_root="$base/dists/$suite"
target_root="$site/dists/$suite"
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
if ! curl -fsS "$source_root/Release" -o "$temporary/Release"; then
	exit 3
fi
mkdir -p "$target_root/main/binary-amd64" "$site/pool/$suite"
for path in Release InRelease Release.gpg main/binary-amd64/Packages main/binary-amd64/Packages.xz; do
	mkdir -p "$(dirname "$target_root/$path")"
	if test "$path" = Release; then cp "$temporary/Release" "$target_root/Release"
	else curl -fsS "$source_root/$path" -o "$target_root/$path"
	fi
done
key=treeseed-ai-archive-keyring.asc
key_source=release/apt/treeseed-ai-archive-keyring.asc
if test "$suite" = development; then
	key=treeseed-ai-development-archive-keyring.asc
	key_source=release/apt-development/treeseed-ai-development-archive-keyring.asc
fi
mkdir -m 0700 "$temporary/gnupg"
gpg --batch --homedir "$temporary/gnupg" --import "$key_source" >/dev/null 2>&1
gpg --batch --homedir "$temporary/gnupg" --output "$temporary/signed-release" --decrypt "$target_root/InRelease" >/dev/null 2>&1
cmp "$temporary/signed-release" "$target_root/Release"
while IFS=' ' read -r label filename; do
	test "$label" = Filename: || continue
	mkdir -p "$site/$(dirname "$filename")"
	curl -fsS "$base/$filename" -o "$site/$filename"
done < "$target_root/main/binary-amd64/Packages"
mkdir -p "$target_root/main/binary-amd64/by-hash/SHA256"
for file in Packages Packages.xz; do
	digest=$(sha256sum "$target_root/main/binary-amd64/$file" | cut -d' ' -f1)
	cp "$target_root/main/binary-amd64/$file" "$target_root/main/binary-amd64/by-hash/SHA256/$digest"
done
cp "$key_source" "$site/$key"
printf 'Mirrored signed %s suite from %s\n' "$suite" "$base"
