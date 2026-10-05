import hashlib,os,re,shutil,tempfile
from pathlib import Path
from contextlib import contextmanager
from urllib.parse import urlparse

def safe_key(value):
    value=str(value);parts=value.split('/')
    if not value or value.startswith('/') or any(not part or part in {'.','..'} for part in parts):raise ValueError('Artifact key is invalid')
    return '/'.join(parts)

class ArtifactRepository:
    def __init__(self,store_id,backend='filesystem',root=None):
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,62}',store_id or ''):raise ValueError('Artifact store ID is invalid')
        self.store_id=store_id;self.backend=backend;self.root=Path(root).resolve() if root else None
        if backend=='filesystem':
            if not self.root:raise ValueError('Filesystem artifact root is required')
            self.root.mkdir(parents=True,exist_ok=True)
            if self.root.is_symlink():raise ValueError('Artifact root cannot be a symlink')
        elif backend=='r2':
            if store_id not in ('managed-inference','managed-training','managed-lab'):raise ValueError('Managed storage allocation required')
        else:raise ValueError('Unsupported artifact backend')
    @classmethod
    def from_env(cls):
        return cls(os.getenv('ARTIFACT_STORE_ID','managed-training'),os.getenv('ARTIFACT_BACKEND','filesystem'),os.getenv('ARTIFACT_ROOT','/artifacts'))
    @contextmanager
    def remote(self,action,key):
        from .storage_custody import storage_client
        client,lease=storage_client(self.store_id,action,key)
        try:yield client,lease
        except Exception:raise ValueError('Managed artifact storage operation failed') from None
        finally:client.close()
    def uri(self,key):return f'artifact://{self.store_id}/{safe_key(key)}'
    def key(self,value):
        value=str(value)
        if '://' not in value:return safe_key(value)
        parsed=urlparse(value)
        if parsed.scheme=='artifact' and parsed.netloc==self.store_id:return safe_key(parsed.path.lstrip('/'))
        raise ValueError('Artifact URI is not accepted by this store')
    def path(self,key):
        unresolved=self.root/safe_key(key)
        current=self.root
        for part in unresolved.relative_to(self.root).parts:
            current=current/part
            if current.exists() and current.is_symlink():raise ValueError('Artifact path contains an unsafe component')
        target=unresolved.resolve()
        if target!=self.root and self.root not in target.parents:raise ValueError('Artifact path escapes its store')
        return target
    def bytes(self,value):
        key=self.key(value)
        if self.backend=='r2':
            with self.remote('read',key) as (client,lease):
                response=client.get_object(Bucket=lease['bucket'],Key=lease['objectKey'])
                with response['Body'] as body:return body.read()
        target=self.path(key)
        if target.is_symlink() or not target.is_file():raise ValueError('Artifact is not a regular file')
        return target.read_bytes()
    def head(self,value):
        key=self.key(value)
        if self.backend=='r2':
            with self.remote('read',key) as (client,lease):
                result=client.head_object(Bucket=lease['bucket'],Key=lease['objectKey'])
            checksum=result.get('Metadata',{}).get('sha256')
            if not checksum:raise ValueError('Remote artifact has no SHA-256 metadata')
            return {'uri':self.uri(key),'key':key,'size':result.get('ContentLength',0),'sha256':checksum}
        target=self.path(key)
        if target.is_symlink() or not target.is_file():raise ValueError('Artifact is not a regular file')
        checksum=hashlib.sha256()
        with target.open('rb') as source:
            for chunk in iter(lambda:source.read(1024*1024),b''):checksum.update(chunk)
        return {'uri':self.uri(key),'key':key,'size':target.stat().st_size,'sha256':checksum.hexdigest()}
    def put_bytes(self,key,data,content_type='application/octet-stream'):
        key=safe_key(key);data=bytes(data);checksum=hashlib.sha256(data).hexdigest()
        if self.backend=='r2':
            with self.remote('write',key) as (client,lease):
                from botocore.exceptions import ClientError
                try:client.put_object(Bucket=lease['bucket'],Key=lease['objectKey'],Body=data,ContentType=content_type,Metadata={'sha256':checksum},IfNoneMatch='*')
                except ClientError as error:
                    if error.response.get('ResponseMetadata',{}).get('HTTPStatusCode')!=412:raise
                    current=self.head(key)
                    if current['sha256']!=checksum or current['size']!=len(data):raise ValueError('Immutable artifact already exists with different content')
        else:
            target=self.path(key);target.parent.mkdir(parents=True,exist_ok=True)
            if target.exists():
                if target.is_symlink() or hashlib.sha256(target.read_bytes()).hexdigest()!=checksum:raise ValueError('Immutable artifact already exists with different content')
            else:
                descriptor,temporary=tempfile.mkstemp(prefix='.treeai-',dir=target.parent)
                try:
                    with os.fdopen(descriptor,'wb') as output:output.write(data)
                    os.chmod(temporary,0o640);os.replace(temporary,target)
                finally:
                    if os.path.exists(temporary):os.unlink(temporary)
        return {'uri':self.uri(key),'key':key,'size':len(data),'sha256':checksum}
    def put_file(self,key,path,content_type='application/octet-stream'):
        path=Path(path)
        if path.is_symlink() or not path.is_file():raise ValueError('Artifact source is not a regular file')
        key=safe_key(key);size=path.stat().st_size
        checksum=hashlib.sha256()
        with path.open('rb') as source:
            for chunk in iter(lambda:source.read(1024*1024),b''):checksum.update(chunk)
        checksum=checksum.hexdigest()
        if self.backend=='r2':
            if size>5_000_000_000:raise ValueError('Artifact exceeds the supported single-object upload size')
            with self.remote('write',key) as (client,lease):
                from botocore.exceptions import ClientError
                try:
                    with path.open('rb') as source:client.put_object(Bucket=lease['bucket'],Key=lease['objectKey'],Body=source,ContentLength=size,ContentType=content_type,Metadata={'sha256':checksum},IfNoneMatch='*')
                except ClientError as error:
                    if error.response.get('ResponseMetadata',{}).get('HTTPStatusCode')!=412:raise
                    current=self.head(key)
                    if current['sha256']!=checksum or current['size']!=size:raise ValueError('Immutable artifact already exists with different content')
        else:
            target=self.path(key);target.parent.mkdir(parents=True,exist_ok=True)
            if target.exists():
                current=hashlib.sha256()
                with target.open('rb') as source:
                    for chunk in iter(lambda:source.read(1024*1024),b''):current.update(chunk)
                if target.is_symlink() or current.hexdigest()!=checksum or target.stat().st_size!=size:raise ValueError('Immutable artifact already exists with different content')
                return {'uri':self.uri(key),'key':key,'size':size,'sha256':checksum}
            descriptor,temporary=tempfile.mkstemp(prefix='.treeai-',dir=target.parent);os.close(descriptor)
            try:
                shutil.copyfile(path,temporary);os.chmod(temporary,0o640);os.replace(temporary,target)
            finally:
                if os.path.exists(temporary):os.unlink(temporary)
        return {'uri':self.uri(key),'key':key,'size':size,'sha256':checksum}
    def list(self,prefix=''):
        if self.backend=='r2':
            keys=[]
            with self.remote('list',prefix.rstrip('/')) as (client,lease):
                for page in client.get_paginator('list_objects_v2').paginate(Bucket=lease['bucket'],Prefix=lease['objectKey']):
                    for item in page.get('Contents',[]):
                        if not item['Key'].startswith(lease['objectKey']):raise ValueError('Artifact listing escaped its allocation')
                        keys.append(item['Key'][len(lease['prefix']):])
                    if len(keys)>100000:raise ValueError('Artifact listing exceeds its bounded page size')
            return [self.head(key) for key in sorted(keys)]
        values=[]
        for item in sorted(self.root.rglob('*')):
            if item.is_symlink():raise ValueError('Artifact store contains a symlink')
            if item.is_file() and str(item.relative_to(self.root)).startswith(prefix):values.append(self.head(str(item.relative_to(self.root))))
        return values
