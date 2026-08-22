export type CheckStatus='ready'|'warning'|'blocked'|'unsupported';
export interface Check{ id:string;status:CheckStatus;summary:string;observed?:unknown;repair?:string }
export interface Platform{ id:string;version:string;codename:string;architecture:string;supported:boolean }
export interface PackageRecord{name:string;version:string;origin?:string}
export interface HostInspection{checkedAt:string;platform:Platform;root:boolean;secureBoot:string;pendingReboot:boolean;packages:PackageRecord[];commands:Record<string,string>;dockerDaemon:unknown;diskGiB:number;memoryGiB:number;checks:Check[]}
export interface PackageArtifact{name:string;version:string;architecture:string;filename:string;sha256:string}
export interface PlanAction{id:string;description:string;commands:string[][];mutating:boolean}
export interface HostPlan{schemaVersion:'ai.host-runtime-plan/v1';createdAt:string;compatibilityRelease:string;source:'official-online'|'local-apt';inspection:HostInspection;artifacts:PackageArtifact[];actions:PlanAction[];checks:Check[];blocked:boolean}
export interface ApplyReceipt{schemaVersion:'ai.host-runtime-apply/v1';appliedAt:string;compatibilityRelease:string;plan:HostPlan;artifacts:PackageArtifact[];changed:string[];verification?:VerificationResult}
export interface VerificationResult{schemaVersion:'ai.host-runtime-verification/v1';checkedAt:string;overall:CheckStatus;ok:boolean;checks:Check[]}
export interface MigrationPlan{schemaVersion:'ai.host-runtime-migration-plan/v1';createdAt:string;conflicts:string[];commands:string[][];warnings:string[]}
export interface CompatibilityManifest{schemaVersion:string;release:string;architecture:string;supportedPlatforms:Record<string,{codename:string;dockerSuffix:string}>;repositories:Record<'docker'|'nvidia',{keyUrl:string;fingerprint:string;url:string}>;packages:Record<string,string>;artifacts:Record<string,PackageArtifact[]>;validatedRanges:Record<'docker'|'compose'|'toolkit',{minimum:string;maximumExclusive:string}>;cudaVerificationImage:string;artifactResolution:{source:string;requiredFields:string[]};knownConflicts:string[]}
export interface CommandResult{code:number;stdout:string;stderr:string}
export interface SystemAdapter{exists(path:string):boolean;read(path:string):string;command(file:string,args?:string[]):CommandResult;writeAtomic(path:string,value:string,mode?:number):void;mkdir(path:string,mode?:number):void;copy(source:string,target:string,mode?:number):void;remove(path:string):void;now():string;uid():number}
