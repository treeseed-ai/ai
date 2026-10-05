import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedArtifactStore } from '../../packages/common/src/storage.js';
import type { StorageAction } from '../../packages/common/src/artifacts/custody.js';

afterEach(() => vi.restoreAllMocks());
const lease = (key: string) => ({ endpoint: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`, bucket: 'test-storage',
	prefix: 'teams/test/allocation/', objectKey: `teams/test/allocation/${key}`, expiresAt: new Date(Date.now()+60_000).toISOString(),
	credentials: { accessKeyId: 'b'.repeat(32), secretAccessKey: 'c'.repeat(64), sessionToken: 'temporary-only' } });

describe('operation-scoped artifact transport', () => {
	it('applies exact object keys and conditional writes without retaining a client', async () => {
		const custody=vi.fn(async (_store:string,_action:StorageAction,key:string)=>lease(key));
		const send=vi.spyOn(S3Client.prototype,'send').mockResolvedValue({} as never);
		const destroy=vi.spyOn(S3Client.prototype,'destroy').mockImplementation(()=>undefined);
		await new ManagedArtifactStore('managed-training',custody).put('objects/item',new Uint8Array([1]));
		expect(custody).toHaveBeenCalledWith('managed-training','write','objects/item');
		expect((send.mock.calls[0]![0] as any).input).toMatchObject({Bucket:'test-storage',Key:'teams/test/allocation/objects/item',IfNoneMatch:'*'});
		expect(destroy).toHaveBeenCalledOnce();
	});
	it('gets fresh read authority when an immutable write already exists', async () => {
		const custody=vi.fn(async (_store:string,_action:StorageAction,key:string)=>lease(key));
		vi.spyOn(S3Client.prototype,'send').mockRejectedValueOnce({$metadata:{httpStatusCode:412}}).mockResolvedValueOnce({ContentLength:1,Metadata:{sha256:'different'}} as never);
		await expect(new ManagedArtifactStore('managed-training',custody).put('objects/item',new Uint8Array([1]))).rejects.toThrow('Immutable');
		expect(custody.mock.calls.map(call=>call[1])).toEqual(['write','read']);
	});
	it('rejects a listing outside its authorized allocation and redacts provider errors', async () => {
		const custody=async (_store:string,_action:StorageAction,key:string)=>lease(key);
		vi.spyOn(S3Client.prototype,'send').mockResolvedValueOnce({Contents:[{Key:'teams/another-team/private'}]} as never)
			.mockRejectedValueOnce(new Error('parent token or upstream secret'));
		const store=new ManagedArtifactStore('managed-training',custody);
		await expect(store.keys()).rejects.toThrow(/^Managed artifact storage operation failed\.$/);
		await expect(store.head('item')).rejects.toThrow(/^Managed artifact storage operation failed\.$/);
	});
	it('refuses to construct an S3 request when custody denies the operation', async () => {
		const send=vi.spyOn(S3Client.prototype,'send');
		await expect(new ManagedArtifactStore('managed-training',async()=>{throw new Error('revoked');}).bytes('item')).rejects.toThrow('revoked');
		expect(send).not.toHaveBeenCalled();
	});
});
