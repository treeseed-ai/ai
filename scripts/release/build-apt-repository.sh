#!/bin/sh
set -eu
debs=${1:?Debian package directory is required}
site=${2:?APT output directory is required}
version=${3:?Version is required}
arch=amd64
pool="$site/pool/main/t/treeseed-ai"
binary="$site/dists/stable/main/binary-$arch"
mkdir -p "$pool" "$binary"
cp "$debs"/treeseed-ai-*_${arch}.deb "$pool/"
(cd "$site" && dpkg-scanpackages --arch "$arch" pool /dev/null) > "$binary/Packages"
xz -9 --threads=0 --keep --force "$binary/Packages"
apt-ftparchive -o APT::FTPArchive::Release::Origin='TreeSeed AI' -o APT::FTPArchive::Release::Label='TreeSeed AI' -o APT::FTPArchive::Release::Suite=stable -o APT::FTPArchive::Release::Codename=stable -o APT::FTPArchive::Release::Architectures=amd64 -o APT::FTPArchive::Release::Components=main release "$site/dists/stable" > "$site/dists/stable/Release"
gpg --batch --yes --pinentry-mode loopback --passphrase "$APT_GPG_PASSPHRASE" --local-user "$APT_RELEASE_FINGERPRINT" --clearsign --output "$site/dists/stable/InRelease" "$site/dists/stable/Release"
gpg --batch --yes --pinentry-mode loopback --passphrase "$APT_GPG_PASSPHRASE" --local-user "$APT_RELEASE_FINGERPRINT" --detach-sign --armor --output "$site/dists/stable/Release.gpg" "$site/dists/stable/Release"
cp release/apt/treeseed-ai-archive-keyring.asc "$site/treeseed-ai-archive-keyring.asc"
