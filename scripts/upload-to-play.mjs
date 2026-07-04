#!/usr/bin/env node
// Uploads a signed AAB to the Google Play Store internal test track.
// Usage: node scripts/upload-to-play.mjs
//
// Requires:
//   android/play-store-key.json  — service account key from Google Cloud Console
//   android/app/build/outputs/bundle/release/app-release.aab

import { google } from 'googleapis';
import { createReadStream, statSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const KEY_FILE   = resolve(ROOT, 'android', 'play-store-key.json');
const AAB_FILE   = resolve(ROOT, 'android', 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab');
const PACKAGE    = 'com.contxt.app';
const TRACK      = 'internal';

async function main() {
  console.log('Authenticating with service account…');
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  const client = await auth.getClient();
  const play = google.androidpublisher({ version: 'v3', auth: client });

  // 1. Open a new edit
  console.log('Opening edit…');
  const editRes = await play.edits.insert({ packageName: PACKAGE });
  const editId = editRes.data.id;
  console.log(`  Edit ID: ${editId}`);

  // 2. Upload the AAB
  console.log(`Uploading AAB (${(statSync(AAB_FILE).size / 1024 / 1024).toFixed(1)} MB)…`);
  const uploadRes = await play.edits.bundles.upload({
    packageName: PACKAGE,
    editId,
    media: {
      mimeType: 'application/octet-stream',
      body: createReadStream(AAB_FILE),
    },
  });
  const versionCode = uploadRes.data.versionCode;
  console.log(`  Uploaded — version code: ${versionCode}`);

  // 3. Assign to internal track
  console.log(`Assigning to ${TRACK} track…`);
  await play.edits.tracks.update({
    packageName: PACKAGE,
    editId,
    track: TRACK,
    requestBody: {
      track: TRACK,
      releases: [{
        versionCodes: [String(versionCode)],
        status: 'completed',
      }],
    },
  });

  // 4. Commit the edit
  console.log('Committing edit…');
  await play.edits.commit({ packageName: PACKAGE, editId });

  console.log('\n✓ Done! The AAB is now live on the internal test track.');
  console.log('  Go to Play Console → Testing → Internal testing to add testers.');
}

main().catch((err) => {
  console.error('\n✗ Upload failed:', err.message ?? err);
  if (err.errors) err.errors.forEach(e => console.error(' ', e.message));
  process.exit(1);
});
