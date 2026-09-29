import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomBytes } from 'crypto';

// Mirrors rentcar's lib/spaces-upload.ts exactly — same folder prefix
// (rentcar/<folderSlug>/), same 5MB limit, same allowed types, same public
// URL shape — so files land in the same bucket the web app already reads
// from, with URLs that pass isTrustedSpacesImageUrl() on the rentcar side.
const MAX_BYTES = 5 * 1024 * 1024;

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function folderPrefix(slug: string): string {
  return `rentcar/${slug}/`;
}

@Injectable()
export class SpacesService {
  private isConfigured(): boolean {
    return Boolean(
      process.env.SPACES_REGION &&
        process.env.SPACES_ACCESS_KEY_ID &&
        process.env.SPACES_SECRET_ACCESS_KEY &&
        process.env.SPACES_BUCKET
    );
  }

  private getClient(): S3Client {
    const region = process.env.SPACES_REGION!;
    return new S3Client({
      region,
      endpoint: `https://${region}.digitaloceanspaces.com`,
      credentials: {
        accessKeyId: process.env.SPACES_ACCESS_KEY_ID!,
        secretAccessKey: process.env.SPACES_SECRET_ACCESS_KEY!,
      },
      forcePathStyle: false,
    });
  }

  private publicUrlForKey(key: string): string {
    const region = process.env.SPACES_REGION!;
    const bucket = process.env.SPACES_BUCKET!;
    const explicit = process.env.SPACES_PUBLIC_URL?.trim();
    if (!explicit) return `https://${bucket}.${region}.digitaloceanspaces.com/${key}`;

    try {
      const parsed = new URL(explicit.replace(/\/$/, ''));
      if (parsed.hostname === `${region}.digitaloceanspaces.com`) {
        return `${parsed.origin}/${bucket}/${key}`;
      }
      return `${parsed.origin}/${key}`;
    } catch {
      return `https://${bucket}.${region}.digitaloceanspaces.com/${key}`;
    }
  }

  async uploadImage(
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
    folderSlug: string
  ): Promise<string> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('لم يُضبط تخزين الملفات (Spaces).');
    }
    if (!file || file.size === 0) {
      throw new BadRequestException('اختر ملف صورة صالحاً.');
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException('حجم الصورة يتجاوز 5 ميجابايت.');
    }

    const mime = file.mimetype?.toLowerCase() ?? '';
    const ext = MIME_TO_EXT[mime];
    if (!ext) {
      throw new BadRequestException('نوع الصورة غير مدعوم (JPEG، PNG، WebP، GIF).');
    }

    const safeBase = `${Date.now()}-${randomBytes(8).toString('hex')}`;
    const key = `${folderPrefix(folderSlug)}${safeBase}.${ext}`;
    const bucket = process.env.SPACES_BUCKET!;

    await this.getClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: file.buffer,
        ContentType: mime,
        ACL: 'public-read',
      })
    );

    return this.publicUrlForKey(key);
  }
}
