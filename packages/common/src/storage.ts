import { GetObjectCommand,HeadObjectCommand,PutObjectCommand,S3Client,type S3ClientConfig } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';

export class ArtifactStore {
	readonly client: S3Client;
	constructor(readonly bucket: string, options: S3ClientConfig) { this.client = new S3Client(options); }
	async put(key: string, body: Uint8Array, contentType = 'application/octet-stream') {
		const digest = createHash('sha256').update(body).digest('hex');
		await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, Metadata: { sha256: digest } }));
		return { uri: `s3://${this.bucket}/${key}`, size: body.byteLength, sha256: digest };
	}
	async head(key: string) { return this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })); }
	async bytes(key: string) {
		const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
		return result.Body?.transformToByteArray() ?? new Uint8Array();
	}
}
