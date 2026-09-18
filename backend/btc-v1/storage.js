'use strict';
/**
 * Paper-trader state persistence. Cloudflare R2 when R2_* env vars are set
 * (Railway's disk is ephemeral), otherwise a local JSON file.
 */
const fs = require('fs');
const path = require('path');

const LOCAL_FILE = process.env.BTC_STATE_FILE || path.join(__dirname, 'state', 'paper-state.json');
const R2_KEY = process.env.BTC_STATE_KEY || 'btc-v1/paper-state.json';
const R2_BUCKET = process.env.R2_BUCKET_NAME;

let s3 = null;
let S3 = null;
function r2() {
  if (s3) return s3;
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) return null;
  S3 = require('@aws-sdk/client-s3');
  s3 = new S3.S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  return s3;
}

function backend() {
  return r2() ? 'r2' : 'file';
}

async function load() {
  const client = r2();
  if (client) {
    try {
      const res = await client.send(new S3.GetObjectCommand({ Bucket: R2_BUCKET, Key: R2_KEY }));
      const text = await res.Body.transformToString();
      return JSON.parse(text);
    } catch (e) {
      if (e && (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404)) return null;
      throw e;
    }
  }
  if (!fs.existsSync(LOCAL_FILE)) return null;
  return JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
}

async function save(state) {
  const body = JSON.stringify(state, null, 2);
  const client = r2();
  if (client) {
    await client.send(
      new S3.PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: R2_KEY,
        Body: body,
        ContentType: 'application/json',
      })
    );
    return 'r2';
  }
  fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
  fs.writeFileSync(LOCAL_FILE, body);
  return 'file';
}

module.exports = { load, save, backend, LOCAL_FILE };
