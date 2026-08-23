type CertificateTransaction={changed:boolean;commit:()=>void;rollback:()=>void};
type Runner=(file:string,args:string[])=>string;

export function activateManagerCertificate(certificate:CertificateTransaction,run:Runner){
	if(!certificate.changed){certificate.commit();return;}
	try{
		run('systemctl',['try-restart','treeseed-ai-manager-api.service']);
		run('curl',['--silent','--show-error','--fail','--cacert','/etc/ssl/certs/treeseed-ai-ca.pem','--resolve','host.docker.internal:4790:127.0.0.1','https://host.docker.internal:4790/healthz']);
		certificate.commit();
	}catch(error){
		certificate.rollback();
		try{run('systemctl',['try-restart','treeseed-ai-manager-api.service']);}catch{}
		throw error;
	}
}
