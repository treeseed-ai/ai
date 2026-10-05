"""Operation-scoped R2 access through TreeSeed; no static provider credentials."""
import base64
import json
import os
import re
import ssl
import time
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import HTTPSHandler, HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Storage custody redirects are prohibited')


def storage_lease(store_id, action, key):
    try:
        from cryptography.hazmat.primitives.serialization import load_pem_private_key
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        service = os.environ['AI_STORAGE_SERVICE']
        if service not in ('inference', 'training', 'lab'):
            raise ValueError()
        endpoint = os.environ['AI_STORAGE_URL']
        url = urlparse(endpoint)
        if (url.scheme != 'https' or url.username or url.password or url.query or url.fragment
                or url.path != '/v1/internal/ai/storage/credentials'):
            raise ValueError()
        proof = dict(schemaVersion='treeseed.ai-storage-proof/v1', teamId=os.environ['AI_TEAM_ID'],
                     projectId=os.environ['AI_PROJECT_ID'], nodeId=os.environ['AI_NODE_ID'], service=service,
                     storeId=store_id, action=action, key=key, issuedAt=int(time.time()), nonce=str(uuid.uuid4()))
        for name in ('teamId', 'projectId', 'nodeId'):
            if str(uuid.UUID(proof[name])) != proof[name]:
                raise ValueError()
        if store_id not in ('managed-inference', 'managed-training', 'managed-lab') or action not in ('read', 'write', 'list', 'delete'):
            raise ValueError()
        if (len(key) > 1024 or re.search(r'[\\\x00-\x1f\x7f%?#]', key)
                or (key and any(part in ('', '.', '..') for part in key.split('/'))) or (not key and action != 'list')):
            raise ValueError()
        private = load_pem_private_key(Path(f'/run/secrets/ai-{service}-storage-identity').read_bytes(), password=None)
        if not isinstance(private, Ed25519PrivateKey):
            raise ValueError()
        message = 'treeseed.ai-storage-proof/v1\n' + json.dumps(proof, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
        signature = base64.urlsafe_b64encode(private.sign(message.encode())).decode().rstrip('=')
        request = Request(endpoint, data=json.dumps(dict(proof=proof, signature=signature)).encode(),
                          headers={'Content-Type': 'application/json'}, method='POST')
        # Uses the manager-installed CA, never disabled TLS verification or ambient proxies.
        from urllib.request import ProxyHandler
        trust = ssl.create_default_context()
        trust.load_verify_locations(cafile='/run/secrets/ai-storage-ca')
        opener = build_opener(ProxyHandler({}), NoRedirect(), HTTPSHandler(context=trust))
        with opener.open(request, timeout=10) as response:
            raw = response.read(16385)
        if len(raw) > 16384:
            raise ValueError()
        body = json.loads(raw)
        if body.get('ok') is not True:
            raise ValueError()
        lease = body['result']
        prefix = f"teams/{proof['teamId']}/projects/{proof['projectId']}/ai/v1/nodes/{proof['nodeId']}/{store_id}/"
        expires = datetime.fromisoformat(lease['expiresAt'].replace('Z', '+00:00')).timestamp()
        if (not re.fullmatch(r'https://[a-f0-9]{32}\.r2\.cloudflarestorage\.com', lease['endpoint'])
                or not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', lease['bucket'])
                or lease['prefix'] != prefix or lease['objectKey'] != prefix + key
                or not time.time() + 1 < expires <= time.time() + 65):
            raise ValueError()
        credentials = lease['credentials']
        if (not re.fullmatch(r'[a-f0-9]{32}', credentials['accessKeyId'])
                or not re.fullmatch(r'[a-f0-9]{64}', credentials['secretAccessKey'])
                or not isinstance(credentials['sessionToken'], str) or not 1 <= len(credentials['sessionToken']) <= 8192):
            raise ValueError()
        return lease
    except Exception:
        raise ValueError('Managed artifact storage access is unavailable') from None


def storage_client(store_id, action, key):
    """Refresh short leases during multipart uploads without changing their allocation."""
    import boto3
    import botocore.session
    from botocore.credentials import RefreshableCredentials
    from botocore.config import Config
    initial = storage_lease(store_id, action, key)

    def metadata(lease):
        if any(lease[field] != initial[field] for field in ('endpoint', 'bucket', 'prefix', 'objectKey')):
            raise ValueError('Storage allocation changed during an operation')
        credentials = lease['credentials']
        return dict(access_key=credentials['accessKeyId'], secret_key=credentials['secretAccessKey'],
                    token=credentials['sessionToken'], expiry_time=lease['expiresAt'])

    session = botocore.session.get_session()
    session._credentials = RefreshableCredentials.create_from_metadata(
        metadata(initial), lambda: metadata(storage_lease(store_id, action, key)), 'treeseed-service-vault',
        advisory_timeout=15, mandatory_timeout=5)
    client = boto3.Session(botocore_session=session).client('s3', endpoint_url=initial['endpoint'], region_name='auto',
        config=Config(retries={'max_attempts': 0}, s3={'addressing_style': 'path'},
                      request_checksum_calculation='when_required', response_checksum_validation='when_required'))
    return client, initial
