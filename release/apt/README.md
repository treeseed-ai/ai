# APT release key

Before the first public release, export the dedicated public key to
`treeseed-ai-archive-keyring.asc` and put its uppercase 40-hex fingerprint in
`RELEASE_KEY_FINGERPRINT`. Release preflight deliberately fails until both
files contain valid, matching key material. Keep the private release subkey and
passphrase only in the protected GitHub `production` environment. The release
validator checks that the committed fingerprint belongs to this public key.
