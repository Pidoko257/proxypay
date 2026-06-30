import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SPEC_PATH = resolve(__dirname, '..', 'docs', 'openapi.json');
const S3_REGION = process.env.AWS_REGION || 'us-east-1';
const S3_BUCKET = process.env.AWS_S3_BUCKET || '';
const S3_KEY = process.env.OPENAPI_S3_KEY || 'openapi.json';
const S3_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || '';
const S3_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || '';

async function uploadSpec(): Promise<void> {
  if (!S3_BUCKET) {
    console.error('AWS_S3_BUCKET is not set. Skipping upload.');
    process.exit(1);
  }

  if (!S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
    console.error('AWS credentials are not configured. Skipping upload.');
    process.exit(1);
  }

  const specContent = readFileSync(SPEC_PATH, 'utf-8');

  const client = new S3Client({
    region: S3_REGION,
    credentials: {
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
    },
  });

  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: S3_KEY,
    Body: specContent,
    ContentType: 'application/json',
    CacheControl: 'no-cache',
  });

  await client.send(command);
  console.log(`OpenAPI spec uploaded to s3://${S3_BUCKET}/${S3_KEY}`);
}

uploadSpec().catch((err) => {
  console.error('Failed to upload OpenAPI spec:', err);
  process.exit(1);
});
