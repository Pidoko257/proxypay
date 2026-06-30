import { PutObjectCommand, GetObjectCommand, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import { getS3Client, s3Config } from '../config/s3';
import { Pool } from 'pg';

export interface DocumentUploadInfo {
  documentId: string;
  uploadUrl: string;
  key: string; // temporary S3 key
}

/** Service for handling KYC document storage with presigned URLs.
 * All objects are encrypted with SSE‑S3 (default server‑side encryption) and are private.
 * Temporary uploads are placed under `uploads/` and moved to `kyc/` once confirmed.
 */
export class KYCDocumentStorage {
  private readonly s3Client = getS3Client();
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Generate a presigned PUT URL for a new document (15‑min expiry). */
  async generateUploadUrl(
    userId: string,
    filename: string,
    contentType: string,
    documentType: string,
  ): Promise<DocumentUploadInfo> {
    const documentId = uuidv4();
    const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `uploads/${documentId}/${sanitized}`;

    const command = new PutObjectCommand({
      Bucket: s3Config.bucket,
      Key: key,
      ContentType: contentType,
      Metadata: {
        userId,
        documentId,
        documentType,
        originalName: sanitized,
      },
    });

    const uploadUrl = await getSignedUrl(this.s3Client, command, { expiresIn: 15 * 60 });

    // Persist minimal metadata (status = pending)
    await this.pool.query(
      `INSERT INTO kyc_documents (id, user_id, document_type, s3_key, filename, mime_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [documentId, userId, documentType, key, sanitized, contentType],
    );

    return { documentId, uploadUrl, key };
  }

  /** Move an uploaded file to permanent storage and mark it confirmed. */
  async confirmUpload(documentId: string): Promise<string> {
    const { rows } = await this.pool.query(
      `SELECT s3_key, filename FROM kyc_documents WHERE id = $1`,
      [documentId],
    );
    if (rows.length === 0) throw new Error(`Document ${documentId} not found`);
    const { s3_key: tempKey, filename } = rows[0];
    const permanentKey = `kyc/${documentId}/${filename}`;

    // Copy to permanent location (SSE‑S3 stays enabled by default)
    await this.s3Client.send(
      new CopyObjectCommand({
        Bucket: s3Config.bucket,
        CopySource: `${s3Config.bucket}/${tempKey}`,
        Key: permanentKey,
        MetadataDirective: 'COPY',
      }),
    );

    // Delete the temporary object
    await this.s3Client.send(new DeleteObjectCommand({ Bucket: s3Config.bucket, Key: tempKey }));

    // Update DB record
    await this.pool.query(
      `UPDATE kyc_documents SET s3_key = $1, status = 'confirmed' WHERE id = $2`,
      [permanentKey, documentId],
    );

    return this.getS3ObjectUrl(permanentKey);
  }

  /** Generate a short‑lived (5‑min) GET URL for a confirmed document. */
  async generateDownloadUrl(documentId: string): Promise<string> {
    const { rows } = await this.pool.query(
      `SELECT s3_key FROM kyc_documents WHERE id = $1 AND status = 'confirmed'`,
      [documentId],
    );
    if (rows.length === 0) throw new Error(`Confirmed document ${documentId} not found`);
    const { s3_key: key } = rows[0];
    const command = new GetObjectCommand({ Bucket: s3Config.bucket, Key: key });
    return await getSignedUrl(this.s3Client, command, { expiresIn: 5 * 60 });
  }

  private getS3ObjectUrl(key: string): string {
    return `https://${s3Config.bucket}.s3.${s3Config.region}.amazonaws.com/${key}`;
  }
}
