#!/usr/bin/env node
/**
 * gen-aws-config.js
 *
 * Generates an encrypted aws-config.enc.json file for the classroom app.
 * The file is decrypted in the browser using the student's password.
 *
 * Usage:
 *   source ~/Secret/aws-tin.sh
 *   node gen-aws-config.js <password>
 *
 * The generated file should be placed at:
 *   App/python/classroom/aws-config.enc.json
 *
 * NEVER commit your password or raw AWS keys to git.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node gen-aws-config.js <password>');
  console.error('Make sure AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set (source ~/Secret/aws-tin.sh)');
  process.exit(1);
}

const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
const region = process.env.AWS_REGION || 'us-east-1';

if (!accessKeyId || !secretAccessKey) {
  console.error('Error: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set.');
  console.error('Run: source ~/Secret/aws-tin.sh');
  process.exit(1);
}

// Plaintext payload
const plaintext = JSON.stringify({ accessKeyId, secretAccessKey, region });

// Derive key with PBKDF2 (matches browser Web Crypto)
const salt = 'tinmarino-py-classroom';  // fixed salt (not secret, just unique)
const iterations = 100000;
const keyLen = 32;  // AES-256

const key = crypto.pbkdf2Sync(password, salt, iterations, keyLen, 'sha256');

// Encrypt with AES-256-GCM
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
let encrypted = cipher.update(plaintext, 'utf8');
encrypted = Buffer.concat([encrypted, cipher.final()]);
const authTag = cipher.getAuthTag();

// Combine ciphertext + authTag (browser Web Crypto AES-GCM expects them concatenated)
const ciphertext = Buffer.concat([encrypted, authTag]);

const output = {
  salt: salt,
  iv: iv.toString('base64'),
  ciphertext: ciphertext.toString('base64')
};

const outPath = path.join(__dirname, 'aws-config.enc.json');
fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log('Generated:', outPath);
console.log('Salt:', salt);
console.log('Ciphertext length:', ciphertext.length, 'bytes');
console.log('\nNow deploy this file alongside index.html. Do NOT commit your password.');
