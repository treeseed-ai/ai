export const VERSION='0.10.0';
export const descriptorRoot=process.env.TREEAI_DESCRIPTOR_ROOT??'/usr/lib/treeseed-ai/commands.d';
export const configPath=process.env.TREEAI_CONFIG??'/etc/treeseed-ai/treeai/config.json';
export const keyPath=process.env.TREEAI_OPERATOR_KEY??'/etc/treeseed-ai/treeai/operator.key';
export const packageNames={platform:'treeseed-ai-manager',storage:'treeseed-ai-manager',qualify:'treeseed-ai-manager',update:'treeseed-ai-manager',mode:'treeseed-ai-manager',config:'treeseed-ai-manager',recovery:'treeseed-ai-manager','local-build':'treeseed-ai-manager',host:'treeseed-ai-host-runtime',inference:'treeseed-ai-inference',training:'treeseed-ai-training',lab:'treeseed-ai-lab'}as const;
export const executables={platform:'/usr/lib/treeseed-ai/manager/dist/cli.js',storage:'/usr/lib/treeseed-ai/manager/dist/cli.js',qualify:'/usr/lib/treeseed-ai/manager/dist/cli.js',update:'/usr/lib/treeseed-ai/manager/dist/cli.js',mode:'/usr/lib/treeseed-ai/manager/dist/cli.js',config:'/usr/lib/treeseed-ai/manager/dist/cli.js',recovery:'/usr/lib/treeseed-ai/manager/dist/cli.js','local-build':'/usr/lib/treeseed-ai/manager/dist/cli.js',host:'/usr/lib/treeseed-ai/host-runtime/dist/cli.js',inference:'/usr/lib/treeseed-ai/cli/dist/product-cli.js',training:'/usr/lib/treeseed-ai/cli/dist/product-cli.js',lab:'/usr/lib/treeseed-ai/lab/dist/cli.js'}as const;
export type Group=keyof typeof packageNames;
export interface Descriptor{schemaVersion:'treeai.command-descriptor/v2';abi:2;group:Group;package:string;packageRange:string;cliRange:string;apiRange?:string;executable:string;commands:string[]}
export interface ClientConfig{schemaVersion:'treeai.config/v1';version:string;deploymentMode?:'development'|'published';imageSource?:'registry'|'local-build';ca:string;endpoints:Record<string,string>;installedProducts:string[]}
export function envelope(code:string,message:string,details?:unknown){return{error:{code,message,...(details===undefined?{}:{details})}};}
