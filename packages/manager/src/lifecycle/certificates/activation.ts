type CertificateTransaction={changed:boolean;commit:()=>void;rollback:()=>void};
type Runner=(file:string,args:string[])=>string;

export function activateManagerCertificate(certificate:CertificateTransaction,run:Runner){
	const verify=()=>run('curl',['--silent','--show-error','--fail','--cacert','/etc/ssl/certs/treeseed-ai-ca.pem','--resolve','host.docker.internal:4790:127.0.0.1','https://host.docker.internal:4790/healthz']);
	try{
		let ready=false;if(!certificate.changed)try{verify();ready=true;}catch{}
		if(!ready){run('systemctl',['try-restart','treeseed-ai-manager-api.service']);verify();}
		certificate.commit();
	}catch(error){
		certificate.rollback();
		try{run('systemctl',['try-restart','treeseed-ai-manager-api.service']);}catch{}
		throw error;
	}
}
