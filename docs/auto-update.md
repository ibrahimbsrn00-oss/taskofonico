# Taskofonico Auto Update

Taskofonico now uses Tauri's official updater flow with GitHub Releases.

## What this gives you

- Users do not manually download every new version.
- The desktop app checks for updates automatically on launch.
- If a newer signed release exists, it downloads, installs, and restarts the app.
- GitHub Releases is enough for 3-5 users and is free for this setup.

## One-time setup

1. Generate the updater signing key locally:

```bash
cd "/Users/ibasaran/Downloads/basecamp-task-extractor (3)"
npm run tauri signer generate -- -w ~/.tauri/taskofonico.key
```

2. Save the private key contents into the GitHub repository secret:

- `TAURI_SIGNING_PRIVATE_KEY`

3. If you used a password for the key, save it as:

- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

4. Save the public key contents as this GitHub repository secret:

- `TASKOFONICO_UPDATER_PUBKEY`

Note:
- The public key is safe to share, but using a GitHub secret keeps setup simple.
- The private key must never be shared.

## Release flow

1. Bump the app version in [tauri.conf.json](/Users/ibasaran/Downloads/basecamp-task-extractor%20(3)/src-tauri/tauri.conf.json).
2. Commit and push `main`.
3. Create and push a version tag:

```bash
git tag v0.1.1
git push origin v0.1.1
```

4. GitHub Actions builds the macOS ARM64 release and publishes it automatically.
5. Existing Taskofonico apps detect the new release on next launch and self-update.

## Current assumptions

- This pipeline currently targets Apple Silicon Macs (`aarch64-apple-darwin`).
- If you later need Intel Mac support too, we can add a second build target.
- The updater remains disabled until `TASKOFONICO_UPDATER_PUBKEY` is present during build.

## Official references

- [Tauri Updater](https://v2.tauri.app/plugin/updater/)
- [Tauri GitHub Release Pipeline](https://v2.tauri.app/distribute/pipelines/github/)
