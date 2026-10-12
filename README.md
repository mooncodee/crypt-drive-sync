# Crypt Drive Sync

Sync your Obsidian vault across all your devices — Mac, Windows, Linux, iPhone, iPad, Android — through **your own Google Drive**, with **end-to-end encryption**. Google stores only encrypted files: no note names, no text.

The encryption format is [rclone crypt](https://rclone.org/crypt/), so your synced vault is also readable, checkable and restorable with plain `rclone` on any computer — no lock-in to this plugin.

## Features

- Works inside Obsidian on every platform, including mobile. No server, no extra app.
- Encryption happens on your device before anything is sent. The password never leaves the device.
- Your own Google Cloud client: no shared app, no third party between you and Google.
- Guided setup with links for every step: create the client, sign in, choose a password, pick a folder.
- Safe by design:
  - a conflict keeps **both** versions;
  - deletions go to a dated trash folder in the cloud, never deleted for good;
  - the first sync only merges;
  - a sync that would delete many files stops and asks;
  - a wrong password stops sync instead of creating a second, unreadable copy.
- English and Russian interface (follows Obsidian's language).

## Disclosures

- **Network use.** The plugin connects to Google only:
  - `oauth2.googleapis.com` — to sign in and refresh the sign-in;
  - `www.googleapis.com` — Google Drive API, to store and read your encrypted files.

  Signing in opens `google.com/device` in your browser, where you paste the code. There are no other servers, no analytics, no telemetry.
- **Account required.** You need a Google account (a free one works; storage counts toward your Google quota) and your own free Google Cloud OAuth client (created once in about five minutes; the plugin walks you through it).
- **Access scope.** The plugin requests `drive.file`: it can see only files it created itself. The rest of your Google Drive is invisible to it.

Privacy policy: <https://mooncodee.github.io/crypt-drive-sync/privacy.html>

## How it works

1. Notes are encrypted on the device with a key derived from your password:
   - file contents with XSalsa20-Poly1305;
   - file and folder names with AES-EME;
   - the key comes from scrypt — exactly as rclone crypt does it.
2. Encrypted files go to a folder in your Google Drive (default `crypt-drive-sync/`).
3. Each device remembers what it last synced and compares three states — this device, the cloud, the last sync — to decide what to upload, download, or move to trash.

Your password and Google sign-in are kept in Obsidian's secret storage on each device, separately for each vault. They are never synced and never sent anywhere. **The password cannot be recovered** — without it the encrypted notes cannot be read.

## Install

- **Community plugins:** Settings → Community plugins → Browse → search “Crypt Drive Sync”.
- **Manual:** copy `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/mooncodee/crypt-drive-sync/releases) into `<vault>/.obsidian/plugins/crypt-drive-sync/`.

## Set up

Enable the plugin — the setup wizard opens by itself. Allow about ten minutes the first time and two on each next device:

1. **Google Cloud client.** Google requires every app to have its own OAuth client, so you create one for yourself. It's free, takes about five minutes, and the wizard links each step:
   - create a project and enable the Google Drive API;
   - if Google shows “Get started”, fill it in first (app name, your email, External);
   - fill in Branding: any app name, your email, and homepage and privacy-policy links — any public pages work, e.g. the plugin's [homepage](https://mooncodee.github.io/crypt-drive-sync/) and [privacy policy](https://mooncodee.github.io/crypt-drive-sync/privacy.html);
   - on Audience, press **Publish app** — otherwise Google expires the sign-in every 7 days. Publishing doesn't make it public: only you know the client ID;
   - create a client of type **TVs and Limited Input devices** and copy its ID and secret.
2. **Sign in** — the code is copied for you and `google.com/device` opens in your browser; paste the code and press Allow.
3. **Where to store** — a folder in your Google Drive (default `crypt-drive-sync`) and the vault's name inside it (default: the vault's name).
4. **Password** — encrypts your notes; checked against the cloud right away. Then the first sync, which only merges.

On every other device: install the plugin and go through the same steps with **the same client, password and folder name**.

Sync then runs by itself:
- on startup;
- every 10 minutes;
- 30 seconds after an edit;
- when you return to the app (its window becomes visible again).

The ↻ ribbon button and the status bar item sync immediately.

## Using it with rclone

If you already use an rclone crypt remote on Google Drive, the plugin can share it. Example config:

```ini
[drive]
type = drive
scope = drive.file
client_id = <your client id>
client_secret = <your client secret>

[crypt]
type = crypt
remote = drive:encrypted
password = <obscured>
```

Set up the plugin with:
- **Where to store → Folder in Google Drive:** `encrypted`;
- **Encryption password:** the same password as the crypt remote.

The vault then appears as `crypt:<vault name>`. Check it with:

```
rclone cryptcheck <local vault> crypt:<vault name>
```

Google's `drive.file` scope is per Google Cloud project, so the plugin can see a folder created by your rclone only if both use the same project: create the plugin's “TVs and Limited Input devices” client in your rclone's project.

## Limitations

- Not real-time: sync runs on the triggers above (mobile apps are suspended in the background).
- Files over 50 MB are skipped by default: on mobile a file must fit in memory. The limit is configurable.
- A rename syncs as delete + create (the old name goes to the cloud trash).
- Obsidian's own settings folder (`.obsidian`) and other dot-files are not synced.

## Removing the plugin

The password, the Google sign-in and the client secret live in Obsidian's secret storage, which uninstalling a plugin doesn't clear. First choose **Advanced → Reset setup on this device**, then uninstall. Revoke access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions); delete the plugin's folder in Google Drive to remove the encrypted copy.

## Build from source

```
npm install
npm test          # includes byte-for-byte compatibility tests against real rclone (run tests/make-fixtures.sh once)
npm run build
```

Optional, for private builds only: place `google-client.json` (the JSON downloaded for a “TVs and Limited Input devices” client) next to `package.json` to bake that client in, so the people you give the build to can skip step 1. It is never part of the repository, and public releases are built without it.

## License

[MIT](LICENSE)
